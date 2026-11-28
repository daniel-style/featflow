import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyGitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      ...(extra.env ?? {}),
    },
  });
}

function mustRun(command, args, cwd) {
  const res = run(command, args, cwd);
  assert.equal(res.status, 0, `${command} ${args.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
}

function featflow(args, cwd) {
  return run(process.execPath, [CLI, ...args], cwd);
}

function createRepo(name) {
  const parent = mkdtempSync(path.join(tmpdir(), `featflow-sync-${name}-`));
  const repo = path.join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  mustRun("git", ["init", "-b", "main"], repo);
  mustRun("git", ["config", "user.name", "Alice"], repo);
  mustRun("git", ["config", "user.email", "alice@example.test"], repo);
  writeFileSync(path.join(repo, "README.md"), "# sync demo\n");
  mustRun("git", ["add", "."], repo);
  mustRun("git", ["commit", "-m", "initial"], repo);
  return { parent, repo };
}

describe("featflow sync", () => {
  it("detects drift via --check, syncs managed files cleanly, and preserves .featflow.json, active records, and custom AGENTS.md content", () => {
    const fixture = createRepo("drift");
    try {
      const { repo } = fixture;

      // Pre-populate custom AGENTS.md rules before init
      const agentsPath = path.join(repo, "AGENTS.md");
      writeFileSync(agentsPath, "# Project Rules\n\nKeep commits small.\n");

      // Init with custom config & githooks
      assert.equal(featflow(["init", "--mode", "developer-branch", "--with-githooks"], repo).status, 0);

      // Customize .featflow.json and add an active feature record
      const configPath = path.join(repo, ".featflow.json");
      const customConfig = JSON.parse(readFileSync(configPath, "utf8"));
      customConfig.developerBranchConfigKey = "custom.developerBranch";
      customConfig.postWorktreeCreate = ["echo ready"];
      writeFileSync(configPath, `${JSON.stringify(customConfig, null, 2)}\n`);

      const activePath = path.join(repo, "features", "active", "2026-06-15-1000-keep-me.md");
      writeFileSync(activePath, "# Keep my active feature\n");

      // Immediately after init, --check passes (skill + 3 templates + 3 githooks + AGENTS.md = 8)
      const cleanCheck = featflow(["sync", "--check"], repo);
      assert.equal(cleanCheck.status, 0, cleanCheck.stderr);
      assert.match(cleanCheck.stdout, /passed \(8 managed files up to date\)/);

      // Introduce drift in Skill, template, hook, and AGENTS.md managed block; delete README.md
      const skillPath = path.join(repo, ".agents", "skills", "featflow", "SKILL.md");
      const templatePath = path.join(repo, "features", "_template.md");
      const hookPath = path.join(repo, ".githooks", "pre-commit");
      const readmePath = path.join(repo, "features", "README.md");

      writeFileSync(skillPath, "stale skill\n");
      writeFileSync(templatePath, "stale template\n");
      writeFileSync(hookPath, "#!/usr/bin/env sh\necho stale\n");
      writeFileSync(
        agentsPath,
        "# Project Rules\n\nKeep commits small.\n\n<!-- FEATFLOW_START -->\nstale workflow snippet\n<!-- FEATFLOW_END -->\n",
      );
      rmSync(readmePath);

      // --check fails with JSON summary
      const driftCheck = featflow(["sync", "--check", "--json"], repo);
      assert.equal(driftCheck.status, 1);
      const report = JSON.parse(driftCheck.stdout);
      assert.equal(report.ok, false);
      assert.deepEqual(report.missing, ["features/README.md"]);
      assert.equal(report.drifted.length, 4);
      assert.equal(report.drifted.includes("AGENTS.md"), true);

      // --dry-run does not modify files
      const dryRun = featflow(["sync", "--dry-run"], repo);
      assert.equal(dryRun.status, 0);
      assert.match(dryRun.stdout, /Would sync/);
      assert.equal(existsSync(readmePath), false);
      assert.match(readFileSync(agentsPath, "utf8"), /stale workflow snippet/);

      // Real sync restores all managed files without touching .featflow.json, active records, or custom AGENTS.md text
      const synced = featflow(["sync"], repo);
      assert.equal(synced.status, 0, synced.stderr);
      assert.match(synced.stdout, /Synced featflow managed files/);

      // Re-check passes!
      assert.equal(featflow(["sync", "--check"], repo).status, 0);

      // .featflow.json, active feature, and custom AGENTS.md header are completely untouched
      const afterConfig = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(afterConfig.developerBranchConfigKey, "custom.developerBranch");
      assert.deepEqual(afterConfig.postWorktreeCreate, ["echo ready"]);
      assert.equal(readFileSync(activePath, "utf8"), "# Keep my active feature\n");

      const afterAgents = readFileSync(agentsPath, "utf8");
      assert.match(afterAgents, /# Project Rules\n\nKeep commits small\./);
      assert.match(afterAgents, /Universal Pre-Implementation Gate/);
      assert.doesNotMatch(afterAgents, /stale workflow snippet/);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("supports --only subset filtering (including agent-docs) and skips githooks when .githooks does not exist", () => {
    const fixture = createRepo("subset");
    try {
      const { repo } = fixture;

      const syncSkillOnly = featflow(["sync", "--only", "skill"], repo);
      assert.equal(syncSkillOnly.status, 0, syncSkillOnly.stderr);
      assert.equal(existsSync(path.join(repo, ".agents", "skills", "featflow", "SKILL.md")), true);
      assert.equal(existsSync(path.join(repo, "features", "_template.md")), false);
      assert.equal(existsSync(path.join(repo, ".githooks", "pre-commit")), false);

      // Check only skill passes
      assert.equal(featflow(["sync", "--check", "--only", "skill"], repo).status, 0);

      // Default sync (without .githooks or managed AGENTS.md present) syncs skill + templates only
      const syncDefault = featflow(["sync"], repo);
      assert.equal(syncDefault.status, 0, syncDefault.stderr);
      assert.equal(existsSync(path.join(repo, "features", "_template.md")), true);
      assert.equal(existsSync(path.join(repo, "AGENTS.md")), false);

      // Explicit --only agent-docs injects managed block into AGENTS.md
      const syncDocs = featflow(["sync", "--only", "agent-docs"], repo);
      assert.equal(syncDocs.status, 0, syncDocs.stderr);
      assert.equal(existsSync(path.join(repo, "AGENTS.md")), true);
      assert.match(readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /<!-- FEATFLOW_START -->/);
      assert.equal(featflow(["sync", "--check", "--only", "agent-docs"], repo).status, 0);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });
});
