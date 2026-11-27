import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadConfig, presetConfig, resolveWorktreeParent } from "../src/config.mjs";
import { isInsidePath, isTaskBranch, parseWorktrees, sanitizeBranchForDir } from "../src/git.mjs";

describe("config & git primitives", () => {
  it("builds valid presets for trunk and developer-branch modes", () => {
    const trunk = presetConfig("trunk");
    assert.equal(trunk.mode, "trunk");
    assert.deepEqual(trunk.protectedBranches, ["main"]);
    assert.equal(trunk.finishTarget, "merge");
    assert.equal(trunk.requireRemote, false);

    const devBranch = presetConfig("developer-branch");
    assert.equal(devBranch.mode, "developer-branch");
    assert.deepEqual(devBranch.protectedBranches, ["main", "dev"]);
    assert.equal(devBranch.finishTarget, "developer-branch");
    assert.equal(devBranch.requireRemote, true);

    assert.throws(() => presetConfig("invalid"), /Unsupported featflow mode/);
  });

  it("checks path containment accurately without false prefix matches", () => {
    const base = mkdtempSync(path.join(tmpdir(), "featflow-path-"));
    try {
      const a = path.join(base, "repo");
      const aChild = path.join(a, "src", "index.mjs");
      const aSibling = path.join(base, "repo-worktrees");
      mkdirSync(path.join(a, "src"), { recursive: true });
      mkdirSync(aSibling, { recursive: true });
      writeFileSync(aChild, "");

      assert.equal(isInsidePath(a, a), true);
      assert.equal(isInsidePath(aChild, a), true);
      assert.equal(isInsidePath(aSibling, a), false);
    } finally {
      rmSync(base, { force: true, recursive: true });
    }
  });

  it("matches task branches accurately across trunk and developer-branch modes", () => {
    const trunk = presetConfig("trunk");
    assert.equal(isTaskBranch("feat/oauth-login", trunk), true);
    assert.equal(isTaskBranch("fix/timeout", trunk), true);
    assert.equal(isTaskBranch("random/branch", trunk), false);
    assert.equal(isTaskBranch("main", trunk), false);

    const dev = presetConfig("developer-branch");
    assert.equal(isTaskBranch("feat/alice-oauth", dev, "alice"), true);
    assert.equal(isTaskBranch("feat/bob-oauth", dev, "alice"), false);
    assert.equal(isTaskBranch("feat/oauth", dev, "alice"), false);
  });

  it("parses git worktree porcelain output and derives sibling worktree parent", () => {
    const parsed = parseWorktrees([
      "worktree /tmp/demo",
      "HEAD 11111111",
      "branch refs/heads/main",
      "",
      "worktree /tmp/demo-worktrees/feat-x",
      "HEAD 22222222",
      "branch refs/heads/feat/x",
      "",
    ].join("\n"));

    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].branch, "refs/heads/main");
    assert.equal(parsed[1].branch, "refs/heads/feat/x");
    assert.equal(sanitizeBranchForDir("feat/alice-oauth"), "feat-alice-oauth");
  });

  it("loads custom .featflow.json overrides cleanly", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "featflow-cfg-"));
    try {
      writeFileSync(
        path.join(dir, ".featflow.json"),
        JSON.stringify({
          mode: "trunk",
          finishTarget: "pr",
          worktreeParent: "../custom-wt",
          productPaths: ["packages/"],
        }),
      );
      const { config, hasConfigFile } = loadConfig(dir);
      assert.equal(hasConfigFile, true);
      assert.equal(config.finishTarget, "pr");
      assert.deepEqual(config.productPaths, ["packages/"]);
      assert.equal(path.basename(resolveWorktreeParent(dir, config)), "custom-wt");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
