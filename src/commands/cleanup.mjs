import { loadConfig } from "../config.mjs";
import {
  currentBranch,
  fail,
  findWorktreeForBranch,
  gitConfigGet,
  gitWorktrees,
  isAncestor,
  isInsidePath,
  isTaskBranch,
  localBranches,
  localBranchExists,
  runWrite,
  statusShort,
} from "../git.mjs";
import { setupInstructions } from "../policy.mjs";

const usage = `
Usage:
  featflow cleanup [options]

Removes local task branches and their clean worktrees once the branch tip is
already merged into the target base branch (developer branch in developer-branch
mode, or baseBranch in trunk mode). Never removes protected branches, unmerged
branches, dirty worktrees, or another developer's task branches.

Options:
  --developer <branch>   Override configured developer branch.
  --dry-run              Print mutating commands without running them.
  --post-merge           Run as a best-effort post-merge hook; only acts on the target branch.
  -h, --help             Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    developer: "",
    dryRun: false,
    postMerge: false,
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
    if (arg === "--post-merge") {
      options.postMerge = true;
      continue;
    }
    if (arg === "--developer") {
      options.developer = argv[++i] ?? "";
      continue;
    }
    if (arg.startsWith("--developer=")) {
      options.developer = arg.slice("--developer=".length);
      continue;
    }
    fail(`Unknown option: ${arg}`, usage);
  }

  return options;
}

export function cleanupMergedTaskBranches({
  cwd,
  config,
  targetBranch,
  developerBranch = "",
  dryRun = false,
  excludeBranches = [],
  quiet = false,
}) {
  const current = currentBranch(cwd);
  const excluded = new Set(excludeBranches);
  const protectedSet = new Set(config.protectedBranches);
  const result = {
    errors: [],
    removedBranches: [],
    removedWorktrees: [],
    skipped: [],
  };

  for (const taskBranch of localBranches(cwd)) {
    if (
      taskBranch === targetBranch ||
      taskBranch === current ||
      excluded.has(taskBranch) ||
      protectedSet.has(taskBranch) ||
      !isTaskBranch(taskBranch, config, developerBranch)
    ) {
      continue;
    }

    if (!isAncestor(taskBranch, targetBranch, cwd)) {
      continue;
    }

    const worktree = findWorktreeForBranch(gitWorktrees(cwd), taskBranch);
    if (worktree) {
      if (isInsidePath(process.cwd(), worktree.path)) {
        result.skipped.push({ branch: taskBranch, reason: "current-worktree", detail: worktree.path });
        continue;
      }

      const status = statusShort(worktree.path);
      if (status) {
        result.skipped.push({
          branch: taskBranch,
          reason: "dirty-worktree",
          detail: `${worktree.path}\n${status}`,
        });
        continue;
      }

      try {
        runWrite("git", ["worktree", "remove", worktree.path], cwd, { dryRun });
        result.removedWorktrees.push({ branch: taskBranch, path: worktree.path });
      } catch (error) {
        result.errors.push({
          action: "worktree-remove",
          branch: taskBranch,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    if (!localBranchExists(taskBranch, cwd)) {
      continue;
    }

    try {
      runWrite("git", ["branch", "-d", taskBranch], cwd, { dryRun });
      result.removedBranches.push(taskBranch);
    } catch (error) {
      result.errors.push({
        action: "branch-delete",
        branch: taskBranch,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!quiet) {
    printCleanupSummary(result, { dryRun });
  }

  return result;
}

function printCleanupSummary(result, { dryRun = false } = {}) {
  const prefix = dryRun ? "Would clean" : "Cleaned";
  for (const item of result.removedWorktrees) {
    console.log(`${prefix} worktree for ${item.branch}: ${item.path}`);
  }
  for (const branch of result.removedBranches) {
    console.log(`${prefix} merged task branch: ${branch}`);
  }
  for (const item of result.skipped) {
    if (item.reason === "dirty-worktree") {
      console.error(`Skipped ${item.branch}: worktree is dirty.\n${item.detail}`);
    } else if (item.reason === "current-worktree") {
      console.error(`Skipped ${item.branch}: current process is inside ${item.detail}`);
    } else {
      console.error(`Skipped ${item.branch}: ${item.reason}`);
    }
  }
  for (const item of result.errors) {
    console.error(`Failed to ${item.action} for ${item.branch}: ${item.message}`);
  }

  if (
    result.removedBranches.length === 0 &&
    result.removedWorktrees.length === 0 &&
    result.skipped.length === 0 &&
    result.errors.length === 0
  ) {
    console.log("No merged local task branches to clean.");
  }
}

export async function runCleanup(argv) {
  const options = parseArgs(argv);
  const { config, repoRoot } = loadConfig(process.cwd());

  let targetBranch = config.baseBranch;
  let developerBranch = "";

  if (config.mode === "developer-branch") {
    developerBranch = options.developer || gitConfigGet(config.developerBranchConfigKey, repoRoot);
    if (options.postMerge) {
      if (!developerBranch || currentBranch(repoRoot) !== developerBranch) {
        return;
      }
    } else if (!developerBranch) {
      fail(setupInstructions(config));
    }
    targetBranch = developerBranch;
  } else if (options.postMerge) {
    if (currentBranch(repoRoot) !== config.baseBranch) {
      return;
    }
  }

  const result = cleanupMergedTaskBranches({
    cwd: repoRoot,
    config,
    targetBranch,
    developerBranch,
    dryRun: options.dryRun,
  });

  if (!options.postMerge && result.errors.length > 0) {
    process.exit(1);
  }
}
