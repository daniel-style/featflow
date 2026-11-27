import path from "node:path";

import { loadConfig, resolveWorktreeParent } from "../config.mjs";
import {
  ensureCleanWorktree,
  fail,
  findWorktreeForBranch,
  gitConfigGet,
  gitWorktrees,
  isInsidePath,
  localBranchExists,
  remoteExists,
  remoteTrackingBranchExists,
  runWrite,
  sanitizeBranchForDir,
  validateTaskBranchName,
} from "../git.mjs";
import { setupInstructions } from "../policy.mjs";
import { cleanupMergedTaskBranches } from "./cleanup.mjs";

const usage = `
Usage:
  featflow finish <task-branch> [options]

Completes a verified task branch:
  - In developer-branch mode: merges into your personal developer branch,
    pushes it (unless --no-push or offline), and removes the clean task worktree & branch.
  - In trunk mode (finishTarget=merge): merges into baseBranch, pushes if remote exists
    (unless --no-push), and removes the clean task worktree & branch.
  - In trunk mode (finishTarget=pr or --pr): pushes the task branch so you can open a PR,
    keeping the worktree until "featflow pr-cleanup <pr>" runs after merge.

Options:
  --developer <branch>   Override configured developer branch.
  --remote <name>        Remote to fetch/push. Defaults to config.remote.
  --worktree <path>      Override the task worktree path.
  --pr                   Push task branch for a pull request instead of merging locally.
  --no-push              Skip fetching from and pushing to the remote.
  --dry-run              Print mutating commands without running them.
  --keep-worktree        Do not remove the task worktree.
  --keep-branch          Do not delete the local task branch.
  -h, --help             Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    developer: "",
    dryRun: false,
    keepBranch: false,
    keepWorktree: false,
    noPush: false,
    pr: false,
    remote: "",
    taskBranch: "",
    worktree: "",
  };
  const positional = [];

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
    if (arg === "--no-push") {
      options.noPush = true;
      continue;
    }
    if (arg === "--pr") {
      options.pr = true;
      continue;
    }
    if (arg === "--keep-worktree") {
      options.keepWorktree = true;
      continue;
    }
    if (arg === "--keep-branch") {
      options.keepBranch = true;
      continue;
    }
    if (arg === "--developer" || arg === "--remote" || arg === "--worktree") {
      options[arg.slice(2)] = argv[++i] ?? "";
      continue;
    }
    if (arg.startsWith("--developer=") || arg.startsWith("--remote=") || arg.startsWith("--worktree=")) {
      const idx = arg.indexOf("=");
      options[arg.slice(2, idx)] = arg.slice(idx + 1);
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`, usage);
    }
    positional.push(arg);
  }

  if (positional.length !== 1) {
    fail("Expected exactly one task branch name.", usage);
  }
  options.taskBranch = positional[0];
  return options;
}

function ensureTargetWorktree(repoRoot, config, targetBranch, options) {
  let worktrees = gitWorktrees(repoRoot);
  let targetWorktree = findWorktreeForBranch(worktrees, targetBranch);
  if (targetWorktree) {
    return targetWorktree;
  }

  const parent = resolveWorktreeParent(repoRoot, config);
  const worktreePath = path.join(parent, sanitizeBranchForDir(targetBranch));
  runWrite("git", ["worktree", "add", worktreePath, targetBranch], repoRoot, options);
  if (options.dryRun) {
    return { path: worktreePath, dryRunMissing: true };
  }
  worktrees = gitWorktrees(repoRoot);
  targetWorktree = findWorktreeForBranch(worktrees, targetBranch);
  if (!targetWorktree) {
    throw new Error(`Could not find worktree for ${targetBranch} after creating ${worktreePath}.`);
  }
  return targetWorktree;
}

export async function runFinish(argv) {
  const options = parseArgs(argv);
  const { config, repoRoot } = loadConfig(process.cwd());
  const remote = options.remote || config.remote;

  try {
    validateTaskBranchName(options.taskBranch, repoRoot, new Set(config.protectedBranches));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (!localBranchExists(options.taskBranch, repoRoot)) {
    fail(`Local task branch "${options.taskBranch}" does not exist.`);
  }

  const taskWorktree = options.worktree
    ? { path: path.resolve(options.worktree) }
    : findWorktreeForBranch(gitWorktrees(repoRoot), options.taskBranch);

  if (taskWorktree) {
    ensureCleanWorktree(taskWorktree.path, "task");
  }

  const hasRemote = !options.noPush && remoteExists(remote, repoRoot);

  // PR-based finish (trunk + pr strategy or explicit --pr)
  if (options.pr || (config.mode === "trunk" && config.finishTarget === "pr")) {
    const pushCwd = taskWorktree?.path ?? repoRoot;
    if (hasRemote) {
      runWrite("git", ["push", "-u", remote, options.taskBranch], pushCwd, { dryRun: options.dryRun });
    }
    const base = config.mode === "developer-branch" ? config.integrationBranch : config.baseBranch;
    console.log(`Task branch ready for pull request: ${options.taskBranch}`);
    console.log(`Open PR: gh pr create --base ${base} --head ${options.taskBranch}`);
    console.log("After merge, clean up locally with: featflow pr-cleanup <pr-number>");
    return;
  }

  let targetBranch = config.baseBranch;
  let developerBranch = "";

  if (config.mode === "developer-branch") {
    developerBranch = options.developer || gitConfigGet(config.developerBranchConfigKey, repoRoot);
    if (!developerBranch) {
      fail(setupInstructions(config));
    }
    targetBranch = developerBranch;
  }

  if (options.taskBranch === targetBranch) {
    fail(`Task branch and target branch (${targetBranch}) must be different.`);
  }
  if (!localBranchExists(targetBranch, repoRoot)) {
    fail(`Local target branch "${targetBranch}" does not exist.`);
  }

  const targetWorktree = ensureTargetWorktree(repoRoot, config, targetBranch, { dryRun: options.dryRun });
  if (!targetWorktree.dryRunMissing) {
    ensureCleanWorktree(targetWorktree.path, "target");
  }

  const internalEnv = config.mode === "trunk" ? { FEATFLOW_INTERNAL_FINISH: "1" } : undefined;

  if (hasRemote) {
    runWrite("git", ["fetch", remote, targetBranch], targetWorktree.path, { dryRun: options.dryRun });
    if (remoteTrackingBranchExists(remote, targetBranch, targetWorktree.path)) {
      runWrite("git", ["merge", "--ff-only", `${remote}/${targetBranch}`], targetWorktree.path, {
        dryRun: options.dryRun,
        env: internalEnv,
      });
    }
  }

  // Move out of task worktree BEFORE merging so post-merge hooks & worktree removal succeed
  if (taskWorktree && !options.keepWorktree && isInsidePath(process.cwd(), taskWorktree.path)) {
    process.chdir(targetWorktree.path);
  }

  runWrite("git", ["merge", "--no-edit", options.taskBranch], targetWorktree.path, {
    dryRun: options.dryRun,
    env: internalEnv,
  });

  if (hasRemote) {
    runWrite("git", ["push", remote, targetBranch], targetWorktree.path, {
      dryRun: options.dryRun,
      env: internalEnv,
    });
  }

  const remainingTaskWorktree = findWorktreeForBranch(gitWorktrees(targetWorktree.path), options.taskBranch);
  if (remainingTaskWorktree && !options.keepWorktree) {
    if (isInsidePath(process.cwd(), remainingTaskWorktree.path)) {
      process.chdir(targetWorktree.path);
    }
    runWrite("git", ["worktree", "remove", remainingTaskWorktree.path], targetWorktree.path, {
      dryRun: options.dryRun,
    });
  }

  if (!options.keepBranch && localBranchExists(options.taskBranch, targetWorktree.path)) {
    runWrite("git", ["branch", "-d", options.taskBranch], targetWorktree.path, { dryRun: options.dryRun });
  }

  cleanupMergedTaskBranches({
    cwd: targetWorktree.path,
    config,
    targetBranch,
    developerBranch,
    dryRun: options.dryRun,
    excludeBranches: options.keepBranch || options.keepWorktree ? [options.taskBranch] : [],
  });

  const prefix = options.dryRun ? "Dry run complete:" : "Target branch updated:";
  const suffix = hasRemote ? "" : " (local only)";
  console.log(`${prefix} ${targetBranch}${suffix}`);
  if (config.mode === "developer-branch") {
    console.log(
      `No PR was opened. Create a PR to ${config.integrationBranch} only when ${targetBranch} is ready for team integration.`,
    );
  }
}
