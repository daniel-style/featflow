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

function mustFeatflow(args, cwd, extra = {}) {
  return mustRun(process.execPath, [CLI, ...args], cwd, extra);
}

function createRepo(name, { withRemote = false, withDev = false } = {}) {
  const parent = mkdtempSync(path.join(tmpdir(), `featflow-e2e-${name}-`));
  const repo = path.join(parent, "demo-repo");
  mkdirSync(repo, { recursive: true });

  mustRun("git", ["init", "-b", "main"], repo);
  mustRun("git", ["config", "user.name", "Alice"], repo);
  mustRun("git", ["config", "user.email", "alice@example.test"], repo);
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  mustRun("git", ["add", "."], repo);
  mustRun("git", ["commit", "-m", "chore: initial commit"], repo);

  if (withRemote) {
    const bare = path.join(parent, "origin.git");
    mustRun("git", ["init", "--bare", bare], parent);
    mustRun("git", ["remote", "add", "origin", bare], repo);
    mustRun("git", ["push", "-u", "origin", "main"], repo);
    if (withDev) {
      mustRun("git", ["branch", "dev"], repo);
      mustRun("git", ["push", "-u", "origin", "dev"], repo);
    }
  } else if (withDev) {
    mustRun("git", ["branch", "dev"], repo);
  }

  return { parent, repo };
}

function branchExists(repo, branch) {
  return run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo).status === 0;
}

describe("featflow CLI end-to-end workflows", () => {
  it("runs complete trunk workflow locally (init -> worktree -> commit -> finish from inside worktree)", () => {
    const fixture = createRepo("trunk-local");
    try {
      const { repo } = fixture;

      mustFeatflow(["init", "--mode", "trunk", "--with-githooks"], repo);
      assert.equal(existsSync(path.join(repo, ".featflow.json")), true);
      assert.equal(existsSync(path.join(repo, ".agents", "skills", "featflow", "SKILL.md")), true);
      assert.equal(existsSync(path.join(repo, "features", "_template.md")), true);
      assert.equal(existsSync(path.join(repo, ".githooks", "pre-commit")), true);

      // Commit init files using FEATFLOW_BOOTSTRAP=1
      mustRun("git", ["add", "."], repo);
      mustRun("git", ["commit", "-m", "chore: initialize featflow"], repo, {
        env: { FEATFLOW_BOOTSTRAP: "1" },
      });

      // Verify pre-commit policy blocks direct commits on main
      const policyRes = featflow(["policy", "pre-commit"], repo);
      assert.notEqual(policyRes.status, 0);
      assert.match(policyRes.stderr, /protected branch "main"/);

      // Create task worktree from main
      const wtPath = path.join(fixture.parent, "demo-repo-worktrees", "feat-hello");
      mustFeatflow(["worktree", "feat/hello"], repo);
      assert.equal(existsSync(wtPath), true);

      // Commit inside task worktree
      writeFileSync(path.join(wtPath, "hello.txt"), "hello world\n");
      mustRun("git", ["add", "hello.txt"], wtPath);
      mustRun("git", ["commit", "-m", "feat: add hello"], wtPath, {
        env: { PATH: `${path.join(packageRoot, "bin")}${path.delimiter}${process.env.PATH}` },
      });

      // Run finish FROM INSIDE the task worktree being removed!
      mustFeatflow(["finish", "feat/hello"], wtPath);

      assert.equal(existsSync(wtPath), false, "task worktree should be removed");
      assert.equal(branchExists(repo, "feat/hello"), false, "task branch should be deleted");
      assert.equal(existsSync(path.join(repo, "hello.txt")), true, "main should contain merged file");

      const doctorOut = mustFeatflow(["doctor"], repo);
      assert.match(doctorOut, /\[PASS\] Config/);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("runs complete developer-branch workflow (setup -> worktree -> finish push & --no-push -> cleanup)", () => {
    const fixture = createRepo("dev-branch", { withRemote: true, withDev: true });
    try {
      const { parent, repo } = fixture;

      mustFeatflow(["init", "--mode", "developer-branch", "--with-githooks"], repo);
      mustRun("git", ["add", "."], repo);
      mustRun("git", ["commit", "-m", "chore: init featflow"], repo, {
        env: { FEATFLOW_BOOTSTRAP: "1" },
      });
      mustRun("git", ["push", "origin", "main"], repo, { env: { FEATFLOW_BOOTSTRAP: "1" } });
      mustRun("git", ["branch", "-f", "dev", "main"], repo);
      mustRun("git", ["push", "origin", "dev"], repo, { env: { FEATFLOW_BOOTSTRAP: "1" } });

      // Setup personal developer branch
      mustFeatflow(["setup", "alice"], repo);
      assert.equal(mustRun("git", ["config", "--get", "featflow.developerBranch"], repo), "alice");

      // Create task branch and finish WITH push
      mustFeatflow(["worktree", "fix/alice-bug"], repo);
      const wt1 = path.join(parent, "demo-repo-worktrees", "fix-alice-bug");
      writeFileSync(path.join(wt1, "fix1.txt"), "fixed\n");
      mustRun("git", ["add", "fix1.txt"], wt1);
      mustRun("git", ["commit", "-m", "fix: bug one"], wt1, {
        env: { FEATFLOW_BOOTSTRAP: "1" },
      });
      mustFeatflow(["finish", "fix/alice-bug"], wt1);

      assert.equal(existsSync(wt1), false);
      assert.equal(branchExists(repo, "fix/alice-bug"), false);
      assert.equal(
        mustRun("git", ["rev-parse", "alice"], repo),
        mustRun("git", ["rev-parse", "origin/alice"], repo),
      );

      // Finish with --no-push keeps remote unchanged
      const remoteBefore = mustRun("git", ["rev-parse", "origin/alice"], repo);
      mustFeatflow(["worktree", "feat/alice-local"], repo);
      const wt2 = path.join(parent, "demo-repo-worktrees", "feat-alice-local");
      writeFileSync(path.join(wt2, "local.txt"), "local\n");
      mustRun("git", ["add", "local.txt"], wt2);
      mustRun("git", ["commit", "-m", "feat: local only"], wt2, {
        env: { FEATFLOW_BOOTSTRAP: "1" },
      });
      mustFeatflow(["finish", "feat/alice-local", "--no-push"], wt2);

      assert.equal(existsSync(wt2), false);
      assert.equal(mustRun("git", ["rev-parse", "origin/alice"], repo), remoteBefore);
      assert.notEqual(mustRun("git", ["rev-parse", "alice"], repo), remoteBefore);

      // Policy pre-push blocks pushing to protected branches dev/main
      const prePushDev = featflow(["policy", "pre-push"], repo, {
        input: "refs/heads/dev 1111 refs/heads/dev 0000\n",
      });
      assert.notEqual(prePushDev.status, 0);
      assert.match(prePushDev.stderr, /protected branch "dev"/);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("never clobbers an existing Husky core.hooksPath during init or setup", () => {
    const fixture = createRepo("husky-safe");
    try {
      const { repo } = fixture;
      mustRun("git", ["config", "core.hooksPath", ".husky"], repo);

      const out = mustFeatflow(["init", "--with-githooks"], repo);
      assert.match(out, /Kept existing core\.hooksPath=\.husky/);
      assert.equal(mustRun("git", ["config", "--get", "core.hooksPath"], repo), ".husky");
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("supports --local-features by gitignoring features/ and avoiding current-feature.md tracking", () => {
    const fixture = createRepo("local-features");
    try {
      const { repo } = fixture;
      mustFeatflow(["init", "--local-features", "--with-codex-hooks", "--with-claude-hooks"], repo);
      const gitignore = readFileSync(path.join(repo, ".gitignore"), "utf8");
      assert.match(gitignore, /^features\/$/m);
      const cfg = JSON.parse(readFileSync(path.join(repo, ".featflow.json"), "utf8"));
      assert.equal(cfg.trackFeaturesInGit, false);
      assert.equal(existsSync(path.join(repo, ".codex", "config.toml")), true);
      assert.equal(existsSync(path.join(repo, ".claude", "settings.json")), true);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("runs postWorktreeCreate hooks, protects dirty/unmerged branches in cleanup, and validates plan-check CLI", () => {
    const fixture = createRepo("cleanup-and-plan");
    try {
      const { parent, repo } = fixture;
      mustFeatflow(["init", "--mode", "trunk"], repo);

      // Configure a portable postWorktreeCreate command
      const cfgPath = path.join(repo, ".featflow.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      cfg.postWorktreeCreate = [`node -e "require('node:fs').writeFileSync('.post-create-ok','ok')"`];
      writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

      mustRun("git", ["add", "."], repo);
      mustRun("git", ["commit", "-m", "chore: init"], repo);

      // Worktree runs postWorktreeCreate hook
      mustFeatflow(["worktree", "feat/hooked"], repo);
      const wtHooked = path.join(parent, "demo-repo-worktrees", "feat-hooked");
      assert.equal(existsSync(path.join(wtHooked, ".post-create-ok")), true);
      rmSync(path.join(wtHooked, ".post-create-ok"));

      // Keep feat/hooked unmerged; create a merged clean branch & a merged dirty branch
      writeFileSync(path.join(wtHooked, "open.txt"), "open\n");
      mustRun("git", ["add", "open.txt"], wtHooked);
      mustRun("git", ["commit", "-m", "feat: open"], wtHooked);

      mustRun("git", ["checkout", "-b", "fix/merged-clean"], repo);
      writeFileSync(path.join(repo, "clean.txt"), "clean\n");
      mustRun("git", ["add", "clean.txt"], repo);
      mustRun("git", ["commit", "-m", "fix: clean"], repo);
      mustRun("git", ["checkout", "main"], repo);
      mustRun("git", ["merge", "--no-ff", "--no-edit", "fix/merged-clean"], repo);
      const wtClean = path.join(parent, "demo-repo-worktrees", "wt-clean");
      mustRun("git", ["worktree", "add", wtClean, "fix/merged-clean"], repo);

      mustRun("git", ["checkout", "-b", "fix/merged-dirty"], repo);
      writeFileSync(path.join(repo, "dirty.txt"), "dirty\n");
      mustRun("git", ["add", "dirty.txt"], repo);
      mustRun("git", ["commit", "-m", "fix: dirty"], repo);
      mustRun("git", ["checkout", "main"], repo);
      mustRun("git", ["merge", "--no-ff", "--no-edit", "fix/merged-dirty"], repo);
      const wtDirty = path.join(parent, "demo-repo-worktrees", "wt-dirty");
      mustRun("git", ["worktree", "add", wtDirty, "fix/merged-dirty"], repo);
      writeFileSync(path.join(wtDirty, "untracked.txt"), "keep\n");

      mustFeatflow(["cleanup"], repo);

      assert.equal(branchExists(repo, "fix/merged-clean"), false);
      assert.equal(existsSync(wtClean), false);
      assert.equal(branchExists(repo, "fix/merged-dirty"), true);
      assert.equal(existsSync(wtDirty), true);
      assert.equal(branchExists(repo, "feat/hooked"), true);

      // status and plan-check CLI
      const statusOut = mustFeatflow(["status"], repo);
      assert.match(statusOut, /Mode: trunk/);

      const rawTemplate = readFileSync(path.join(repo, "features", "_template.md"), "utf8");
      writeFileSync(path.join(repo, "features", "active", "2026-06-15-1000-bad.md"), rawTemplate);
      const badPlan = featflow(["plan-check"], repo);
      assert.notEqual(badPlan.status, 0);
      assert.match(badPlan.stderr, /Feature plan check failed/);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("prompts interactively for developer branch name on TTY and fails cleanly in non-TTY mode", () => {
    const fixture = createRepo("setup-interactive", { withDev: true });
    try {
      const { repo } = fixture;
      mustFeatflow(["init", "--mode", "developer-branch", "--with-githooks"], repo);

      // Non-TTY without branch name fails cleanly and suggests user.name slug
      const nonTty = featflow(["setup", "--local-only"], repo);
      assert.notEqual(nonTty.status, 0);
      assert.match(nonTty.stderr, /featflow setup alice/);

      // Interactive TTY accepting default suggestion (Enter)
      const acceptedDefault = mustFeatflow(["setup", "--local-only"], repo, {
        env: { FEATFLOW_FORCE_TTY: "1" },
        input: "\n",
      });
      assert.match(acceptedDefault, /Personal developer branch name \[alice\]:/);
      assert.equal(mustRun("git", ["config", "--get", "featflow.developerBranch"], repo), "alice");
      assert.equal(branchExists(repo, "alice"), true);

      // Interactive TTY entering a custom developer branch name
      const customChoice = mustFeatflow(["setup", "--local-only"], repo, {
        env: { FEATFLOW_FORCE_TTY: "1" },
        input: "bob\n",
      });
      assert.match(customChoice, /Personal developer branch name \[alice\]:/);
      assert.equal(mustRun("git", ["config", "--get", "featflow.developerBranch"], repo), "bob");
      assert.equal(branchExists(repo, "bob"), true);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });
});
