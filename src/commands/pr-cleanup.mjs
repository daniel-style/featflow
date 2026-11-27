import path from "node:path";

import { loadConfig } from "../config.mjs";
import {
  ensureCleanWorktree,
  fail,
  findWorktreeForBranch,
  findWorktreeForPath,
  gitWorktrees,
  isAncestor,
  isInsidePath,
  localBranchExists,
  remoteBranchExists,
  runRead,
  runWrite,
} from "../git.mjs";

const usage = `
Usage:
  featflow pr-cleanup <pr-number|pr-url|branch> [options]

For pull requests already merged on GitHub (via "gh" CLI). Syncs the local
base branch, removes the clean PR worktree, deletes the local branch (checking
HEAD matches the merged PR head), deletes the remote branch if still present,
and runs "git fetch --prune".

Options:
  --base <branch>                 Require PR to target this specific base branch.
  --worktree <path>               Override the feature worktree path.
  --branch <name>                 Override the PR head branch name.
  --remote <name>                 Remote to prune/delete from. Defaults to config.remote.
  --dry-run                       Print mutating commands without running them.
  --skip-remote-delete            Do not delete the remote branch if it still exists.
  --force-local-branch-delete     Delete local branch even if HEAD differs from PR head.
  -h, --help                      Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    base: "",
    branch: "",
    dryRun: false,
    forceLocalBranchDelete: false,
    prRef: "",
    remote: "",
    skipRemoteDelete: false,
    worktree: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--skip-remote-delete") {
      options.skipRemoteDelete = true;
      continue;
    }
    if (arg === "--force-local-branch-delete") {
      options.forceLocalBranchDelete = true;
      continue;
    }
    if (["--base", "--worktree", "--branch", "--remote"].includes(arg)) {
      const value = argv[++i] ?? "";
      if (!value) {
        fail(`Missing value for ${arg}.`, usage);
      }
      options[arg.slice(2)] = value;
      continue;
    }
    if (/^--(?:base|worktree|branch|remote)=/.test(arg)) {
      const idx = arg.indexOf("=");
      options[arg.slice(2, idx)] = arg.slice(idx + 1);
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`, usage);
    }
    if (options.prRef) {
      fail(`Unexpected extra argument: ${arg}`, usage);
    }
    options.prRef = arg;
  }

  if (!options.prRef) {
    fail("Missing PR number, PR URL, or branch.", usage);
  }
  return options;
}

function shortOid(oid) {
  return oid ? oid.slice(0, 12) : "unknown";
}

export async function runPrCleanup(argv) {
  const options = parseArgs(argv);
  const { config, repoRoot } = loadConfig(process.cwd());
  const remote = options.remote || config.remote;
  const startCwd = process.cwd();
  const initialWorktrees = gitWorktrees(repoRoot);

  const pr = JSON.parse(
    runRead(
      "gh",
      [
        "pr",
        "view",
        options.prRef,
        "--json",
        "number,state,mergedAt,mergeCommit,headRefName,headRefOid,baseRefName,url",
      ],
      repoRoot,
    ),
  );

  if (pr.state !== "MERGED") {
    fail(`PR ${options.prRef} is ${pr.state}, not MERGED. Cleanup is only safe after merge.`);
  }
  if (options.base && pr.baseRefName !== options.base) {
    fail(`PR #${pr.number} targets ${pr.baseRefName}, expected ${options.base}.`);
  }

  const baseBranch = pr.baseRefName;
  const baseWorktree = findWorktreeForBranch(initialWorktrees, baseBranch);
  if (!baseWorktree) {
    fail(`Could not find a local worktree checked out on "${baseBranch}".`);
  }

  ensureCleanWorktree(baseWorktree.path, baseBranch);

  const branchName = options.branch || pr.headRefName;
  const expectedHeadOid = pr.headRefOid;
  const mergeCommitOid = pr.mergeCommit?.oid;
  const targetWorktree = options.worktree
    ? (findWorktreeForPath(initialWorktrees, options.worktree) ?? { path: path.resolve(options.worktree) })
    : findWorktreeForBranch(initialWorktrees, branchName);

  console.log(`Cleaning local state for merged PR #${pr.number}: ${pr.url}`);
  console.log(`Head branch: ${branchName} -> Base branch: ${baseBranch}`);
  console.log(`Merged at: ${pr.mergedAt}`);

  if (targetWorktree && isInsidePath(startCwd, targetWorktree.path)) {
    process.chdir(baseWorktree.path);
  }

  runWrite("git", ["switch", baseBranch], baseWorktree.path, { dryRun: options.dryRun });
  runWrite("git", ["pull", "--ff-only", remote, baseBranch], baseWorktree.path, { dryRun: options.dryRun });

  if (!options.dryRun && mergeCommitOid && !isAncestor(mergeCommitOid, "HEAD", baseWorktree.path)) {
    fail(`Local ${baseBranch} does not contain merge commit ${mergeCommitOid}. Pull before cleanup.`);
  }

  if (targetWorktree) {
    ensureCleanWorktree(targetWorktree.path, "PR");
    runWrite("git", ["worktree", "remove", targetWorktree.path], baseWorktree.path, { dryRun: options.dryRun });
  } else {
    console.log(`No local worktree found for branch ${branchName}; skipping worktree removal.`);
  }

  if (localBranchExists(branchName, baseWorktree.path)) {
    const localBranchOid = runRead("git", ["rev-parse", branchName], baseWorktree.path);
    if (expectedHeadOid && localBranchOid !== expectedHeadOid && !options.forceLocalBranchDelete) {
      fail(
        [
          `Refusing to delete local branch ${branchName} because it no longer matches PR head ${shortOid(expectedHeadOid)}.`,
          `Local branch is at ${shortOid(localBranchOid)}.`,
          "Pass --force-local-branch-delete only after confirming those local commits are disposable.",
        ].join("\n"),
      );
    }
    runWrite("git", ["branch", "-D", branchName], baseWorktree.path, { dryRun: options.dryRun });
  } else {
    console.log(`No local branch ${branchName} found; skipping local branch deletion.`);
  }

  if (!options.skipRemoteDelete) {
    if (remoteBranchExists(remote, branchName, baseWorktree.path)) {
      runWrite("git", ["push", remote, "--delete", branchName], baseWorktree.path, { dryRun: options.dryRun });
    } else {
      console.log(`Remote branch ${remote}/${branchName} is already absent.`);
    }
  }

  runWrite("git", ["fetch", "--prune", remote], baseWorktree.path, { dryRun: options.dryRun });

  const currentTip = runRead("git", ["rev-parse", "--short", "HEAD"], baseWorktree.path);
  const prefix = options.dryRun ? "Dry run complete" : "Cleanup complete";
  console.log(`${prefix}: local ${baseBranch} is at ${currentTip}.`);
}
