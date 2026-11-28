import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { loadConfig, resolveWorktreeParent } from "../config.mjs";
import {
  fail,
  findWorktreeForBranch,
  formatCommand,
  gitConfigGet,
  gitWorktrees,
  localBranchExists,
  runWrite,
  sanitizeBranchForDir,
  validateTaskBranchName,
} from "../git.mjs";
import { setupInstructions } from "../policy.mjs";

const usage = `
Usage:
  featflow worktree <branch> [worktree-path] [base]
  featflow worktree <branch> --path <worktree-path> --base <base>

Creates a dedicated Git worktree for a typed task branch and runs any
configured postWorktreeCreate commands.

Options:
  --path <path>          Worktree directory path. Defaults to <worktreeParent>/<sanitized-branch>.
  --base <ref>           Base ref for a new branch. Defaults to developer branch or baseBranch.
  --skip-post-create     Skip running configured postWorktreeCreate commands.
  --dry-run              Print commands without executing them.
  -h, --help             Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    branch: "",
    path: "",
    base: "",
    baseProvided: false,
    skipPostCreate: false,
    dryRun: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--skip-post-create") {
      options.skipPostCreate = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--path" || arg === "--base") {
      const value = argv[++i] ?? "";
      if (!value) {
        fail(`Missing value for ${arg}.`, usage);
      }
      options[arg.slice(2)] = value;
      if (arg === "--base") {
        options.baseProvided = true;
      }
      continue;
    }
    if (arg.startsWith("--path=") || arg.startsWith("--base=")) {
      const idx = arg.indexOf("=");
      const key = arg.slice(2, idx);
      const value = arg.slice(idx + 1);
      if (!value) {
        fail(`Missing value for --${key}.`, usage);
      }
      options[key] = value;
      if (key === "base") {
        options.baseProvided = true;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`, usage);
    }
    positional.push(arg);
  }

  if (positional.length > 3) {
    fail(`Unexpected extra argument: ${positional[3]}`, usage);
  }
  options.branch = positional[0] ?? "";
  options.path = options.path || positional[1] || "";
  if (positional[2]) {
    options.base = positional[2];
    options.baseProvided = true;
  }

  if (!options.branch) {
    fail("Missing branch name.", usage);
  }

  return options;
}

function runCapturedWrite(command, args, cwd, options = {}) {
  if (options.dryRun) {
    return;
  }
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: options.shell ?? false,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  if (result.error) {
    throw new Error(`${formatCommand(command, args)} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${String(result.status)}`).trim();
    throw new Error(`${formatCommand(command, args)} failed:\n${detail}`);
  }
}

export function preflightTaskWorktree(repoRoot, config, options = {}) {
  const branch = String(options.branch ?? "").trim();
  if (!branch) {
    throw new Error("Missing branch name.");
  }

  validateTaskBranchName(branch, repoRoot, new Set(config.protectedBranches));

  let baseRef = options.base || "";
  if (!options.baseProvided) {
    if (config.mode === "developer-branch") {
      baseRef = gitConfigGet(config.developerBranchConfigKey, repoRoot);
      if (!baseRef) {
        throw new Error(setupInstructions(config));
      }
    } else {
      baseRef = config.baseBranch;
    }
  }

  const existingWorktree = findWorktreeForBranch(gitWorktrees(repoRoot), branch);
  if (existingWorktree) {
    throw new Error(`Branch "${branch}" is already checked out in worktree: ${existingWorktree.path}`);
  }

  const worktreeParent = resolveWorktreeParent(repoRoot, config);
  const worktreePath = path.resolve(
    options.path || path.join(worktreeParent, sanitizeBranchForDir(branch)),
  );
  if (existsSync(worktreePath)) {
    throw new Error(`Target worktree path already exists: ${worktreePath}`);
  }

  const branchExists = localBranchExists(branch, repoRoot);
  return { branch, baseRef, worktreePath, branchExists };
}

export function createTaskWorktree(repoRoot, config, options = {}, preflighted = null) {
  const plan = preflighted ?? preflightTaskWorktree(repoRoot, config, options);
  const execWrite = options.captureOutput ? runCapturedWrite : runWrite;

  if (!options.dryRun) {
    mkdirSync(path.dirname(plan.worktreePath), { recursive: true });
  }

  const addArgs = plan.branchExists
    ? ["worktree", "add", plan.worktreePath, plan.branch]
    : ["worktree", "add", "-b", plan.branch, plan.worktreePath, plan.baseRef];

  execWrite("git", addArgs, repoRoot, { dryRun: options.dryRun });

  if (!options.skipPostCreate && config.postWorktreeCreate.length > 0) {
    for (const cmd of config.postWorktreeCreate) {
      execWrite(cmd, [], plan.worktreePath, { dryRun: options.dryRun, shell: true });
    }
  }

  return {
    branch: plan.branch,
    baseRef: plan.branchExists ? "existing" : plan.baseRef,
    worktreePath: plan.worktreePath,
    branchExists: plan.branchExists,
  };
}

export async function runWorktree(argv) {
  const options = parseArgs(argv);
  const { config, repoRoot } = loadConfig(process.cwd());

  let result;
  try {
    result = createTaskWorktree(repoRoot, config, options);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  console.log(`Worktree ready: ${result.worktreePath}`);
  console.log(`Branch: ${result.branch} (base: ${result.baseRef})`);
}
