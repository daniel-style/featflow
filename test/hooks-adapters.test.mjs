import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../src/config.mjs";

const CLI = path.join(packageRoot, "bin", "featflow.mjs");
const emptyGitConfig = process.platform === "win32" ? "NUL" : "/dev/null";

function run(command, args, cwd, extra = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input: extra.input,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyGitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      ...(extra.env ?? {}),
    },
  });
}

function runHook(adapter, event, payload, cwd, env = {}) {
  return run(process.execPath, [CLI, "hook", adapter, event], cwd, {
    input: JSON.stringify(payload),
    env,
  });
}

function createHookRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "featflow-hooks-"));
  run("git", ["init", "-b", "main"], dir);
  run("git", ["config", "user.name", "Alice"], dir);
  run("git", ["config", "user.email", "alice@example.test"], dir);
  writeFileSync(path.join(dir, "README.md"), "# hook test\n");
  writeFileSync(
    path.join(dir, ".featflow.json"),
    JSON.stringify({
      mode: "trunk",
      protectedBranches: ["main"],
      productPaths: ["src/"],
      verifyCommands: { "src/": "npm test" },
      dangerousCommands: {
        blockDestructiveGit: true,
        blockForcePush: true,
        blockEnvWrite: true,
        blockedPackageManagers: ["yarn"],
      },
    }),
  );
  run("git", ["add", "."], dir);
  run("git", ["commit", "-m", "initial"], dir);
  return dir;
}

describe("Codex and Claude Code hook adapters", () => {
  it("blocks edits on protected branch and allows them on a task branch", () => {
    const repo = createHookRepo();
    try {
      // On main (protected): Claude Code Edit is blocked
      const blockedOnMain = runHook(
        "claude-code",
        "pre-tool-use",
        {
          tool_name: "Edit",
          tool_input: { file_path: path.join(repo, "src/app.mjs") },
        },
        repo,
      );
      assert.equal(blockedOnMain.status, 2);
      assert.match(blockedOnMain.stderr, /protected branch "main"/);

      // Switch to a task branch: allowed when no active feature record exists
      run("git", ["checkout", "-b", "feat/demo"], repo);
      const allowedOnTask = runHook(
        "claude-code",
        "pre-tool-use",
        {
          tool_name: "Edit",
          tool_input: { file_path: path.join(repo, "src/app.mjs") },
        },
        repo,
      );
      assert.equal(allowedOnTask.status, 0);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("blocks product edits when active feature plan is incomplete, while allowing read-only shell commands", () => {
    const repo = createHookRepo();
    try {
      run("git", ["checkout", "-b", "feat/incomplete"], repo);
      mkdirSync(path.join(repo, "features", "active"), { recursive: true });
      const rawTemplate = readFileSync(path.join(packageRoot, "templates", "features", "_template.md"), "utf8");
      writeFileSync(path.join(repo, "features", "active", "2026-06-15-1000-incomplete.md"), rawTemplate);

      // Read-only command referencing src/ MUST be allowed (fixes false positive!)
      const readOnlyRes = runHook(
        "codex",
        "pre-tool-use",
        {
          tool_name: "Bash",
          tool_input: { cmd: "rg foo src/" },
        },
        repo,
      );
      assert.equal(readOnlyRes.status, 0, `Read-only command was wrongly blocked: ${readOnlyRes.stderr}`);

      // Codex apply_patch touching src/ MUST be blocked
      const codexPatchBlocked = runHook(
        "codex",
        "pre-tool-use",
        {
          tool_name: "apply_patch",
          tool_input: {
            input: "*** Begin Patch\n*** Update File: src/app.mjs\n@@\n-a\n+b\n*** End Patch",
          },
        },
        repo,
      );
      assert.equal(codexPatchBlocked.status, 2);
      assert.match(codexPatchBlocked.stderr, /active feature plan.*is incomplete/i);

      // Editing the feature record itself MUST be allowed so AI can finish filling the plan!
      const editFeatureAllowed = runHook(
        "claude-code",
        "pre-tool-use",
        {
          tool_name: "Edit",
          tool_input: { file_path: "features/active/2026-06-15-1000-incomplete.md" },
        },
        repo,
      );
      assert.equal(editFeatureAllowed.status, 0);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("blocks destructive git commands and disallowed package managers", () => {
    const repo = createHookRepo();
    try {
      run("git", ["checkout", "-b", "feat/safety"], repo);

      const resetHard = runHook(
        "codex",
        "pre-tool-use",
        { tool_name: "Bash", tool_input: { cmd: "git reset --hard HEAD" } },
        repo,
      );
      assert.equal(resetHard.status, 2);
      assert.match(resetHard.stderr, /Destructive Git cleanup/);

      const blockedPm = runHook(
        "claude-code",
        "pre-tool-use",
        { tool_name: "Bash", tool_input: { command: "yarn add lodash" } },
        repo,
      );
      assert.equal(blockedPm.status, 2);
      assert.match(blockedPm.stderr, /Package manager "yarn" is disallowed/);
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("emits workflow routing context on UserPromptSubmit and deduplicates Stop gate per diff", () => {
    const repo = createHookRepo();
    try {
      const promptRes = runHook(
        "claude-code",
        "user-prompt",
        { prompt: "帮我规划一个新功能并重构 src/" },
        repo,
      );
      assert.equal(promptRes.status, 0);
      const parsed = JSON.parse(promptRes.stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      assert.match(parsed.hookSpecificOutput.additionalContext, /featflow worktree/);

      const stateDir = mkdtempSync(path.join(tmpdir(), "featflow-state-"));
      try {
        const env = {
          FEATFLOW_HOOK_STATE_DIR: stateDir,
          FEATFLOW_TEST_CHANGED_FILES: "src/app.mjs",
        };
        const first = runHook("codex", "stop", {}, repo, env);
        const second = runHook("codex", "stop", {}, repo, env);
        assert.equal(first.status, 2);
        assert.match(first.stderr, /npm test/);
        assert.equal(second.status, 0);
      } finally {
        rmSync(stateDir, { force: true, recursive: true });
      }
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });
});
