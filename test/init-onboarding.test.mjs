import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_PRODUCT_PATHS, packageRoot } from "../src/config.mjs";

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
    `${command} ${args.join(" ")} failed in ${cwd}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
  return res.stdout.trim();
}

function featflow(args, cwd, extra = {}) {
  return run(process.execPath, [CLI, ...args], cwd, extra);
}

function createRepo(name, { defaultBranch = "main", withDev = "" } = {}) {
  const parent = mkdtempSync(path.join(tmpdir(), `featflow-onboard-${name}-`));
  const repo = path.join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  mustRun("git", ["init", "-b", defaultBranch], repo);
  mustRun("git", ["config", "user.name", "Alice"], repo);
  mustRun("git", ["config", "user.email", "alice@example.test"], repo);
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  mustRun("git", ["add", "."], repo);
  mustRun("git", ["commit", "-m", "initial"], repo);
  if (withDev) {
    mustRun("git", ["branch", withDev], repo);
  }
  return { parent, repo };
}

describe("smart featflow init onboarding", () => {
  it("auto-detects master branch, Go productPaths, and go test verifyCommands (and respects --no-detect)", () => {
    const fixture = createRepo("go-master", { defaultBranch: "master" });
    try {
      const { repo } = fixture;
      mkdirSync(path.join(repo, "cmd", "server"), { recursive: true });
      mkdirSync(path.join(repo, "internal", "auth"), { recursive: true });
      writeFileSync(path.join(repo, "go.mod"), "module example.com/demo\n\ngo 1.22\n");

      const res = featflow(["init", "--minimal"], repo);
      assert.equal(res.status, 0, res.stderr);

      const cfg = JSON.parse(readFileSync(path.join(repo, ".featflow.json"), "utf8"));
      assert.equal(cfg.baseBranch, "master");
      assert.deepEqual(cfg.protectedBranches, ["master"]);
      assert.deepEqual(cfg.productPaths, ["cmd/", "internal/"]);
      assert.deepEqual(cfg.verifyCommands, {
        "cmd/": "go test ./...",
        "internal/": "go test ./...",
      });

      // --no-detect + --force restores static presets
      const rawRes = featflow(["init", "--minimal", "--no-detect", "--force"], repo);
      assert.equal(rawRes.status, 0, rawRes.stderr);
      const rawCfg = JSON.parse(readFileSync(path.join(repo, ".featflow.json"), "utf8"));
      assert.equal(rawCfg.baseBranch, "main");
      assert.deepEqual(rawCfg.productPaths, DEFAULT_PRODUCT_PATHS);
      assert.deepEqual(rawCfg.verifyCommands, {});
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("auto-detects develop integration branch, Python package productPaths, uv pytest, and avoids BDD features/ collision", () => {
    const fixture = createRepo("py-bdd", { defaultBranch: "master", withDev: "develop" });
    try {
      const { repo } = fixture;
      mkdirSync(path.join(repo, "my_service"), { recursive: true });
      writeFileSync(path.join(repo, "my_service", "__init__.py"), "");
      writeFileSync(path.join(repo, "pyproject.toml"), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
      writeFileSync(path.join(repo, "uv.lock"), "version = 1\n");

      // Existing non-featflow BDD features/ directory
      mkdirSync(path.join(repo, "features"), { recursive: true });
      writeFileSync(path.join(repo, "features", "login.feature"), "Feature: Login\n");

      const res = featflow(["init", "--mode", "developer-branch"], repo);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Detected existing non-featflow "features\/" directory/);

      const cfg = JSON.parse(readFileSync(path.join(repo, ".featflow.json"), "utf8"));
      assert.equal(cfg.releaseBranch, "master");
      assert.equal(cfg.integrationBranch, "develop");
      assert.equal(cfg.baseBranch, "develop");
      assert.deepEqual(cfg.protectedBranches, ["master", "develop"]);
      assert.deepEqual(cfg.productPaths, ["my_service/"]);
      assert.deepEqual(cfg.verifyCommands, { "my_service/": "uv run pytest" });
      assert.equal(cfg.featuresDir, "docs/features");

      // Original BDD feature file untouched; featflow templates placed under docs/features/
      assert.equal(readFileSync(path.join(repo, "features", "login.feature"), "utf8"), "Feature: Login\n");
      assert.equal(existsSync(path.join(repo, "docs", "features", "_template.md")), true);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("auto-detects Node/pnpm package manager and skips npm boilerplate test scripts", () => {
    const fixture = createRepo("pnpm-node");
    try {
      const { repo } = fixture;
      mkdirSync(path.join(repo, "apps", "web"), { recursive: true });
      mkdirSync(path.join(repo, "packages", "ui"), { recursive: true });
      writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeFileSync(
        path.join(repo, "package.json"),
        JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }, null, 2),
      );

      const res = featflow(["init", "--minimal"], repo);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /pnpm install --frozen-lockfile --offline/);

      const cfg = JSON.parse(readFileSync(path.join(repo, ".featflow.json"), "utf8"));
      assert.deepEqual(cfg.productPaths, ["apps/", "packages/"]);
      assert.deepEqual(cfg.verifyCommands, {
        "apps/": "pnpm test",
        "packages/": "pnpm test",
      });
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("injects managed AGENTS.md/CLAUDE.md blocks non-destructively and handles single, dual, @AGENTS.md, and --no-agent-docs", () => {
    const fixture = createRepo("agent-docs");
    try {
      const { repo } = fixture;

      // 1. Only CLAUDE.md exists -> updates CLAUDE.md without creating AGENTS.md
      writeFileSync(path.join(repo, "CLAUDE.md"), "# Claude Instructions\n\nUse strict types.\n");
      assert.equal(featflow(["init", "--minimal", "--no-hooks"], repo).status, 0);
      assert.equal(existsSync(path.join(repo, "AGENTS.md")), false);
      const claudeAfter = readFileSync(path.join(repo, "CLAUDE.md"), "utf8");
      assert.match(claudeAfter, /# Claude Instructions\n\nUse strict types\./);
      assert.equal((claudeAfter.match(/<!-- FEATFLOW_START -->/g) ?? []).length, 1);

      // Re-running init is idempotent (no duplicate block)
      assert.equal(featflow(["init", "--minimal", "--no-hooks"], repo).status, 0);
      assert.equal((readFileSync(path.join(repo, "CLAUDE.md"), "utf8").match(/<!-- FEATFLOW_START -->/g) ?? []).length, 1);

      // 2. When CLAUDE.md delegates via @AGENTS.md -> only AGENTS.md is updated
      writeFileSync(path.join(repo, "AGENTS.md"), "# Shared Agents\n");
      writeFileSync(path.join(repo, "CLAUDE.md"), "@AGENTS.md\n");
      assert.equal(featflow(["init", "--minimal", "--no-hooks"], repo).status, 0);
      assert.match(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /<!-- FEATFLOW_START -->/);
      assert.equal(readFileSync(path.join(repo, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");

      // 3. When both are independent files -> both get managed blocks
      writeFileSync(path.join(repo, "CLAUDE.md"), "# Independent Claude Doc\n");
      assert.equal(featflow(["init", "--minimal", "--no-hooks"], repo).status, 0);
      assert.match(readFileSync(path.join(repo, "CLAUDE.md"), "utf8"), /<!-- FEATFLOW_START -->/);

      // 4. Symlinked CLAUDE.md -> AGENTS.md deduplicates cleanly (on platforms supporting symlinks)
      if (process.platform !== "win32") {
        rmSync(path.join(repo, "CLAUDE.md"));
        symlinkSync("AGENTS.md", path.join(repo, "CLAUDE.md"));
        assert.equal(featflow(["init", "--minimal", "--no-hooks"], repo).status, 0);
        assert.equal((readFileSync(path.join(repo, "AGENTS.md"), "utf8").match(/<!-- FEATFLOW_START -->/g) ?? []).length, 1);
      }
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }

    // 5. --no-agent-docs skips creating AGENTS.md
    const noDocsFixture = createRepo("no-agent-docs");
    try {
      const { repo } = noDocsFixture;
      assert.equal(featflow(["init", "--minimal", "--no-agent-docs", "--no-hooks"], repo).status, 0);
      assert.equal(existsSync(path.join(repo, "AGENTS.md")), false);
    } finally {
      rmSync(noDocsFixture.parent, { force: true, recursive: true });
    }
  });

  it("supports featflow init --minimal with local hooks, clean doctor with global skill, and minimal-aware sync", () => {
    const fixture = createRepo("minimal-e2e");
    const fakeHome = mkdtempSync(path.join(tmpdir(), "featflow-home-"));
    try {
      const { repo } = fixture;
      mkdirSync(path.join(repo, "src"), { recursive: true });
      mkdirSync(path.join(fakeHome, ".agents", "skills", "featflow"), { recursive: true });
      writeFileSync(path.join(fakeHome, ".agents", "skills", "featflow", "SKILL.md"), "# global skill\n");

      const initRes = featflow(["init", "--minimal"], repo);
      assert.equal(initRes.status, 0, initRes.stderr);
      assert.equal(existsSync(path.join(repo, ".featflow.json")), true);
      assert.equal(existsSync(path.join(repo, "AGENTS.md")), true);
      assert.equal(existsSync(path.join(repo, ".git", "hooks", "pre-commit")), true);
      assert.equal(existsSync(path.join(repo, "features")), false);
      assert.equal(existsSync(path.join(repo, ".agents")), false);

      // doctor should report zero WARN and zero FAIL in --minimal mode when global skill is installed
      const doctorRes = featflow(["doctor"], repo, { env: { FEATFLOW_HOME: fakeHome } });
      assert.equal(doctorRes.status, 0, doctorRes.stderr);
      assert.match(doctorRes.stdout, /\[PASS\] Feature template: using built-in template/);
      assert.match(doctorRes.stdout, /\[PASS\] Agent Skill: global/);
      assert.match(doctorRes.stdout, /\[PASS\] Agent docs: AGENTS\.md/);
      assert.match(doctorRes.stdout, /\[PASS\] Git hooks: local \.git\/hooks managed blocks installed/);
      assert.doesNotMatch(doctorRes.stdout, /\[WARN\]/);
      assert.doesNotMatch(doctorRes.stdout, /\[FAIL\]/);

      // sync --check & sync in --minimal mode only manage AGENTS.md and never create features/ or .agents/
      const syncCheck = featflow(["sync", "--check", "--json"], repo);
      assert.equal(syncCheck.status, 0, syncCheck.stderr);
      const summary = JSON.parse(syncCheck.stdout);
      assert.deepEqual(summary.groups, ["agent-docs"]);
      assert.deepEqual(summary.upToDate, ["AGENTS.md"]);

      const syncRun = featflow(["sync"], repo);
      assert.equal(syncRun.status, 0, syncRun.stderr);
      assert.equal(existsSync(path.join(repo, "features")), false);
      assert.equal(existsSync(path.join(repo, ".agents")), false);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
      rmSync(fakeHome, { force: true, recursive: true });
    }
  });

  it("safely merges existing .claude/settings.json and .codex/config.toml without clobbering user config", () => {
    const fixture = createRepo("adapter-merge");
    try {
      const { repo } = fixture;
      mkdirSync(path.join(repo, ".claude"), { recursive: true });
      mkdirSync(path.join(repo, ".codex"), { recursive: true });

      writeFileSync(
        path.join(repo, ".claude", "settings.json"),
        JSON.stringify(
          {
            permissions: { allow: ["Bash(git status)"] },
            hooks: {
              PreToolUse: [
                {
                  matcher: "Bash",
                  hooks: [{ type: "command", command: "echo custom-guard" }],
                },
              ],
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(path.join(repo, ".codex", "config.toml"), 'model = "gpt-5"\n');

      const res1 = featflow(["init", "--minimal", "--no-hooks", "--with-claude-hooks", "--with-codex-hooks"], repo);
      assert.equal(res1.status, 0, res1.stderr);

      const claude = JSON.parse(readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));
      assert.deepEqual(claude.permissions, { allow: ["Bash(git status)"] });
      assert.equal(claude.hooks.PreToolUse.length, 2);
      assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, "echo custom-guard");
      assert.equal(claude.hooks.PreToolUse[1].hooks[0].command, "featflow hook claude-code pre-tool-use");
      assert.equal(claude.hooks.UserPromptSubmit.length, 1);
      assert.equal(claude.hooks.Stop.length, 1);

      const codex = readFileSync(path.join(repo, ".codex", "config.toml"), "utf8");
      assert.match(codex, /model = "gpt-5"/);
      assert.match(codex, /# >>> featflow managed hooks >>>/);
      assert.match(codex, /featflow hook codex pre-tool-use/);

      // Re-running init is idempotent (does not duplicate merged hooks)
      assert.equal(
        featflow(["init", "--minimal", "--no-hooks", "--with-claude-hooks", "--with-codex-hooks"], repo).status,
        0,
      );
      const claude2 = JSON.parse(readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"));
      assert.equal(claude2.hooks.PreToolUse.length, 2);
      const codex2 = readFileSync(path.join(repo, ".codex", "config.toml"), "utf8");
      assert.equal((codex2.match(/featflow hook codex pre-tool-use/g) ?? []).length, 1);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("supports interactive TTY init wizard chaining developer-branch setup, plus non-interactive --developer-branch", () => {
    const ttyFixture = createRepo("tty-wizard", { withDev: "dev" });
    try {
      const { repo } = ttyFixture;
      mkdirSync(path.join(repo, "src"), { recursive: true });
      mkdirSync(path.join(repo, ".claude"), { recursive: true });

      // Answers:
      // 1. profile -> minimal
      // 2. mode -> Enter (accept detected default: developer-branch since dev exists)
      // 3. local git hooks -> Enter (Y)
      // 4. Claude Code hooks -> Enter (Y, since .claude/ exists)
      // 5. Set up personal developer branch now? -> Enter (Y)
      // 6. Personal developer branch name [alice]: -> Enter (alice)
      const res = featflow(["init", "--local-only"], repo, {
        env: { FEATFLOW_FORCE_TTY: "1" },
        input: "minimal\n\n\n\n\n\n",
      });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Detected repository environment:/);
      assert.match(res.stdout, /Developer branch configured: alice/);
      assert.equal(mustRun("git", ["config", "--get", "featflow.developerBranch"], repo), "alice");
      assert.equal(existsSync(path.join(repo, ".claude", "settings.json")), true);
      assert.equal(existsSync(path.join(repo, ".git", "hooks", "pre-commit")), true);
      assert.equal(existsSync(path.join(repo, "AGENTS.md")), true);
      assert.equal(existsSync(path.join(repo, "features")), false);
    } finally {
      rmSync(ttyFixture.parent, { force: true, recursive: true });
    }

    // Non-interactive one-command developer-branch init + setup
    const cliFixture = createRepo("one-shot-dev", { withDev: "dev" });
    try {
      const { repo } = cliFixture;
      const res = featflow(
        ["init", "--mode", "developer-branch", "--developer-branch", "bob", "--local-only", "--yes"],
        repo,
      );
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Developer branch configured: bob/);
      assert.equal(mustRun("git", ["config", "--get", "featflow.developerBranch"], repo), "bob");
    } finally {
      rmSync(cliFixture.parent, { force: true, recursive: true });
    }
  });
});
