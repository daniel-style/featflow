import { loadConfig, resolveWorktreeParent } from "../config.mjs";
import {
  currentBranch,
  findWorktreeForBranch,
  gitConfigGet,
  gitWorktrees,
  localBranchExists,
  remoteBranchExists,
  remoteExists,
  remoteTrackingBranchExists,
} from "../git.mjs";
import { listFeatureFiles } from "../plan.mjs";
import { setupInstructions } from "../policy.mjs";

const usage = `
Usage:
  featflow status

Shows featflow mode, repository/branch state, worktrees, active feature records, and next step.
`.trim();

function yesNo(value) {
  return value ? "yes" : "no";
}

export async function runStatus(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(usage);
    return;
  }

  const { config, hasConfigFile, repoRoot } = loadConfig(process.cwd());
  const current = currentBranch(repoRoot);
  const worktrees = gitWorktrees(repoRoot);
  const hooksPath = gitConfigGet("core.hooksPath", repoRoot);
  const hasRemote = remoteExists(config.remote, repoRoot);

  console.log("featflow status");
  console.log(`Repository: ${repoRoot}`);
  console.log(`Config file: ${hasConfigFile ? ".featflow.json" : "(defaults — run featflow init)"}`);
  console.log(`Mode: ${config.mode}${config.mode === "trunk" ? ` (finishTarget: ${config.finishTarget})` : ""}`);
  console.log(`Current branch: ${current || "(detached)"}`);
  console.log(`Protected branches: ${config.protectedBranches.join(", ") || "(none)"}`);
  console.log(`Worktree parent: ${resolveWorktreeParent(repoRoot, config)}`);
  console.log(`Git hooks path: ${hooksPath || "(not configured)"}`);

  const activeFeatures = [
    ...listFeatureFiles(repoRoot, config.featuresDir, "active"),
    ...(config.featuresDir === ".featflow/features" ? [] : listFeatureFiles(repoRoot, ".featflow/features", "active")),
  ];
  const pausedFeatures = [
    ...listFeatureFiles(repoRoot, config.featuresDir, "paused"),
    ...(config.featuresDir === ".featflow/features" ? [] : listFeatureFiles(repoRoot, ".featflow/features", "paused")),
  ];
  console.log(`Active feature records: ${activeFeatures.length > 0 ? activeFeatures.join(", ") : "(none)"}`);
  if (pausedFeatures.length > 0) {
    console.log(`Paused feature records: ${pausedFeatures.join(", ")}`);
  }

  let targetBranch = config.baseBranch;
  if (config.mode === "developer-branch") {
    const devBranch = gitConfigGet(config.developerBranchConfigKey, repoRoot);
    console.log(`Configured developer branch: ${devBranch || "(not configured)"}`);
    if (hasRemote) {
      console.log(
        `Remote ${config.remote}/${config.integrationBranch}: ${yesNo(
          remoteBranchExists(config.remote, config.integrationBranch, repoRoot),
        )}`,
      );
    }
    if (!devBranch) {
      console.log("");
      console.log(setupInstructions(config));
      return;
    }
    targetBranch = devBranch;
    console.log(`Local developer branch: ${yesNo(localBranchExists(devBranch, repoRoot))}`);
    if (hasRemote) {
      console.log(`Tracking ref ${config.remote}/${devBranch}: ${yesNo(remoteTrackingBranchExists(config.remote, devBranch, repoRoot))}`);
    }
    const devWt = findWorktreeForBranch(worktrees, devBranch);
    console.log(`Developer worktree: ${devWt?.path ?? "(not checked out)"}`);
  }

  console.log(`Worktrees (${worktrees.length}):`);
  for (const wt of worktrees) {
    const label = wt.branch ? wt.branch.replace(/^refs\/heads\//, "") : "(detached)";
    console.log(`  - ${wt.path} [${label}]`);
  }

  console.log("");
  const protectedSet = new Set(config.protectedBranches);
  if (protectedSet.has(current)) {
    console.log(`Next step: create a task worktree from ${targetBranch} before editing tracked files.`);
  } else if (current === targetBranch) {
    console.log("Next step: create a typed task branch/worktree for the next task with `featflow worktree`.");
  } else {
    console.log(`Next step: finish this task with \`featflow finish ${current || "<task-branch>"}\`.`);
  }
}
