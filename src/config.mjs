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

export const DEFAULT_ISSUES_CONFIG = {
  provider: "github",
  repo: null,
  assetsRepo: null,
  assetsBranch: "main",
  assetsPrefix: "assets",
  inProgressLabel: "status:in-progress",
  inReviewLabel: "status:in-review",
  blockedLabel: "status:blocked",
  autoWorktree: true,
};

export const DEFAULT_FILE_SIZE_BUDGET = {
  production: 600,
  style: 700,
  test: 900,
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".css"],
  ignore: [],
  baselineFile: ".featflow-size-baseline.json",
  enforceInPostToolUse: true,
  enforceInStopGate: true,
  enforceInPreCommit: true,
};

export const DEFAULT_REGRESSION_CONFIG = {
  ledgerFile: "context/regression-ledger.yml",
  enforceInStopGate: false,
};

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

export function normalizeIssuesConfig(rawIssues) {
  if (!isPlainObject(rawIssues)) {
    return null;
  }
  const provider =
    typeof rawIssues.provider === "string" && rawIssues.provider.trim()
      ? rawIssues.provider.trim().toLowerCase()
      : DEFAULT_ISSUES_CONFIG.provider;
  if (provider !== "github") {
    throw new Error(`Unsupported issues.provider "${provider}". Expected "github".`);
  }
  const cleanStr = (val, fallback = null) => {
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
    return fallback;
  };
  const prefix = cleanStr(rawIssues.assetsPrefix, DEFAULT_ISSUES_CONFIG.assetsPrefix).replace(/^\/+|\/+$/g, "") || "assets";
  return {
    provider,
    repo: cleanStr(rawIssues.repo, null),
    assetsRepo: cleanStr(rawIssues.assetsRepo, null),
    assetsBranch: cleanStr(rawIssues.assetsBranch, DEFAULT_ISSUES_CONFIG.assetsBranch),
    assetsPrefix: prefix,
    inProgressLabel: cleanStr(rawIssues.inProgressLabel, DEFAULT_ISSUES_CONFIG.inProgressLabel),
    inReviewLabel: cleanStr(rawIssues.inReviewLabel, DEFAULT_ISSUES_CONFIG.inReviewLabel),
    blockedLabel: cleanStr(rawIssues.blockedLabel, DEFAULT_ISSUES_CONFIG.blockedLabel),
    autoWorktree: rawIssues.autoWorktree !== false,
  };
}

export function resolveIssuesConfig(config) {
  if (config && isPlainObject(config.issues)) {
    return normalizeIssuesConfig(config.issues);
  }
  return { ...DEFAULT_ISSUES_CONFIG };
}

export function normalizeFileSizeBudget(rawBudget) {
  if (!isPlainObject(rawBudget)) {
    return null;
  }
  const positiveInt = (val, fallback) =>
    typeof val === "number" && Number.isFinite(val) && val > 0 ? Math.floor(val) : fallback;
  const extensions = Array.isArray(rawBudget.extensions)
    ? rawBudget.extensions
        .filter((item) => typeof item === "string" && item.trim().length > 0)
        .map((item) => (item.trim().startsWith(".") ? item.trim().toLowerCase() : `.${item.trim().toLowerCase()}`))
    : [...DEFAULT_FILE_SIZE_BUDGET.extensions];
  const ignore = Array.isArray(rawBudget.ignore)
    ? rawBudget.ignore.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
  const baselineFile =
    rawBudget.baselineFile === null
      ? null
      : typeof rawBudget.baselineFile === "string" && rawBudget.baselineFile.trim()
        ? rawBudget.baselineFile.trim()
        : DEFAULT_FILE_SIZE_BUDGET.baselineFile;

  return {
    production: positiveInt(rawBudget.production, DEFAULT_FILE_SIZE_BUDGET.production),
    style: positiveInt(rawBudget.style ?? rawBudget.css, DEFAULT_FILE_SIZE_BUDGET.style),
    test: positiveInt(rawBudget.test, DEFAULT_FILE_SIZE_BUDGET.test),
    extensions,
    ignore,
    baselineFile,
    enforceInPostToolUse: rawBudget.enforceInPostToolUse !== false,
    enforceInStopGate: rawBudget.enforceInStopGate !== false,
    enforceInPreCommit: rawBudget.enforceInPreCommit !== false,
  };
}

export function resolveFileSizeBudget(config) {
  if (config && isPlainObject(config.fileSizeBudget)) {
    return normalizeFileSizeBudget(config.fileSizeBudget);
  }
  return { ...DEFAULT_FILE_SIZE_BUDGET };
}

export function normalizeRegressionConfig(rawRegression) {
  if (!isPlainObject(rawRegression)) {
    return null;
  }
  const ledgerFile =
    typeof rawRegression.ledgerFile === "string" && rawRegression.ledgerFile.trim()
      ? rawRegression.ledgerFile.trim()
      : DEFAULT_REGRESSION_CONFIG.ledgerFile;
  return {
    ledgerFile,
    enforceInStopGate: Boolean(rawRegression.enforceInStopGate),
  };
}

export function resolveRegressionConfig(config) {
  if (config && isPlainObject(config.regression)) {
    return normalizeRegressionConfig(config.regression);
  }
  return { ...DEFAULT_REGRESSION_CONFIG };
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
    issues: normalizeIssuesConfig(raw.issues),
    fileSizeBudget: normalizeFileSizeBudget(raw.fileSizeBudget),
    regression: normalizeRegressionConfig(raw.regression),
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
