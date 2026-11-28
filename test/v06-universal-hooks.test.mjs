import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../src/config.mjs";
import { parseMultiSelectInput, parseSingleSelectInput } from "../src/tui-select.mjs";

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

function mustRun(command, args, cwd, extra = {}) {
  const res = run(command, args, cwd, extra);
  assert.equal(
    res.status,
    0,
    `${command} ${args.join(" ")} failed:\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
  return res.stdout.trim();
}

function makeLines(count) {
  return `${Array.from({ length: count }, (_, idx) => `export const v${idx} = ${idx};`).join("\n")}\n`;
}

function createRepo(name) {
  const parent = mkdtempSync(path.join(tmpdir(), `featflow-v06-${name}-`));
  const repo = path.join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  mustRun("git", ["init", "-b", "main"], repo);
  mustRun("git", ["config", "user.name", "Alice"], repo);
  mustRun("git", ["config", "user.email", "alice@example.test"], repo);
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  mustRun("git", ["add", "."], repo);
  mustRun("git", ["commit", "-m", "initial"], repo);
  return { parent, repo };
}

describe("featflow v0.6 universal hooks, pre-commit size guard, preset full, --merge, and TUI multi-select", () => {
  it("runs Antigravity hook adapter (PreInvocation dedupe, PreToolUse deny/allow with .agents cwd, Stop size check & continuationActive)", () => {
    const fixture = createRepo("antigravity");
    const stateDir = mkdtempSync(path.join(tmpdir(), "featflow-agy-state-"));
    try {
      const { repo } = fixture;
      mkdirSync(path.join(repo, ".agents"), { recursive: true });
      mkdirSync(path.join(repo, "src"), { recursive: true });
      writeFileSync(
        path.join(repo, ".featflow.json"),
        JSON.stringify({
          mode: "trunk",
          protectedBranches: ["main"],
          productPaths: ["src/"],
          verifyCommands: { "src/": "npm test" },
          fileSizeBudget: {
            production: 10,
            style: 12,
            test: 15,
            extensions: [".ts"],
            baselineFile: null,
            enforceInPostToolUse: true,
            enforceInStopGate: true,
            enforceInPreCommit: true,
          },
          regression: { ledgerFile: "context/regression-ledger.yml" },
        }),
      );
      mustRun("git", ["add", "."], repo);
      mustRun("git", ["commit", "-m", "add config"], repo);

      const env = { FEATFLOW_HOOK_STATE_DIR: stateDir };
      // Simulate Antigravity launching hook with process cwd = .agents/, while stdin carries real workspace cwd
      const agentsDir = path.join(repo, ".agents");

      // 1. PreInvocation injects systemMessage once, then dedupes same lastUserInput
      const preInv1 = run(process.execPath, [CLI, "hook", "antigravity", "pre-invocation"], agentsDir, {
        input: JSON.stringify({
          conversationId: "conv-1",
          cwd: repo,
          lastUserInput: "帮我修一下这个 bug 并重构 src/",
        }),
        env,
      });
      assert.equal(preInv1.status, 0, preInv1.stderr);
      const preInvJson1 = JSON.parse(preInv1.stdout);
      assert.equal(preInvJson1.injectSteps.length, 1);
      assert.match(preInvJson1.injectSteps[0].systemMessage.systemMessage, /featflow regression impact/);

      const preInv2 = run(process.execPath, [CLI, "hook", "antigravity", "pre-invocation"], agentsDir, {
        input: JSON.stringify({
          conversationId: "conv-1",
          cwd: repo,
          lastUserInput: "帮我修一下这个 bug 并重构 src/",
        }),
        env,
      });
      assert.equal(preInv2.status, 0);
      assert.deepEqual(JSON.parse(preInv2.stdout), {});

      // 2. PreToolUse denies edit_file on protected branch main
      const denyRes = run(process.execPath, [CLI, "hook", "antigravity", "pre-tool-use"], agentsDir, {
        input: JSON.stringify({
          cwd: repo,
          toolCall: { name: "edit_file", args: { Path: path.join(repo, "src", "app.ts") } },
        }),
        env,
      });
      assert.equal(denyRes.status, 0);
      const denyJson = JSON.parse(denyRes.stdout);
      assert.equal(denyJson.decision, "deny");
      assert.match(denyJson.reason, /protected branch "main"/);

      // 3. Switch to task branch -> PreToolUse allows edit_file and denies destructive run_command
      mustRun("git", ["checkout", "-b", "feat/agy-test"], repo);
      const allowRes = run(process.execPath, [CLI, "hook", "antigravity", "pre-tool-use"], agentsDir, {
        input: JSON.stringify({
          workspacePaths: [repo],
          toolCall: { name: "edit_file", args: { Path: path.join(repo, "src", "app.ts") } },
        }),
        env,
      });
      assert.equal(allowRes.status, 0);
      assert.deepEqual(JSON.parse(allowRes.stdout), { decision: "allow" });

      const dangerRes = run(process.execPath, [CLI, "hook", "antigravity", "pre-tool-use"], agentsDir, {
        input: JSON.stringify({
          cwd: repo,
          toolCall: { name: "run_command", args: { CommandLine: "git reset --hard HEAD" } },
        }),
        env,
      });
      assert.equal(JSON.parse(dangerRes.stdout).decision, "deny");

      // 4. Oversized file causes Stop hook to return decision: "continue" (and continuationActive: true exits cleanly)
      writeFileSync(path.join(repo, "src", "big.ts"), makeLines(15));
      const postRes = run(process.execPath, [CLI, "hook", "antigravity", "post-tool-use"], agentsDir, {
        input: JSON.stringify({ cwd: repo, toolCall: { name: "write_file", args: { Path: "src/big.ts" } } }),
        env,
      });
      assert.deepEqual(JSON.parse(postRes.stdout), {});

      const stopSizeBlock = run(process.execPath, [CLI, "hook", "antigravity", "stop"], agentsDir, {
        input: JSON.stringify({ cwd: repo, continuationActive: false }),
        env,
      });
      const stopSizeJson = JSON.parse(stopSizeBlock.stdout);
      assert.equal(stopSizeJson.decision, "continue");
      assert.match(stopSizeJson.reason, /size budget failed/);
      assert.match(stopSizeJson.reason, /src\/big\.ts: 15 lines/);

      const stopCont = run(process.execPath, [CLI, "hook", "antigravity", "stop"], agentsDir, {
        input: JSON.stringify({ cwd: repo, continuationActive: true }),
        env,
      });
      assert.deepEqual(JSON.parse(stopCont.stdout), {});
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("runs Cursor hook adapter and enforces Git pre-commit file-size budget fallback", () => {
    const fixture = createRepo("cursor-precommit");
    const stateDir = mkdtempSync(path.join(tmpdir(), "featflow-cursor-state-"));
    try {
      const { repo } = fixture;
      mkdirSync(path.join(repo, "src"), { recursive: true });
      writeFileSync(
        path.join(repo, ".featflow.json"),
        JSON.stringify({
          mode: "trunk",
          protectedBranches: ["main"],
          productPaths: ["src/"],
          verifyCommands: { "src/": "npm test" },
          fileSizeBudget: {
            production: 8,
            style: 10,
            test: 12,
            extensions: [".ts"],
            baselineFile: null,
            enforceInPostToolUse: true,
            enforceInStopGate: true,
            enforceInPreCommit: true,
          },
        }),
      );
      mustRun("git", ["add", "."], repo);
      mustRun("git", ["commit", "-m", "config"], repo);

      const env = { FEATFLOW_HOOK_STATE_DIR: stateDir };

      // Cursor beforeSubmitPrompt returns { continue: true }
      const beforeRes = run(process.execPath, [CLI, "hook", "cursor", "before-submit-prompt"], repo, {
        input: JSON.stringify({ prompt: "hello" }),
        env,
      });
      assert.deepEqual(JSON.parse(beforeRes.stdout), { continue: true });

      // Cursor preToolUse denies Write on main
      const denyRes = run(process.execPath, [CLI, "hook", "cursor", "pre-tool-use"], repo, {
        input: JSON.stringify({ tool_name: "Write", file_path: "src/app.ts" }),
        env,
      });
      const denyJson = JSON.parse(denyRes.stdout);
      assert.equal(denyJson.permission, "deny");
      assert.match(denyJson.agent_message, /protected branch "main"/);

      // Switch to task branch -> allow Write, oversized file triggers postToolUse additional_context & stop followup_message
      mustRun("git", ["checkout", "-b", "feat/cursor-test"], repo);
      const allowRes = run(process.execPath, [CLI, "hook", "cursor", "pre-tool-use"], repo, {
        input: JSON.stringify({ tool_name: "StrReplace", tool_input: { file_path: "src/app.ts" } }),
        env,
      });
      assert.deepEqual(JSON.parse(allowRes.stdout), { permission: "allow" });

      writeFileSync(path.join(repo, "src", "big.ts"), makeLines(12));
      const postRes = run(process.execPath, [CLI, "hook", "cursor", "post-tool-use"], repo, {
        input: JSON.stringify({ tool_name: "Write", file_path: "src/big.ts" }),
        env,
      });
      const postJson = JSON.parse(postRes.stdout);
      assert.match(postJson.additional_context, /size budget failed/);

      const stopRes = run(process.execPath, [CLI, "hook", "cursor", "stop"], repo, {
        input: JSON.stringify({ status: "completed" }),
        env,
      });
      const stopJson = JSON.parse(stopRes.stdout);
      assert.match(stopJson.followup_message, /npm test/);

      // Universal Git pre-commit guard blocks oversized staged file (and FEATFLOW_SKIP_SIZE_CHECK=1 allows bypass)
      mustRun("git", ["add", "src/big.ts"], repo);
      const preCommitBlock = run(process.execPath, [CLI, "policy", "pre-commit"], repo);
      assert.equal(preCommitBlock.status, 1);
      assert.match(preCommitBlock.stderr, /exceed configured fileSizeBudget/);

      const preCommitBypass = run(process.execPath, [CLI, "policy", "pre-commit"], repo, {
        env: { FEATFLOW_SKIP_SIZE_CHECK: "1" },
      });
      assert.equal(preCommitBypass.status, 0);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("supports one-command --preset full, non-destructive --merge with auto-baseline, and interactive multi-select", () => {
    // 1. Unit check parseSingleSelectInput & parseMultiSelectInput
    const modeChoices = [
      { id: "trunk", label: "trunk", aliases: ["t"] },
      { id: "developer-branch", label: "developer-branch", aliases: ["dev", "d"] },
    ];
    assert.equal(parseSingleSelectInput("", modeChoices, "trunk"), "trunk");
    assert.equal(parseSingleSelectInput("2", modeChoices, "trunk"), "developer-branch");
    assert.equal(parseSingleSelectInput("dev", modeChoices, "trunk"), "developer-branch");
    assert.equal(parseSingleSelectInput("developer-branch", modeChoices, "trunk"), "developer-branch");

    const choices = [
      { id: "antigravity", label: "Antigravity", checked: false },
      { id: "claude-code", label: "Claude Code", checked: true },
      { id: "codex", label: "Codex", checked: false },
      { id: "cursor", label: "Cursor", checked: false },
    ];
    assert.deepEqual(parseMultiSelectInput("", choices), ["claude-code"]);
    assert.deepEqual(parseMultiSelectInput("all", choices), ["antigravity", "claude-code", "codex", "cursor"]);
    assert.deepEqual(parseMultiSelectInput("none", choices), []);
    assert.deepEqual(parseMultiSelectInput("1,4", choices), ["antigravity", "cursor"]);

    // 2. Fresh repo: featflow init --preset full --yes
    const fullFixture = createRepo("preset-full");
    try {
      const { repo } = fullFixture;
      mkdirSync(path.join(repo, "src"), { recursive: true });
      writeFileSync(path.join(repo, "src", "legacy-big.ts"), makeLines(620));
      mustRun("git", ["add", "."], repo);
      mustRun("git", ["commit", "-m", "legacy"], repo);

      const res = run(process.execPath, [CLI, "init", "--preset", "full", "--yes"], repo);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(existsSync(path.join(repo, ".agents", "hooks.json")), true);
      assert.equal(existsSync(path.join(repo, ".claude", "settings.json")), true);
      assert.equal(existsSync(path.join(repo, ".codex", "config.toml")), true);
      assert.equal(existsSync(path.join(repo, ".cursor", "hooks.json")), true);
      assert.equal(existsSync(path.join(repo, ".codex", "agents", "codebase-locator.toml")), true);
      assert.equal(existsSync(path.join(repo, ".agents", "skills", "featflow", "SKILL.md")), true);
      assert.equal(existsSync(path.join(repo, ".agents", "skills", "featflow-issues", "SKILL.md")), true);
      assert.equal(existsSync(path.join(repo, ".agents", "skills", "featflow-regression", "SKILL.md")), true);
      assert.equal(existsSync(path.join(repo, "context", "regression-ledger.yml")), true);
      assert.equal(existsSync(path.join(repo, ".featflow-size-baseline.json")), true);
      assert.equal(existsSync(path.join(repo, ".githooks", "pre-commit")), true);

      // Generated starter ledger validates cleanly and auto-baseline makes size-check pass immediately!
      mustRun(process.execPath, [CLI, "size-check"], repo);
      mustRun(process.execPath, [CLI, "regression", "validate", "--strict"], repo);
      mustRun(process.execPath, [CLI, "sync", "--check"], repo);
      const docOut = mustRun(process.execPath, [CLI, "doctor"], repo);
      assert.match(docOut, /\[PASS\] AI Agent hooks: antigravity, claude-code, codex, cursor/);
    } finally {
      rmSync(fullFixture.parent, { force: true, recursive: true });
    }

    // 3. Existing repo non-destructive --merge preserves custom .featflow.json, custom AGENTS.md, and existing hooks
    const mergeFixture = createRepo("merge-upgrade");
    try {
      const { repo } = mergeFixture;
      mkdirSync(path.join(repo, ".agents"), { recursive: true });
      mkdirSync(path.join(repo, ".cursor"), { recursive: true });
      writeFileSync(path.join(repo, "AGENTS.md"), "# Handcrafted Project Rules\n");
      writeFileSync(
        path.join(repo, ".featflow.json"),
        JSON.stringify(
          {
            mode: "developer-branch",
            developerBranchConfigKey: "custom.devBranch",
            verifyCommands: { "src/": "pnpm test:unit" },
            issues: { provider: "github", assetsRepo: "Org/custom-assets" },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(repo, ".agents", "hooks.json"),
        JSON.stringify({ myCustomGroup: { Stop: [{ type: "command", command: "echo hi" }] } }, null, 2),
      );
      writeFileSync(
        path.join(repo, ".cursor", "hooks.json"),
        JSON.stringify({ version: 1, hooks: { stop: [{ command: "echo cursor-custom" }] } }, null, 2),
      );

      const mergeRes = run(
        process.execPath,
        [CLI, "init", "--merge", "--agent-hooks", "antigravity,cursor", "--with-regression", "--yes"],
        repo,
      );
      assert.equal(mergeRes.status, 0, mergeRes.stderr);

      const mergedCfg = JSON.parse(readFileSync(path.join(repo, ".featflow.json"), "utf8"));
      assert.equal(mergedCfg.developerBranchConfigKey, "custom.devBranch");
      assert.equal(mergedCfg.issues.assetsRepo, "Org/custom-assets");
      assert.equal(mergedCfg.regression.ledgerFile, "context/regression-ledger.yml");
      assert.equal(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), "# Handcrafted Project Rules\n");
      assert.equal(existsSync(path.join(repo, ".codex", "config.toml")), false);
      assert.equal(existsSync(path.join(repo, ".claude", "settings.json")), false);

      const agyHooks = JSON.parse(readFileSync(path.join(repo, ".agents", "hooks.json"), "utf8"));
      assert.ok(agyHooks.myCustomGroup);
      assert.ok(agyHooks.featflow.PreToolUse);

      const cursorHooks = JSON.parse(readFileSync(path.join(repo, ".cursor", "hooks.json"), "utf8"));
      assert.equal(cursorHooks.hooks.stop.length, 2);
      assert.equal(cursorHooks.hooks.stop[0].command, "echo cursor-custom");
      assert.equal(cursorHooks.hooks.stop[1].command, "featflow hook cursor stop");
    } finally {
      rmSync(mergeFixture.parent, { force: true, recursive: true });
    }

    // 4. Interactive multi-select via FEATFLOW_FORCE_TTY=1 selects exact capabilities & agent hooks
    const ttyFixture = createRepo("tty-multiselect");
    try {
      const { repo } = ttyFixture;
      // Prompts for full trunk repo (no remote):
      // 1. profile -> Enter (full)
      // 2. branch mode -> Enter (trunk)
      // 3. trunk finish target -> Enter (merge)
      // 4. git hooks -> none
      // 5. workflow capabilities multi-select -> "1,2" (size-budget + regression)
      // 6. coding agent hooks multi-select -> "1,4" (antigravity + cursor)
      const ttyRes = run(process.execPath, [CLI, "init"], repo, {
        env: { FEATFLOW_FORCE_TTY: "1" },
        input: "\n\n\nnone\n1,2\n1,4\n",
      });
      assert.equal(ttyRes.status, 0, ttyRes.stderr);
      assert.match(ttyRes.stdout, /Workflow guardrails & modules:/);
      assert.match(ttyRes.stdout, /AI Coding Agent Hooks:/);

      const cfg = JSON.parse(readFileSync(path.join(repo, ".featflow.json"), "utf8"));
      assert.ok(cfg.fileSizeBudget);
      assert.ok(cfg.regression);
      assert.equal(cfg.issues, undefined);
      assert.equal(existsSync(path.join(repo, ".agents", "hooks.json")), true);
      assert.equal(existsSync(path.join(repo, ".cursor", "hooks.json")), true);
      assert.equal(existsSync(path.join(repo, ".claude", "settings.json")), false);
      assert.equal(existsSync(path.join(repo, ".codex", "config.toml")), false);
    } finally {
      rmSync(ttyFixture.parent, { force: true, recursive: true });
    }

    // 5. Interactive single-select by number picks developer-branch without typing full branch mode name
    const numSelectFixture = createRepo("tty-single-select");
    try {
      const { repo } = numSelectFixture;
      // 1. Setup profile -> "1" (full)
      // 2. Branch mode -> "2" (developer-branch)
      // 3. Git hooks -> "2" (local)
      // 4. Workflow capabilities -> "1" (size-budget)
      // 5. AI Coding Agent Hooks -> "1" (antigravity)
      // 6. Set up personal developer branch now? -> "2" (No)
      const res = run(process.execPath, [CLI, "init"], repo, {
        env: { FEATFLOW_FORCE_TTY: "1" },
        input: "1\n2\n2\n1\n1\n2\n",
      });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Setup profile:/);
      assert.match(res.stdout, /Branch mode:/);
      assert.match(res.stdout, /Git hooks:/);
      const cfg = JSON.parse(readFileSync(path.join(repo, ".featflow.json"), "utf8"));
      assert.equal(cfg.mode, "developer-branch");
      assert.ok(cfg.fileSizeBudget);
      assert.equal(existsSync(path.join(repo, ".agents", "hooks.json")), true);
      assert.equal(existsSync(path.join(repo, ".git", "hooks", "pre-commit")), true);
    } finally {
      rmSync(numSelectFixture.parent, { force: true, recursive: true });
    }

    // 6. Default full interactive init pre-checks all 4 workflow guardrails & modules on Enter
    const defaultCapsFixture = createRepo("tty-default-all-caps");
    try {
      const { repo } = defaultCapsFixture;
      // 1. profile -> Enter (full)
      // 2. mode -> Enter (trunk)
      // 3. finish target -> Enter (merge)
      // 4. git hooks -> none
      // 5. workflow guardrails -> Enter (all 4 pre-checked!)
      // 6. issues assetsRepo -> Enter (skip)
      // 7. AI coding agent hooks -> Enter (none)
      const res = run(process.execPath, [CLI, "init"], repo, {
        env: { FEATFLOW_FORCE_TTY: "1" },
        input: "\n\n\nnone\n\n\n\n",
      });
      assert.equal(res.status, 0, res.stderr);
      const cfg = JSON.parse(readFileSync(path.join(repo, ".featflow.json"), "utf8"));
      assert.ok(cfg.fileSizeBudget);
      assert.ok(cfg.regression);
      assert.ok(cfg.issues);
      assert.equal(existsSync(path.join(repo, ".codex", "agents", "codebase-locator.toml")), true);
      assert.equal(existsSync(path.join(repo, "context", "regression-ledger.yml")), true);
    } finally {
      rmSync(defaultCapsFixture.parent, { force: true, recursive: true });
    }
  });
});
