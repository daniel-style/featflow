import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { matchesPattern } from "../src/changed-files.mjs";
import { packageRoot } from "../src/config.mjs";
import { parseRegressionLedgerYaml } from "../src/regression.mjs";

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
  assert.equal(res.status, 0, `${command} ${args.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
}

function makeLines(count, prefix = "export const line") {
  return `${Array.from({ length: count }, (_, idx) => `${prefix}${idx} = ${idx};`).join("\n")}\n`;
}

function createRepo(name, branch = "main") {
  const parent = mkdtempSync(path.join(tmpdir(), `featflow-v05-${name}-`));
  const repo = path.join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  mustRun("git", ["init", "-b", branch], repo);
  mustRun("git", ["config", "user.name", "Alice"], repo);
  mustRun("git", ["config", "user.email", "alice@example.test"], repo);
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  mustRun("git", ["add", "."], repo);
  mustRun("git", ["commit", "-m", "initial"], repo);
  return { parent, repo };
}

describe("featflow v0.5 guards: changed-files, size-check, hooks, regression, verify, codegraph", () => {
  it("matches glob patterns and enforces fileSizeBudget with legacy baseline ratchet and post-tool-use hook", () => {
    assert.equal(matchesPattern("packages/proto/generated/a.py", "packages/proto/**/generated/**"), true);
    assert.equal(matchesPattern("services/api/organization_connector_service.py", "services/api/organization_connector_*service.py"), true);
    assert.equal(matchesPattern("services/api/other.py", "services/api/organization_connector_*service.py"), false);

    const fixture = createRepo("size", "alice");
    try {
      const { repo } = fixture;
      mustRun("git", ["config", "featflow.developerBranch", "alice"], repo);
      writeFileSync(
        path.join(repo, ".featflow.json"),
        JSON.stringify(
          {
            mode: "developer-branch",
            baseBranch: "dev",
            protectedBranches: ["main", "dev"],
            developerBranchConfigKey: "featflow.developerBranch",
            fileSizeBudget: {
              production: 10,
              style: 12,
              test: 15,
              extensions: [".ts", ".css"],
              ignore: ["src/**/generated/**"],
              baselineFile: ".featflow-size-baseline.json",
              enforceInPostToolUse: true,
              enforceInStopGate: true,
            },
            dangerousCommands: {
              blockedCommands: [{ pattern: "python3?\\s+-m\\s+venv", reason: "Use uv instead of venv." }],
            },
          },
          null,
          2,
        ),
      );
      mkdirSync(path.join(repo, "src", "generated"), { recursive: true });
      writeFileSync(path.join(repo, "src", "legacy.ts"), makeLines(14));
      writeFileSync(path.join(repo, "src", "generated", "big.ts"), makeLines(30));
      mustRun("git", ["add", "."], repo);
      mustRun("git", ["commit", "-m", "seed legacy"], repo);

      // Fails before baseline because legacy.ts is 14 > 10 (generated/big.ts is ignored)
      const beforeBaseline = run(process.execPath, [CLI, "size-check", "--json"], repo);
      assert.equal(beforeBaseline.status, 1);
      const beforeReport = JSON.parse(beforeBaseline.stdout);
      assert.equal(beforeReport.failures.length, 1);
      assert.equal(beforeReport.failures[0].path, "src/legacy.ts");

      // Generate baseline -> now full size-check passes
      mustRun(process.execPath, [CLI, "size-check", "--update-baseline"], repo);
      const baselineJson = JSON.parse(readFileSync(path.join(repo, ".featflow-size-baseline.json"), "utf8"));
      assert.deepEqual(baselineJson, { "src/legacy.ts": 14 });
      mustRun(process.execPath, [CLI, "size-check"], repo);
      mustRun("git", ["add", ".featflow-size-baseline.json"], repo);
      mustRun("git", ["commit", "-m", "add baseline"], repo);

      // On task branch, growing legacy.ts by 1 line fails --changed and PostToolUse hook!
      mustRun("git", ["checkout", "-b", "feat/alice-expand"], repo);
      writeFileSync(path.join(repo, "src", "legacy.ts"), makeLines(15));
      mustRun("git", ["add", "src/legacy.ts"], repo);
      mustRun("git", ["commit", "-m", "grow legacy"], repo);

      const changedFail = run(process.execPath, [CLI, "size-check", "--changed", "--json"], repo);
      assert.equal(changedFail.status, 1);
      assert.equal(JSON.parse(changedFail.stdout).failures[0].label, "baseline 14");

      const stateDir = mkdtempSync(path.join(tmpdir(), "featflow-post-hook-"));
      try {
        const hookEnv = { FEATFLOW_HOOK_STATE_DIR: stateDir };
        const postBlock = run(process.execPath, [CLI, "hook", "codex", "post-tool-use"], repo, {
          input: JSON.stringify({ tool_name: "apply_patch" }),
          env: hookEnv,
        });
        assert.equal(postBlock.status, 2);
        assert.match(postBlock.stderr, /size budget failed/);

        // Deduplicated repeat allows exit 0
        const postDedup = run(process.execPath, [CLI, "hook", "codex", "post-tool-use"], repo, {
          input: JSON.stringify({ tool_name: "apply_patch" }),
          env: hookEnv,
        });
        assert.equal(postDedup.status, 0);

        // PreToolUse hardening: unparseable apply_patch fails closed + custom blockedCommands works
        const unparseablePatch = run(process.execPath, [CLI, "hook", "codex", "pre-tool-use"], repo, {
          input: JSON.stringify({ tool_name: "apply_patch", tool_input: { input: "corrupted hunk" } }),
        });
        assert.equal(unparseablePatch.status, 2);
        assert.match(unparseablePatch.stderr, /no target file paths/);

        const customBlocked = run(process.execPath, [CLI, "hook", "claude-code", "pre-tool-use"], repo, {
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "python3 -m venv .venv" } }),
        });
        assert.equal(customBlocked.status, 2);
        assert.match(customBlocked.stderr, /Use uv instead of venv/);
      } finally {
        rmSync(stateDir, { force: true, recursive: true });
      }
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("parses YAML & JSON regression ledgers (including block scalars and globs), checks impact, runs verify, and handles codegraph + init options", () => {
    const sampleYaml = `
- id: stream-dedupe
  title: Stream progress does not duplicate output
  status: guarded
  surfaces: [agent, web]
  symptom: >-
    Assistant output appeared twice
    during streamed runs.
  root_cause: Both events rendered as bubbles.
  invariant: |
    Raw tool messages must not become
    normal chat bubbles.
  files:
    - src/stream_*.ts
    - src/chat.ts
  guards:
    - tests/stream.test.mjs
  commands:
    - node -e "process.exit(0)"
  owner_notes: Keep tool progress separate.

- id: retired-old-bug
  title: Old removed path
  status: retired
  invariant: No longer applies.
  files:
    - src/stream_old.ts
  guards: []
  commands: []
`;
    const parsed = parseRegressionLedgerYaml(sampleYaml);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0].surfaces, ["agent", "web"]);
    assert.equal(parsed[0].symptom, "Assistant output appeared twice during streamed runs.");
    assert.match(parsed[0].invariant, /Raw tool messages must not become\nnormal chat bubbles\./);
    assert.deepEqual(parsed[0].files, ["src/stream_*.ts", "src/chat.ts"]);

    const fixture = createRepo("regression");
    try {
      const { repo } = fixture;
      mustRun(
        process.execPath,
        [CLI, "init", "--yes", "--no-hooks", "--with-size-budget", "--with-regression", "--with-codex-agents"],
        repo,
      );
      assert.equal(existsSync(path.join(repo, ".agents", "skills", "featflow-regression", "SKILL.md")), true);
      assert.equal(existsSync(path.join(repo, ".codex", "agents", "codebase-locator.toml")), true);
      assert.equal(existsSync(path.join(repo, ".codex", "agents", "implementation-scout.toml")), true);
      assert.equal(existsSync(path.join(repo, ".codex", "agents", "regression-guard-planner.toml")), true);
      mustRun(process.execPath, [CLI, "sync", "--check"], repo);

      // Write ledger + guard file and validate
      mkdirSync(path.join(repo, "context"), { recursive: true });
      mkdirSync(path.join(repo, "src"), { recursive: true });
      mkdirSync(path.join(repo, "tests"), { recursive: true });
      writeFileSync(path.join(repo, "context", "regression-ledger.yml"), sampleYaml);
      writeFileSync(path.join(repo, "tests", "stream.test.mjs"), "export {};\n");
      writeFileSync(path.join(repo, "src", "stream_handler.ts"), "export const ok = true;\n");

      const validated = JSON.parse(mustRun(process.execPath, [CLI, "regression", "validate", "--strict", "--json"], repo));
      assert.equal(validated.ok, true);
      assert.equal(validated.entryCount, 2);

      // Impact analysis matches src/stream_handler.ts against glob src/stream_*.ts, ignores retired entry, and --run succeeds
      const impacted = JSON.parse(
        mustRun(process.execPath, [CLI, "regression", "check", "--files", "src/stream_handler.ts", "--json"], repo),
      );
      assert.equal(impacted.ok, true);
      assert.equal(impacted.impacted.length, 1);
      assert.equal(impacted.impacted[0].id, "stream-dedupe");
      assert.equal(impacted.executions.length, 1);
      assert.equal(impacted.executions[0].ok, true);

      // Verify command matches verifyCommands against changed files + --with-size + --with-regression
      const cfgPath = path.join(repo, ".featflow.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      cfg.verifyCommands = {
        "src/": 'node -e "process.exit(0)"',
        "docs/": 'node -e "process.exit(1)"',
      };
      writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

      const verifyRes = JSON.parse(
        mustRun(
          process.execPath,
          [CLI, "verify", "--files", "src/stream_handler.ts", "--with-size", "--with-regression", "--json"],
          repo,
        ),
      );
      assert.equal(verifyRes.ok, true);
      assert.equal(verifyRes.results.length, 1);
      assert.equal(verifyRes.sizeCheck.ok, true);

      // UserPromptSubmit emits regression reminder when config.regression is set
      const promptRes = run(process.execPath, [CLI, "hook", "claude-code", "user-prompt"], repo, {
        input: JSON.stringify({ prompt: "帮我修这个 bug" }),
      });
      assert.equal(promptRes.status, 0);
      assert.match(JSON.parse(promptRes.stdout).hookSpecificOutput.additionalContext, /featflow regression impact/);

      // CodeGraph skips cleanly when FEATFLOW_SKIP_CODEGRAPH=1 or CI=1, and reports JSON status
      const cgSkip = mustRun(process.execPath, [CLI, "codegraph"], repo, { env: { FEATFLOW_SKIP_CODEGRAPH: "1" } });
      assert.match(cgSkip, /Skipping CodeGraph/);
      const cgStatus = JSON.parse(mustRun(process.execPath, [CLI, "codegraph", "status", "--json"], repo));
      assert.equal(typeof cgStatus.installed, "boolean");
      assert.equal(cgStatus.indexed, false);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });
});
