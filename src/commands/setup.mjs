import { existsSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "../config.mjs";
import {
  fail,
  gitConfigGet,
  gitConfigSet,
  localBranchExists,
  remoteBranchExists,
  remoteExists,
  remoteTrackingBranchExists,
  runWrite,
  validateDeveloperBranchName,
} from "../git.mjs";
import { createPromptReader, createSmartPrompter, promptSingleSelect } from "../tui-select.mjs";
import { configureGitHooksSafely } from "./hooks-cmd.mjs";

export { createPromptReader };

const usage = `
Usage:
  featflow setup [developer-branch] [options]

In developer-branch mode:
  1. Verifies the integration branch exists (bootstraps & pushes it from releaseBranch if confirmed or --bootstrap-integration).
  2. Creates or tracks your personal developer branch.
  3. Pushes and sets upstream tracking (unless --local-only).
  4. Saves the branch in git config (<developerBranchConfigKey>).
  5. Enables .githooks safely if present and core.hooksPath is not claimed elsewhere.

In trunk mode:
  Verifies baseBranch exists and safely enables .githooks if present.

Options:
  --remote <name>          Override configured remote (default from .featflow.json).
  --bootstrap-integration  Auto-create and push the missing integration branch (e.g. origin/dev) from releaseBranch.
  --local-only             Set up locally without touching the remote.
  --skip-hooks             Do not configure core.hooksPath.
  -h, --help               Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    branch: "",
    remote: "",
    bootstrapIntegration: false,
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
    if (arg === "--bootstrap-integration") {
      options.bootstrapIntegration = true;
      continue;
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

function resolveIntegrationStartRef(repoRoot, remote, config) {
  const release = config.releaseBranch || "main";
  if (remote && remoteTrackingBranchExists(remote, release, repoRoot)) {
    return `${remote}/${release}`;
  }
  if (localBranchExists(release, repoRoot)) {
    return release;
  }
  return "HEAD";
}

function ensureLocalDeveloperBranch(repoRoot, branchName, integration, startRef) {
  let createdIntegration = false;
  if (!localBranchExists(integration, repoRoot)) {
    runWrite("git", ["branch", integration, startRef], repoRoot);
    createdIntegration = true;
  }
  if (!localBranchExists(branchName, repoRoot)) {
    runWrite("git", ["branch", branchName, integration], repoRoot);
    return createdIntegration
      ? `created local ${integration} and developer branch from ${startRef}`
      : `created local developer branch from ${integration}`;
  }
  return "using existing local developer branch";
}

async function ensureDeveloperBranch(repoRoot, branchName, remote, config, options = {}) {
  const localOnly = Boolean(options.localOnly);
  const hasRemote = !localOnly && remoteExists(remote, repoRoot);
  const integration = config.integrationBranch;
  const remoteIntegration = `${remote}/${integration}`;
  const startRef = resolveIntegrationStartRef(repoRoot, hasRemote ? remote : "", config);

  if (hasRemote) {
    let bootstrappedIntegration = false;

    if (!remoteBranchExists(remote, integration, repoRoot)) {
      let action = options.bootstrapIntegration ? "create-and-push" : "";
      if (!action && options.rl) {
        action = await promptSingleSelect(options.rl, {
          title: `Integration branch "${remoteIntegration}" does not exist yet`,
          defaultId: "create-and-push",
          choices: [
            {
              id: "create-and-push",
              label: "create-and-push",
              detail: `create "${integration}" from "${startRef}", push ${remoteIntegration}, and finish setup`,
              aliases: ["y", "yes", "create", "push"],
            },
            {
              id: "local-only",
              label: "local-only",
              detail: "create local branch only without pushing to remote",
              aliases: ["l", "local"],
            },
            {
              id: "skip",
              label: "skip",
              detail: "abort developer branch setup for now",
              aliases: ["n", "no", "s"],
            },
          ],
        });
      }

      if (action === "create-and-push") {
        if (!localBranchExists(integration, repoRoot)) {
          runWrite("git", ["branch", integration, startRef], repoRoot);
        }
        runWrite("git", ["push", "-u", remote, integration], repoRoot, {
          env: { FEATFLOW_BOOTSTRAP: "1" },
        });
        bootstrappedIntegration = true;
      } else if (action === "local-only") {
        return ensureLocalDeveloperBranch(repoRoot, branchName, integration, startRef);
      } else {
        throw new Error(
          [
            `Integration branch ${remoteIntegration} does not exist yet.`,
            `Run \`featflow setup ${branchName} --bootstrap-integration\` to create & push ${remoteIntegration} from ${startRef}, or pass --local-only for offline setup.`,
          ].join("\n"),
        );
      }
    }

    if (!remoteTrackingBranchExists(remote, integration, repoRoot)) {
      runWrite("git", ["fetch", remote, integration], repoRoot);
    }

    const localExists = localBranchExists(branchName, repoRoot);
    const remoteExistsForBranch = remoteBranchExists(remote, branchName, repoRoot);

    if (!localExists && remoteExistsForBranch) {
      if (!remoteTrackingBranchExists(remote, branchName, repoRoot)) {
        runWrite("git", ["fetch", remote, branchName], repoRoot);
      }
      runWrite("git", ["branch", "--track", branchName, `${remote}/${branchName}`], repoRoot);
      return bootstrappedIntegration
        ? `bootstrapped ${remoteIntegration} + tracked existing remote branch`
        : "tracked existing remote branch";
    }

    if (!localExists) {
      runWrite("git", ["branch", branchName, remoteIntegration], repoRoot);
    }

    runWrite("git", ["push", "-u", remote, branchName], repoRoot, {
      env: { FEATFLOW_BOOTSTRAP: "1" },
    });
    const baseMsg = remoteExistsForBranch
      ? "updated existing remote branch"
      : "created and pushed new developer branch";
    return bootstrappedIntegration ? `bootstrapped ${remoteIntegration} + ${baseMsg}` : baseMsg;
  }

  if (config.requireRemote && !localOnly) {
    throw new Error(`Remote "${remote}" is not configured. Add a remote or pass --local-only.`);
  }

  return ensureLocalDeveloperBranch(repoRoot, branchName, integration, startRef);
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
    const rl = sharedRl ?? createSmartPrompter();
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
  const isInteractive =
    Boolean(options.rl) ||
    Boolean(process.stdin.isTTY && process.stdout.isTTY) ||
    process.env.FEATFLOW_FORCE_TTY === "1";
  const ownsPrompter = !options.rl && isInteractive;
  const prompter = options.rl ?? (ownsPrompter ? createSmartPrompter() : null);

  try {
    const branch = await resolveDeveloperBranch(
      { branch: options.branch ?? "" },
      repoRoot,
      config,
      protectedBranches,
      prompter,
    );
    validateDeveloperBranchName(branch, repoRoot, protectedBranches);

    const result = await ensureDeveloperBranch(repoRoot, branch, remote, config, {
      localOnly: Boolean(options.localOnly),
      bootstrapIntegration: Boolean(options.bootstrapIntegration),
      rl: prompter,
    });
    gitConfigSet(config.developerBranchConfigKey, branch, repoRoot);
    return { branch, result };
  } finally {
    if (ownsPrompter && prompter) {
      prompter.close();
    }
  }
}

export async function runSetup(argv) {
  const options = parseArgs(argv);
  const { config, repoRoot } = loadConfig(process.cwd());

  if (config.mode === "developer-branch") {
    try {
      const setupResult = await setupDeveloperBranchWorkflow(repoRoot, config, {
        branch: options.branch,
        remote: options.remote,
        bootstrapIntegration: options.bootstrapIntegration,
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
