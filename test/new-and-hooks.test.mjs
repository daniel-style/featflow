import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../src/config.mjs";

const CLI = path.join(packageRoot, "bin", "featflow.mjs");
const BIN_DIR = path.join(packageRoot, "bin");
const emptyGitConfig = process.platform === "win32" ? "NUL" : "/dev/null";

function run(command, args, cwd, extra = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
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

function featflow(args, cwd, extra = {}) {
  return run(process.execPath, [CLI, ...args], cwd, extra);
}

function createBareRepo(name) {
  const parent = mkdtempSync(path.join(tmpdir(), `featflow-global-${name}-`));
  const repo = path.join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  mustRun("git", ["init", "-b", "main"], repo);
  mustRun("git", ["config", "user.name", "Alice Tester"], repo);
  mustRun("git", ["config", "user.email", "alice@example.test"], repo);
  writeFileSync(path.join(repo, "README.md"), "# zero-footprint demo\n");
  mustRun("git", ["add", "."], repo);
  mustRun("git", ["commit", "-m", "initial"], repo);
  return { parent, repo };
}

describe("global zero-footprint workflows: featflow new & featflow hooks", () => {
  it("creates a local-only feature record without featflow init and keeps git status clean", () => {
    const fixture = createBareRepo("new-local");
    try {
      const { repo } = fixture;
      mustRun("git", ["checkout", "-b", "feat/oauth-login"], repo);

      const res = featflow(["new", "oauth-login", "--local"], repo);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /Created feature record: \.featflow\/features\/active\/\d{4}-\d{2}-\d{2}-\d{4}-oauth-login\.md/);

      // Git status MUST be completely clean (zero tracked files, excluded via .git/info/exclude)
      assert.equal(mustRun("git", ["status", "--short"], repo), "");
      const exclude = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
      assert.match(exclude, /^\.featflow\/$/m);

      // Verify auto-populated frontmatter
      const activeDir = path.join(repo, ".featflow", "features", "active");
      const files = readdirSync(activeDir).filter((f) => f.endsWith(".md"));
      assert.equal(files.length, 1);
      const content = readFileSync(path.join(activeDir, files[0]), "utf8");
      assert.match(content, /^title: Oauth Login$/m);
      assert.match(content, /^owner: Alice Tester$/m);
      assert.match(content, /^branch: feat\/oauth-login$/m);
      assert.doesNotMatch(content, /GIT_USER_NAME/);

      // status and plan-check automatically discover .featflow/features/active/
      const statusRes = featflow(["status"], repo);
      assert.equal(statusRes.status, 0);
      assert.match(statusRes.stdout, /\.featflow[\\/]features[\\/]active/);

      const checkRes = featflow(["plan-check"], repo);
      assert.equal(checkRes.status, 1); // still has body placeholders until AI fills them
      assert.match(checkRes.stderr, /oauth-login\.md/);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("creates tracked feature & program records from built-in template and prints templates via --template", () => {
    const fixture = createBareRepo("new-tracked");
    try {
      const { repo } = fixture;

      const tplOut = featflow(["new", "--template"], repo);
      assert.equal(tplOut.status, 0);
      assert.match(tplOut.stdout, /# Feature Brief/);

      const progRes = featflow(["new", "platform-v2", "--program", "--title", "Platform V2 Migration"], repo);
      assert.equal(progRes.status, 0, progRes.stderr);
      const programsDir = path.join(repo, "features", "programs");
      const files = readdirSync(programsDir).filter((f) => f.endsWith(".md"));
      assert.equal(files.length, 1);
      const progContent = readFileSync(path.join(programsDir, files[0]), "utf8");
      assert.match(progContent, /^title: Platform V2 Migration$/m);
      assert.match(progContent, /^owner: Alice Tester$/m);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("installs local .git/hooks non-destructively, preserves existing custom hooks, is idempotent, and uninstalls cleanly", () => {
    const fixture = createBareRepo("local-hooks");
    try {
      const { repo } = fixture;
      const hooksDir = path.join(repo, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });

      // Pre-existing custom pre-commit hook must be preserved!
      const customPreCommit = path.join(hooksDir, "pre-commit");
      writeFileSync(customPreCommit, "#!/usr/bin/env sh\necho custom-hook-ok\n");
      chmodSync(customPreCommit, 0o755);

      // Install local hooks twice (idempotent)
      assert.equal(featflow(["hooks", "install", "--local"], repo).status, 0);
      assert.equal(featflow(["hooks", "install", "--local"], repo).status, 0);

      // Zero tracked files modified
      assert.equal(mustRun("git", ["status", "--short"], repo), "");

      const installedPreCommit = readFileSync(customPreCommit, "utf8");
      assert.match(installedPreCommit, /echo custom-hook-ok/);
      const blockCount = (installedPreCommit.match(/# >>> featflow managed hook >>>/g) ?? []).length;
      assert.equal(blockCount, 1, "should not duplicate managed hook block on re-run");

      // Status & doctor recognize local hooks
      const hookStatus = featflow(["hooks", "status"], repo);
      assert.equal(hookStatus.status, 0);
      assert.match(hookStatus.stdout, /Local \.git\/hooks managed blocks: pre-commit, pre-push, post-merge/);

      const doctorOut = featflow(["doctor"], repo);
      assert.match(doctorOut.stdout, /\[PASS\] Git hooks: local \.git\/hooks managed blocks installed/);

      // Uninstall removes featflow blocks while preserving custom pre-commit and deleting featflow-only pre-push
      assert.equal(featflow(["hooks", "uninstall", "--local"], repo).status, 0);
      assert.equal(existsSync(customPreCommit), true);
      assert.equal(readFileSync(customPreCommit, "utf8").trim(), "#!/usr/bin/env sh\necho custom-hook-ok");
      assert.equal(existsSync(path.join(hooksDir, "pre-push")), false);
      assert.equal(existsSync(path.join(hooksDir, "post-merge")), false);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });

  it("warns instead of silently writing .git/hooks when core.hooksPath is already claimed (e.g. Husky)", () => {
    const fixture = createBareRepo("husky-warn");
    try {
      const { repo } = fixture;
      mustRun("git", ["config", "core.hooksPath", ".husky"], repo);

      const res = featflow(["hooks", "install", "--local"], repo);
      assert.equal(res.status, 0);
      assert.match(res.stderr, /core\.hooksPath is set to "\.husky"/);
      assert.equal(existsSync(path.join(repo, ".git", "hooks", "pre-commit")), false);
    } finally {
      rmSync(fixture.parent, { force: true, recursive: true });
    }
  });
});
