import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findMainRepoRoot, findRepoRoot } from "./git.mjs";

export const CONFIG_FILENAME = ".featflow.json";

export const DEFAULT_PREFIXES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "test",
  "refactor",
  "perf",
  "security",
];

export const DEFAULT_PRODUCT_PATHS = ["src/", "apps/", "services/", "packages/", "lib/"];

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function presetConfig(mode = "trunk") {
  if (mode === "developer-branch") {
    return {
      mode: "developer-branch",
      remote: "origin",
      requireRemote: true,
      baseBranch: "dev",
      integrationBranch: "dev",
      releaseBranch: "main",
      protectedBranches: ["main", "dev"],
      finishTarget: "developer-branch",
      developerBranchConfigKey: "featflow.developerBranch",
      worktreeParent: null,
      featuresDir: "features",
      trackFeaturesInGit: true,
      trackCurrentFeaturePointer: false,
      prefixes: [...DEFAULT_PREFIXES],
      productPaths: [...DEFAULT_PRODUCT_PATHS],
      postWorktreeCreate: [],
      verifyCommands: {},
      dangerousCommands: {
        blockDestructiveGit: true,
        blockForcePush: true,
        blockEnvWrite: true,
        blockedPackageManagers: [],
      },
    };
  }

  if (mode === "trunk") {
    return {
      mode: "trunk",
      remote: "origin",
      requireRemote: false,
      baseBranch: "main",
      integrationBranch: "main",
      releaseBranch: "main",
      protectedBranches: ["main"],
      finishTarget: "merge",
      developerBranchConfigKey: "featflow.developerBranch",
      worktreeParent: null,
      featuresDir: "features",
      trackFeaturesInGit: true,
      trackCurrentFeaturePointer: false,
      prefixes: [...DEFAULT_PREFIXES],
      productPaths: [...DEFAULT_PRODUCT_PATHS],
      postWorktreeCreate: [],
      verifyCommands: {},
      dangerousCommands: {
        blockDestructiveGit: true,
        blockForcePush: true,
        blockEnvWrite: true,
        blockedPackageManagers: [],
      },
    };
  }

  throw new Error(`Unsupported featflow mode "${mode}". Expected "trunk" or "developer-branch".`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolveWorktreeParent(repoRoot, config) {
  const mainRoot = findMainRepoRoot(repoRoot) ?? repoRoot;
  if (config.worktreeParent) {
    return resolve(mainRoot, config.worktreeParent);
  }
  const defaultName = `${basename(mainRoot)}-worktrees`;
  const parentDir = dirname(mainRoot);
  if (basename(parentDir) === defaultName) {
    return parentDir;
  }
  return resolve(mainRoot, "..", defaultName);
}

export function loadConfig(startCwd = process.cwd()) {
  const repoRoot = findRepoRoot(startCwd);
  const configPath = repoRoot ? resolve(repoRoot, CONFIG_FILENAME) : resolve(startCwd, CONFIG_FILENAME);

  let raw = {};
  let hasConfigFile = false;

  if (existsSync(configPath)) {
    hasConfigFile = true;
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      if (!isPlainObject(parsed)) {
        throw new Error(`${CONFIG_FILENAME} must contain a JSON object.`);
      }
      raw = parsed;
    } catch (error) {
      throw new Error(
        `Failed to parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const mode = typeof raw.mode === "string" ? raw.mode : "trunk";
  const base = presetConfig(mode);
  const dangerousCommands = {
    ...base.dangerousCommands,
    ...(isPlainObject(raw.dangerousCommands) ? raw.dangerousCommands : {}),
  };

  const merged = {
    ...base,
    ...raw,
    dangerousCommands,
    protectedBranches: Array.isArray(raw.protectedBranches)
      ? raw.protectedBranches.filter((item) => typeof item === "string" && item.trim().length > 0)
      : base.protectedBranches,
    prefixes: Array.isArray(raw.prefixes)
      ? raw.prefixes.filter((item) => typeof item === "string" && item.trim().length > 0)
      : base.prefixes,
    productPaths: Array.isArray(raw.productPaths)
      ? raw.productPaths.filter((item) => typeof item === "string" && item.trim().length > 0)
      : base.productPaths,
    postWorktreeCreate: Array.isArray(raw.postWorktreeCreate)
      ? raw.postWorktreeCreate.filter((item) => typeof item === "string" && item.trim().length > 0)
      : base.postWorktreeCreate,
    verifyCommands: isPlainObject(raw.verifyCommands) ? raw.verifyCommands : base.verifyCommands,
  };

  if (merged.mode === "trunk" && !["merge", "pr"].includes(merged.finishTarget)) {
    throw new Error(`Invalid finishTarget "${merged.finishTarget}" for trunk mode. Expected "merge" or "pr".`);
  }
  if (merged.mode === "developer-branch" && merged.finishTarget !== "developer-branch") {
    merged.finishTarget = "developer-branch";
  }

  return {
    config: merged,
    configPath,
    hasConfigFile,
    repoRoot: repoRoot ?? resolve(startCwd),
    mainRepoRoot: repoRoot ? (findMainRepoRoot(repoRoot) ?? repoRoot) : resolve(startCwd),
  };
}
