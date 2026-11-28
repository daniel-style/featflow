import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../src/config.mjs";
import {
  deriveBranchNameFromIssue,
  deriveBranchSpecFromIssue,
  extractIssueAssetPaths,
  formatIssueTitle,
  parseGitHubRepoFromRemoteUrl,
  parseIssueRef,
  parseIssueTitle,
  STANDARD_WORKFLOW_LABELS,
} from "../src/issues.mjs";

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

function createMockGh(binDir, stateFile) {
  mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "gh-mock.mjs");
  writeFileSync(
    scriptPath,
    `
import { readFileSync, writeFileSync } from "node:fs";

const stateFile = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);

function loadState() {
  return JSON.parse(readFileSync(stateFile, "utf8"));
}
function saveState(state) {
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
function readStdinSync() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
function flagValue(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? (args[idx + 1] ?? "") : "";
}
function flagValues(name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1] !== undefined) out.push(args[i + 1]);
  }
  return out;
}

if (args[0] === "--version") {
  console.log("gh version 2.60.0-mock");
  process.exit(0);
}

const state = loadState();

if (args[0] === "api") {
  if (args[1] === "user") {
    console.log(state.currentUser);
    process.exit(0);
  }
  if (args[1] === "-X" && args[2] === "PUT") {
    const endpoint = args[3];
    const body = JSON.parse(readStdinSync());
    const match = endpoint.match(/^repos\\/([^/]+\\/[^/]+)\\/contents\\/(.+)$/);
    if (!match) process.exit(1);
    state.assets[match[2]] = body.content;
    saveState(state);
    console.log(JSON.stringify({ content: { path: match[2] } }));
    process.exit(0);
  }
  const getMatch = args[1]?.match(/^repos\\/([^/]+\\/[^/]+)\\/contents\\/([^?]+)/);
  if (getMatch) {
    const content = state.assets[getMatch[2]];
    if (!content) {
      console.error("Not Found");
      process.exit(1);
    }
    console.log(JSON.stringify({ content }));
    process.exit(0);
  }
  process.exit(1);
}

if (args[0] === "label" && args[1] === "create") {
  const name = args[2];
  const repo = flagValue("-R");
  state.syncedLabels[repo] = state.syncedLabels[repo] ?? [];
  if (!state.syncedLabels[repo].includes(name)) state.syncedLabels[repo].push(name);
  saveState(state);
  process.exit(0);
}

if (args[0] === "issue") {
  const sub = args[1];
  const repo = flagValue("-R");
  state.issues[repo] = state.issues[repo] ?? [];

  if (sub === "create") {
    const title = flagValue("--title");
    const body = readStdinSync();
    const labels = flagValues("--label").map((name) => ({ name }));
    const num = state.nextNumber++;
    const url = \`https://github.com/\${repo}/issues/\${num}\`;
    state.issues[repo].push({
      number: num,
      title,
      body,
      state: "OPEN",
      url,
      author: { login: state.currentUser },
      labels,
      assignees: [],
      comments: [],
      createdAt: "2026-11-28T00:00:00Z",
      updatedAt: "2026-11-28T00:00:00Z",
    });
    saveState(state);
    console.log(url);
    process.exit(0);
  }

  if (sub === "list") {
    const list = state.issues[repo].filter((i) => {
      const wantState = flagValue("--state") || "open";
      if (wantState !== "all" && i.state.toLowerCase() !== wantState.toLowerCase()) return false;
      const wantLabels = flagValues("--label");
      const hasLabels = new Set(i.labels.map((l) => l.name));
      for (const l of wantLabels) if (!hasLabels.has(l)) return false;
      const wantAssignee = flagValue("--assignee");
      if (wantAssignee && !i.assignees.some((a) => a.login === wantAssignee)) return false;
      return true;
    });
    console.log(JSON.stringify(list));
    process.exit(0);
  }

  if (sub === "view") {
    const num = Number(args[2]);
    const found = state.issues[repo].find((i) => i.number === num);
    if (!found) {
      console.error("issue not found");
      process.exit(1);
    }
    console.log(JSON.stringify(found));
    process.exit(0);
  }

  if (sub === "edit") {
    const num = Number(args[2]);
    const found = state.issues[repo].find((i) => i.number === num);
    if (!found) process.exit(1);
    for (const login of flagValues("--add-assignee")) {
      if (!found.assignees.some((a) => a.login === login)) found.assignees.push({ login });
    }
    for (const login of flagValues("--remove-assignee")) {
      found.assignees = found.assignees.filter((a) => a.login !== login);
    }
    for (const name of flagValues("--add-label")) {
      if (!found.labels.some((l) => l.name === name)) found.labels.push({ name });
    }
    for (const name of flagValues("--remove-label")) {
      found.labels = found.labels.filter((l) => l.name !== name);
    }
    saveState(state);
    process.exit(0);
  }

  if (sub === "comment") {
    const num = Number(args[2]);
    const found = state.issues[repo].find((i) => i.number === num);
    if (!found) process.exit(1);
    found.comments.push({
      author: { login: state.currentUser },
      createdAt: "2026-11-28T00:01:00Z",
      body: readStdinSync(),
    });
    saveState(state);
    process.exit(0);
  }
}

console.error("Unhandled mock gh args: " + args.join(" "));
process.exit(1);
`,
  );

  const wrapper = path.join(binDir, "gh");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`);
  chmodSync(wrapper, 0o755);
}

describe("featflow GitHub Issues pure helpers", () => {
  it("parses GitHub remote URLs, issue refs, prefixed titles, branch names, and asset links", () => {
    assert.deepEqual(parseGitHubRepoFromRemoteUrl("git@github.com:acme/demo-app.git"), {
      owner: "acme",
      name: "demo-app",
      slug: "acme/demo-app",
    });
    assert.deepEqual(parseGitHubRepoFromRemoteUrl("https://github.com/acme/demo-app"), {
      owner: "acme",
      name: "demo-app",
      slug: "acme/demo-app",
    });
    assert.equal(parseGitHubRepoFromRemoteUrl("git@gitlab.com:acme/demo.git"), null);

    assert.deepEqual(parseIssueRef("#42", "acme/demo-app"), {
      owner: "acme",
      repoName: "demo-app",
      repoSlug: "acme/demo-app",
      number: 42,
      ref: "demo-app#42",
    });
    assert.deepEqual(parseIssueRef("https://github.com/acme/demo-app/issues/99"), {
      owner: "acme",
      repoName: "demo-app",
      repoSlug: "acme/demo-app",
      number: 99,
      ref: "demo-app#99",
    });

    assert.equal(formatIssueTitle("fix", "auth", "blank screen after login"), "fix(auth): blank screen after login");
    assert.equal(formatIssueTitle("feat", "", "feat(ui): add dark mode"), "feat(ui): add dark mode");
    assert.throws(() => formatIssueTitle("fix", "", "feat: mismatched"), /does not match --type/);

    assert.deepEqual(parseIssueTitle("docs(readme): refresh commands"), {
      type: "docs",
      scope: "readme",
      summary: "refresh commands",
    });

    const sampleIssue = { number: 12, title: "fix(auth): Login screen stays blank", labels: ["bug"] };
    assert.equal(deriveBranchSpecFromIssue(sampleIssue), "fix/issue-12-login-screen-stays-blank");
    assert.equal(
      deriveBranchNameFromIssue(sampleIssue, { mode: "trunk" }),
      "fix/issue-12-login-screen-stays-blank",
    );
    assert.equal(
      deriveBranchNameFromIssue(sampleIssue, { mode: "developer-branch", developer: "alice" }),
      "fix/alice-issue-12-login-screen-stays-blank",
    );
    assert.equal(
      deriveBranchNameFromIssue({ number: 19, title: "fix(auth): 登录页白屏问题", labels: ["bug"] }, { mode: "trunk" }),
      "fix/issue-19-auth",
    );

    const extracted = extractIssueAssetPaths(
      { repo: "acme/issue-assets", branch: "main", prefix: "assets" },
      ["See ![shot](https://github.com/acme/issue-assets/blob/main/assets/2026-11/demo-abc.png?raw=true)"],
    );
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].remotePath, "assets/2026-11/demo-abc.png");
    assert.deepEqual(extractIssueAssetPaths({ repo: null }, ["anything"]), []);
  });
});

describe("featflow issue CLI end-to-end", () => {
  it("runs full closed loop in developer-branch mode with screenshot upload/download, atomic claim preflight, collision lock, review, and release", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "featflow-issues-dev-"));
    try {
      const repoDir = path.join(tmp, "demo-app");
      const mockBinDir = path.join(tmp, "mock-bin");
      const stateFile = path.join(tmp, "gh-state.json");
      mkdirSync(repoDir, { recursive: true });

      mustRun("git", ["init", "-b", "alice"], repoDir);
      mustRun("git", ["config", "user.name", "Alice"], repoDir);
      mustRun("git", ["config", "user.email", "alice@example.test"], repoDir);
      mustRun("git", ["config", "featflow.developerBranch", "alice"], repoDir);
      mustRun("git", ["remote", "add", "origin", "git@github.com:acme/demo-app.git"], repoDir);
      writeFileSync(path.join(repoDir, "README.md"), "# demo\n");
      writeFileSync(
        path.join(repoDir, ".featflow.json"),
        JSON.stringify(
          {
            mode: "developer-branch",
            baseBranch: "dev",
            integrationBranch: "dev",
            protectedBranches: ["main", "dev"],
            developerBranchConfigKey: "featflow.developerBranch",
            issues: {
              provider: "github",
              assetsRepo: "acme/issue-assets",
              assetsBranch: "main",
              assetsPrefix: "assets",
            },
          },
          null,
          2,
        ),
      );
      mustRun("git", ["add", "."], repoDir);
      mustRun("git", ["commit", "-m", "initial"], repoDir);

      writeFileSync(
        stateFile,
        JSON.stringify({ currentUser: "alice", nextNumber: 10, issues: {}, assets: {}, syncedLabels: {} }, null, 2),
      );
      createMockGh(mockBinDir, stateFile);

      const env = { PATH: `${mockBinDir}${path.delimiter}${process.env.PATH ?? ""}` };

      // 1. labels:sync
      const synced = JSON.parse(mustRun(process.execPath, [CLI, "issue", "labels:sync", "--json"], repoDir, { env }));
      assert.equal(synced.repoSlug, "acme/demo-app");
      assert.equal(synced.labels.length, STANDARD_WORKFLOW_LABELS.length);

      // 2. create with local PNG attachment
      const pngBytes = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
      const shotPath = path.join(tmp, "Login Bug.png");
      writeFileSync(shotPath, pngBytes);

      const created = JSON.parse(
        mustRun(
          process.execPath,
          [
            CLI,
            "issue",
            "create",
            "--type",
            "fix",
            "--scope",
            "auth",
            "--title",
            "OAuth callback stays blank",
            "--body",
            "## Observed\nBlank screen.",
            "--attach",
            shotPath,
            "--priority",
            "p1",
            "--agent-ready",
            "--json",
          ],
          repoDir,
          { env },
        ),
      );
      assert.equal(created.ref, "demo-app#10");
      assert.equal(created.title, "fix(auth): OAuth callback stays blank");
      assert.deepEqual(created.labels, ["bug", "priority:p1", "agent-ready"]);
      assert.equal(created.uploadedAttachments.length, 1);

      // 3. list --unassigned
      const listed = JSON.parse(
        mustRun(process.execPath, [CLI, "issue", "list", "--unassigned", "--json"], repoDir, { env }),
      );
      assert.equal(listed.count, 1);
      assert.equal(listed.issues[0].ref, "demo-app#10");

      // 4. view --download-images recovers exact PNG bytes
      const downloadDir = path.join(tmp, "downloaded");
      const viewed = JSON.parse(
        mustRun(
          process.execPath,
          [CLI, "issue", "view", "10", "--download-images", "--out-dir", downloadDir, "--json"],
          repoDir,
          { env },
        ),
      );
      assert.equal(viewed.suggestedBranch, "fix/alice-issue-10-oauth-callback-stays-blank");
      assert.equal(viewed.downloadedImages.length, 1);
      assert.deepEqual(readFileSync(viewed.downloadedImages[0].localPath), pngBytes);

      // 5. Preflight failure (colliding target path) MUST NOT mutate GitHub state
      const collidingPath = path.join(tmp, "occupied-dir");
      mkdirSync(collidingPath, { recursive: true });
      const failedClaim = run(
        process.execPath,
        [CLI, "issue", "claim", "10", "--path", collidingPath, "--json"],
        repoDir,
        { env },
      );
      assert.notEqual(failedClaim.status, 0);
      assert.match(failedClaim.stderr, /already exists/);
      const stateAfterFailedPreflight = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.deepEqual(stateAfterFailedPreflight.issues["acme/demo-app"][0].assignees, []);

      // 6. Successful claim assigns alice, adds status:in-progress, and creates worktree
      const claimed = JSON.parse(mustRun(process.execPath, [CLI, "issue", "claim", "10", "--json"], repoDir, { env }));
      assert.equal(claimed.claimedBy, "alice");
      assert.equal(claimed.branch, "fix/alice-issue-10-oauth-callback-stays-blank");
      assert.equal(existsSync(claimed.worktree.worktreePath), true);

      // 7. Concurrent claim by bob is refused
      const stateAfterClaim = JSON.parse(readFileSync(stateFile, "utf8"));
      stateAfterClaim.currentUser = "bob";
      writeFileSync(stateFile, JSON.stringify(stateAfterClaim, null, 2));
      const conflict = run(process.execPath, [CLI, "issue", "claim", "10", "--no-worktree"], repoDir, { env });
      assert.notEqual(conflict.status, 0);
      assert.match(conflict.stderr, /already assigned to alice/);

      // 8. review transitions to status:in-review & notes integration branch "dev"
      stateAfterClaim.currentUser = "alice";
      writeFileSync(stateFile, JSON.stringify(stateAfterClaim, null, 2));
      const reviewed = JSON.parse(
        mustRun(
          process.execPath,
          [CLI, "issue", "review", "10", "--commit", "abc1234", "--summary", "Fixed OAuth callback", "--json"],
          repoDir,
          { env },
        ),
      );
      assert.equal(reviewed.status, "status:in-review");
      const afterReview = JSON.parse(mustRun(process.execPath, [CLI, "issue", "view", "10", "--json"], repoDir, { env }));
      assert.equal(afterReview.state, "OPEN");
      assert.equal(afterReview.labels.includes("status:in-review"), true);
      assert.equal(afterReview.labels.includes("status:in-progress"), false);
      assert.match(afterReview.comments.at(-1).body, /integrated into `dev`/);

      // 9. release --blocked
      mustRun(
        process.execPath,
        [CLI, "issue", "release", "10", "--blocked", "--reason", "Waiting for OAuth spec"],
        repoDir,
        { env },
      );
      const afterRelease = JSON.parse(mustRun(process.execPath, [CLI, "issue", "view", "10", "--json"], repoDir, { env }));
      assert.equal(afterRelease.labels.includes("status:blocked"), true);
      assert.deepEqual(afterRelease.assignees, []);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });

  it("supports trunk mode, graceful --attach error without assetsRepo, init --with-issues, sync, and user-prompt hook routing", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "featflow-issues-trunk-"));
    try {
      const repoDir = path.join(tmp, "trunk-app");
      const mockBinDir = path.join(tmp, "mock-bin");
      const stateFile = path.join(tmp, "gh-state.json");
      mkdirSync(repoDir, { recursive: true });

      mustRun("git", ["init", "-b", "main"], repoDir);
      mustRun("git", ["config", "user.name", "Alice"], repoDir);
      mustRun("git", ["config", "user.email", "alice@example.test"], repoDir);
      mustRun("git", ["remote", "add", "origin", "https://github.com/acme/trunk-app.git"], repoDir);
      writeFileSync(path.join(repoDir, "README.md"), "# trunk\n");
      mustRun("git", ["add", "."], repoDir);
      mustRun("git", ["commit", "-m", "initial"], repoDir);

      // init --with-issues scaffolds .featflow.json issues block + featflow-issues SKILL.md
      mustRun(process.execPath, [CLI, "init", "--yes", "--with-issues", "--no-hooks"], repoDir);
      const cfg = JSON.parse(readFileSync(path.join(repoDir, ".featflow.json"), "utf8"));
      assert.equal(cfg.issues.provider, "github");
      assert.equal(cfg.issues.assetsRepo, null);
      const issuesSkillPath = path.join(repoDir, ".agents", "skills", "featflow-issues", "SKILL.md");
      assert.equal(existsSync(issuesSkillPath), true);

      // sync --check passes, detects drift in featflow-issues skill, and repairs it
      mustRun(process.execPath, [CLI, "sync", "--check"], repoDir);
      writeFileSync(issuesSkillPath, "drifted skill\n");
      const drifted = run(process.execPath, [CLI, "sync", "--check", "--json"], repoDir);
      assert.equal(drifted.status, 1);
      assert.equal(JSON.parse(drifted.stdout).drifted.includes(".agents/skills/featflow-issues/SKILL.md"), true);
      mustRun(process.execPath, [CLI, "sync"], repoDir);
      mustRun(process.execPath, [CLI, "sync", "--check"], repoDir);

      // Hook routing: explicit filing/claiming prompt triggers featflow-issues; plain bug fix does NOT
      const filePrompt = run(process.execPath, [CLI, "hook", "claude-code", "user-prompt"], repoDir, {
        input: JSON.stringify({ prompt: "帮我根据截图提个 bug" }),
      });
      assert.equal(filePrompt.status, 0);
      assert.match(JSON.parse(filePrompt.stdout).hookSpecificOutput.additionalContext, /featflow-issues/);

      const directFixPrompt = run(process.execPath, [CLI, "hook", "claude-code", "user-prompt"], repoDir, {
        input: JSON.stringify({ prompt: "这个按钮歪了，帮我修复一下 bug" }),
      });
      assert.equal(directFixPrompt.status, 0);
      assert.doesNotMatch(JSON.parse(directFixPrompt.stdout).hookSpecificOutput.additionalContext, /featflow-issues/);

      // Mock gh for trunk create/claim/review
      writeFileSync(
        stateFile,
        JSON.stringify({ currentUser: "alice", nextNumber: 5, issues: {}, assets: {}, syncedLabels: {} }, null, 2),
      );
      createMockGh(mockBinDir, stateFile);
      const env = { PATH: `${mockBinDir}${path.delimiter}${process.env.PATH ?? ""}` };

      // --attach without assetsRepo fails cleanly with guidance
      const shotPath = path.join(tmp, "shot.png");
      writeFileSync(shotPath, Buffer.from("89504e470d0a1a0a", "hex"));
      const missingAssets = run(
        process.execPath,
        [CLI, "issue", "create", "--type", "fix", "--title", "broken", "--body", "details", "--attach", shotPath],
        repoDir,
        { env },
      );
      assert.notEqual(missingAssets.status, 0);
      assert.match(missingAssets.stderr, /issues\.assetsRepo/);

      // Pure-text create + claim creates trunk branch fix/issue-5-...
      const created = JSON.parse(
        mustRun(
          process.execPath,
          [CLI, "issue", "create", "--type", "feat", "--title", "Add dark mode", "--body", "Need dark theme", "--json"],
          repoDir,
          { env },
        ),
      );
      assert.equal(created.ref, "trunk-app#5");

      const claimed = JSON.parse(mustRun(process.execPath, [CLI, "issue", "claim", "#5", "--json"], repoDir, { env }));
      assert.equal(claimed.branch, "feat/issue-5-add-dark-mode");
      assert.equal(existsSync(claimed.worktree.worktreePath), true);

      const reviewed = JSON.parse(
        mustRun(
          process.execPath,
          [CLI, "issue", "review", "5", "--summary", "Implemented dark mode", "--json"],
          repoDir,
          { env },
        ),
      );
      assert.equal(reviewed.status, "status:in-review");
      const viewed = JSON.parse(mustRun(process.execPath, [CLI, "issue", "view", "5", "--json"], repoDir, { env }));
      assert.match(viewed.comments.at(-1).body, /integrated into `main`/);
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  });
});
