import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { loadConfig } from "../config.mjs";
import {
  fail,
  gitConfigGet,
  gitConfigSet,
  localBranchExists,
  remoteBranchExists,
  remoteExists,
  runWrite,
  validateDeveloperBranchName,
} from "../git.mjs";
import { configureGitHooksSafely } from "./hooks-cmd.mjs";

const usage = `
Usage:
  featflow setup [developer-branch] [options]

In developer-branch mode:
  1. Verifies the integration branch exists (remote or local when --local-only).
  2. Creates or tracks your personal developer branch.
  3. Pushes and sets upstream tracking (unless --local-only).
  4. Saves the branch in git config (<developerBranchConfigKey>).
  5. Enables .githooks safely if present and core.hooksPath is not claimed elsewhere.

In trunk mode:
  Verifies baseBranch exists and safely enables .githooks if present.

Options:
  --remote <name>   Override configured remote (default from .featflow.json).
  --local-only      Set up locally without touching the remote.
  --skip-hooks      Do not configure core.hooksPath.
  -h, --help        Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    branch: "",
    remote: "",
    localOnly: false,
    skipHooks: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--local-only") {
      options.localOnly = true;
      continue;
    }
    if (arg === "--skip-hooks") {
      options.skipHooks = true;
      continue;
    }
    if (arg === "--remote") {
      options.remote = argv[++i] ?? "";
      continue;
    }
    if (arg.startsWith("--remote=")) {
      options.remote = arg.slice("--remote=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`, usage);
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    fail(`Unexpected extra argument: ${positional[1]}`, usage);
  }
  options.branch = positional[0] ?? "";
  return options;
}

function ensureDeveloperBranch(repoRoot, branchName, remote, config, localOnly) {
  const hasRemote = !localOnly && remoteExists(remote, repoRoot);
  const integration = config.integrationBranch;
  const remoteIntegration = `${remote}/${integration}`;

  if (hasRemote) {
    if (!remoteBranchExists(remote, integration, repoRoot)) {
      throw new Error(
        [
          `Integration branch ${remoteIntegration} does not exist yet.`,
          `Create or push ${integration} first, or pass --local-only for offline setup.`,
        ].join("\n"),
      );
    }

    const localExists = localBranchExists(branchName, repoRoot);
    const remoteExistsForBranch = remoteBranchExists(remote, branchName, repoRoot);

    if (!localExists && remoteExistsForBranch) {
      runWrite("git", ["branch", "--track", branchName, `${remote}/${branchName}`], repoRoot);
      return "tracked existing remote branch";
    }

    if (!localExists) {
      runWrite("git", ["branch", branchName, remoteIntegration], repoRoot);
    }

    runWrite("git", ["push", "-u", remote, branchName], repoRoot, {
      env: { FEATFLOW_BOOTSTRAP: "1" },
    });
    return remoteExistsForBranch ? "updated existing remote branch" : "created and pushed new developer branch";
  }

  if (config.requireRemote && !localOnly) {
    throw new Error(`Remote "${remote}" is not configured. Add a remote or pass --local-only.`);
  }

  if (!localBranchExists(branchName, repoRoot)) {
    const startRef = localBranchExists(integration, repoRoot) ? integration : "HEAD";
    runWrite("git", ["branch", branchName, startRef], repoRoot);
    return `created local developer branch from ${startRef}`;
  }

  return "using existing local developer branch";
}

export function suggestDeveloperBranch(repoRoot, config, protectedBranches) {
  const existing = gitConfigGet(config.developerBranchConfigKey, repoRoot);
  if (existing && !protectedBranches.has(existing)) {
    return existing;
  }
  const rawName = gitConfigGet("user.name", repoRoot);
  const slug = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug && !protectedBranches.has(slug)) {
    return slug;
  }
  return "";
}

export function createPromptReader() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const queuedLines = [];
  const waiters = [];
  let closed = false;

  rl.on("line", (line) => {
    if (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve(line);
    } else {
      queuedLines.push(line);
    }
  });

  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) {
      const resolve = waiters.shift();
      resolve("");
    }
  });

  return {
    async question(promptText) {
      process.stdout.write(promptText);
      if (queuedLines.length > 0) {
        return queuedLines.shift();
      }
      if (closed) {
        return "";
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    close() {
      rl.close();
    },
  };
}

async function resolveDeveloperBranch(options, repoRoot, config, protectedBranches, sharedRl = null) {
  if (options.branch) {
    return options.branch;
  }
  const suggested = suggestDeveloperBranch(repoRoot, config, protectedBranches);
  const isInteractive =
    Boolean(sharedRl) ||
    Boolean(process.stdin.isTTY && process.stdout.isTTY) ||
    process.env.FEATFLOW_FORCE_TTY === "1";

  if (isInteractive) {
    const rl = sharedRl ?? createPromptReader();
    try {
      const promptLabel = suggested
        ? `Personal developer branch name [${suggested}]: `
        : "Personal developer branch name (e.g. alice): ";
      const answer = (await rl.question(promptLabel)).trim();
      const chosen = answer || suggested;
      if (!chosen) {
        throw new Error("Developer branch name is required in developer-branch mode (e.g. `featflow setup alice`).");
      }
      return chosen;
    } finally {
      if (!sharedRl) {
        rl.close();
      }
    }
  }

  const example = suggested || "alice";
  throw new Error(`Developer branch name is required in developer-branch mode (e.g. \`featflow setup ${example}\`).`);
}

export async function setupDeveloperBranchWorkflow(repoRoot, config, options = {}) {
  const remote = options.remote || config.remote;
  const protectedBranches = new Set(config.protectedBranches);
  const branch = await resolveDeveloperBranch(
    { branch: options.branch ?? "" },
    repoRoot,
    config,
    protectedBranches,
    options.rl ?? null,
  );
  validateDeveloperBranchName(branch, repoRoot, protectedBranches);

  const result = ensureDeveloperBranch(repoRoot, branch, remote, config, Boolean(options.localOnly));
  gitConfigSet(config.developerBranchConfigKey, branch, repoRoot);
  return { branch, result };
}

export async function runSetup(argv) {
  const options = parseArgs(argv);
  const { config, repoRoot } = loadConfig(process.cwd());

  if (config.mode === "developer-branch") {
    try {
      const setupResult = await setupDeveloperBranchWorkflow(repoRoot, config, {
        branch: options.branch,
        remote: options.remote,
        localOnly: options.localOnly,
      });
      options.branch = setupResult.branch;
      console.log(`Developer branch configured: ${setupResult.branch} (${setupResult.result})`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), usage);
    }
  } else {
    if (!localBranchExists(config.baseBranch, repoRoot)) {
      console.log(`Note: configured baseBranch "${config.baseBranch}" does not exist locally yet.`);
    } else {
      console.log(`Trunk workflow ready (base branch: ${config.baseBranch}).`);
    }
  }

  if (!options.skipHooks && existsSync(path.join(repoRoot, ".githooks"))) {
    const hookResult = configureGitHooksSafely(repoRoot);
    if (hookResult.configured) {
      console.log("Git hooks enabled: core.hooksPath=.githooks");
    } else {
      console.log(`Kept existing core.hooksPath=${hookResult.existingHooksPath} (did not overwrite).`);
      console.log("Wire featflow into your existing hooks with:");
      console.log("  pre-commit: featflow policy pre-commit");
      console.log("  pre-push:   featflow policy pre-push");
      console.log("  post-merge: featflow cleanup --post-merge || true");
    }
  }

  console.log("");
  console.log("Next steps:");
  const sampleBranch =
    config.mode === "developer-branch" ? `fix/${options.branch}-example` : "fix/example-task";
  console.log(`  featflow worktree ${sampleBranch}`);
  console.log("  # develop, verify, and commit inside the task worktree");
  console.log(`  featflow finish ${sampleBranch}`);
}
