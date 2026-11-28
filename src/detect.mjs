import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_PRODUCT_PATHS } from "./config.mjs";
import {
  currentBranch,
  gitConfigGet,
  localBranchExists,
  remoteExists,
  remoteTrackingBranchExists,
  runReadSoft,
} from "./git.mjs";

const PRODUCT_DIR_CANDIDATES = [
  "src",
  "app",
  "apps",
  "lib",
  "packages",
  "services",
  "cmd",
  "internal",
  "pkg",
  "crates",
  "server",
  "client",
  "web",
  "frontend",
  "backend",
  "api",
  "components",
  "pages",
  "modules",
  "core",
];

const IGNORED_TOP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "spec",
  "docs",
  "doc",
  "scripts",
  "features",
  "templates",
  "bin",
  "venv",
  "__pycache__",
  "tmp",
]);

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readTextSafe(filePath) {
  if (!existsSync(filePath)) {
    return "";
  }
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function detectBranches(repoRoot, remote = "origin") {
  const hasRemote = remoteExists(remote, repoRoot);
  const remoteUrl = hasRemote ? runReadSoft("git", ["remote", "get-url", remote], repoRoot).stdout : "";
  const isHostedGit = /github\.com|gitlab\.com|bitbucket\.org/i.test(remoteUrl);

  let defaultBranch = "";
  const originHead = runReadSoft("git", ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], repoRoot);
  if (originHead.status === 0 && originHead.stdout) {
    const prefix = `${remote}/`;
    defaultBranch = originHead.stdout.startsWith(prefix)
      ? originHead.stdout.slice(prefix.length)
      : originHead.stdout;
  }

  if (!defaultBranch) {
    if (localBranchExists("main", repoRoot)) {
      defaultBranch = "main";
    } else if (localBranchExists("master", repoRoot)) {
      defaultBranch = "master";
    } else if (remoteTrackingBranchExists(remote, "main", repoRoot)) {
      defaultBranch = "main";
    } else if (remoteTrackingBranchExists(remote, "master", repoRoot)) {
      defaultBranch = "master";
    } else {
      defaultBranch = currentBranch(repoRoot) || "main";
    }
  }

  let integrationBranch = "dev";
  let hasDevBranch = false;
  if (localBranchExists("dev", repoRoot) || remoteTrackingBranchExists(remote, "dev", repoRoot)) {
    integrationBranch = "dev";
    hasDevBranch = true;
  } else if (localBranchExists("develop", repoRoot) || remoteTrackingBranchExists(remote, "develop", repoRoot)) {
    integrationBranch = "develop";
    hasDevBranch = true;
  }

  return {
    defaultBranch,
    integrationBranch,
    hasDevBranch,
    hasRemote,
    remoteUrl,
    isHostedGit,
  };
}

export function detectProductPaths(repoRoot) {
  let entries = [];
  try {
    entries = readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return { productPaths: [...DEFAULT_PRODUCT_PATHS], source: "default" };
  }

  const topDirs = new Set(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_TOP_DIRS.has(entry.name))
      .map((entry) => entry.name),
  );

  const found = [];
  for (const candidate of PRODUCT_DIR_CANDIDATES) {
    if (topDirs.has(candidate)) {
      found.push(candidate);
    }
  }

  // Detect top-level Python packages (directories containing __init__.py)
  const pythonPackages = [...topDirs]
    .filter((dir) => !found.includes(dir) && existsSync(path.join(repoRoot, dir, "__init__.py")))
    .sort();
  found.push(...pythonPackages);

  if (found.length > 0) {
    return {
      productPaths: found.map((dir) => `${dir}/`),
      source: "detected",
    };
  }

  return {
    productPaths: [...DEFAULT_PRODUCT_PATHS],
    source: "default",
  };
}

export function detectPackageManagerAndVerify(repoRoot, productPathsInfo) {
  let packageManager = "";
  let verifyCommand = "";
  const suggestions = [];

  const pkg = readJsonSafe(path.join(repoRoot, "package.json"));
  if (pkg) {
    if (existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) {
      packageManager = "pnpm";
      suggestions.push('postWorktreeCreate: ["pnpm install --frozen-lockfile --offline"]');
    } else if (existsSync(path.join(repoRoot, "yarn.lock"))) {
      packageManager = "yarn";
    } else if (existsSync(path.join(repoRoot, "bun.lock")) || existsSync(path.join(repoRoot, "bun.lockb"))) {
      packageManager = "bun";
    } else if (existsSync(path.join(repoRoot, "package-lock.json"))) {
      packageManager = "npm";
    } else if (typeof pkg.packageManager === "string") {
      const match = pkg.packageManager.match(/^(pnpm|yarn|bun|npm)\b/);
      if (match) {
        packageManager = match[1];
      }
    }
    if (!packageManager) {
      packageManager = "npm";
    }

    const testScript = typeof pkg.scripts?.test === "string" ? pkg.scripts.test.trim() : "";
    if (testScript && !/no test specified/i.test(testScript)) {
      verifyCommand = packageManager === "bun" ? "bun run test" : `${packageManager} test`;
    }
  }

  if (!verifyCommand && existsSync(path.join(repoRoot, "go.mod"))) {
    verifyCommand = "go test ./...";
  }

  if (!verifyCommand && existsSync(path.join(repoRoot, "Cargo.toml"))) {
    verifyCommand = "cargo test";
  }

  if (!verifyCommand) {
    const pyproject = readTextSafe(path.join(repoRoot, "pyproject.toml"));
    const hasPytestMarkers =
      existsSync(path.join(repoRoot, "pytest.ini")) ||
      existsSync(path.join(repoRoot, "conftest.py")) ||
      /\bpytest\b/i.test(pyproject) ||
      (Boolean(pyproject) && (existsSync(path.join(repoRoot, "tests")) || existsSync(path.join(repoRoot, "test"))));
    if (hasPytestMarkers) {
      verifyCommand = existsSync(path.join(repoRoot, "uv.lock")) ? "uv run pytest" : "pytest";
    }
  }

  if (existsSync(path.join(repoRoot, ".codegraph"))) {
    suggestions.push('postWorktreeCreate: ["codegraph init"]');
  }

  const verifyCommands = {};
  if (verifyCommand && productPathsInfo.source === "detected") {
    for (const dir of productPathsInfo.productPaths) {
      verifyCommands[dir] = verifyCommand;
    }
  }

  return {
    packageManager,
    verifyCommand,
    verifyCommands,
    suggestions,
  };
}

export function detectFeaturesDirConflict(repoRoot, featuresDir = "features") {
  const target = path.join(repoRoot, featuresDir);
  if (!existsSync(target)) {
    return false;
  }
  if (existsSync(path.join(target, "_template.md")) || existsSync(path.join(target, "active"))) {
    return false;
  }
  try {
    const entries = readdirSync(target).filter((name) => name !== ".DS_Store");
    return entries.length > 0;
  } catch {
    return false;
  }
}

export function detectRepoEnvironment(repoRoot, options = {}) {
  const remote = options.remote || "origin";
  const branches = detectBranches(repoRoot, remote);
  const productInfo = detectProductPaths(repoRoot);
  const verifyInfo = detectPackageManagerAndVerify(repoRoot, productInfo);
  const featuresDirConflict = detectFeaturesDirConflict(repoRoot, options.featuresDir || "features");

  return {
    ...branches,
    productPaths: productInfo.productPaths,
    productPathsSource: productInfo.source,
    packageManager: verifyInfo.packageManager,
    verifyCommand: verifyInfo.verifyCommand,
    verifyCommands: verifyInfo.verifyCommands,
    suggestions: verifyInfo.suggestions,
    featuresDirConflict,
    existingHooksPath: gitConfigGet("core.hooksPath", repoRoot),
    hasClaudeConfig: existsSync(path.join(repoRoot, ".claude", "settings.json")),
    hasClaudeDir: existsSync(path.join(repoRoot, ".claude")),
    hasCodexConfig: existsSync(path.join(repoRoot, ".codex", "config.toml")),
    hasCodexDir: existsSync(path.join(repoRoot, ".codex")),
    hasCodegraph: existsSync(path.join(repoRoot, ".codegraph")),
  };
}

export function applyDetectedConfig(baseConfig, detected, options = {}) {
  const next = {
    ...baseConfig,
    protectedBranches: [...baseConfig.protectedBranches],
    prefixes: [...baseConfig.prefixes],
    productPaths: [...detected.productPaths],
    postWorktreeCreate: [...baseConfig.postWorktreeCreate],
    verifyCommands: { ...baseConfig.verifyCommands, ...detected.verifyCommands },
    dangerousCommands: { ...baseConfig.dangerousCommands },
  };

  if (next.mode === "developer-branch") {
    next.releaseBranch = detected.defaultBranch;
    next.integrationBranch = detected.integrationBranch;
    next.baseBranch = detected.integrationBranch;
    next.protectedBranches = [...new Set([detected.defaultBranch, detected.integrationBranch])];
  } else {
    next.baseBranch = detected.defaultBranch;
    next.integrationBranch = detected.defaultBranch;
    next.releaseBranch = detected.defaultBranch;
    next.protectedBranches = [detected.defaultBranch];
  }

  if (detected.featuresDirConflict && !options.explicitFeaturesDir) {
    next.featuresDir = options.minimal || options.localFeatures ? ".featflow/features" : "docs/features";
  }

  return next;
}
