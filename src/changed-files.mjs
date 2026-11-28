import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { gitConfigGet, runStatus } from "./git.mjs";

export function normalizeRelPath(filePath) {
  return String(filePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .trim();
}

export function uniqueNormalizedPaths(paths) {
  return [...new Set((paths ?? []).map(normalizeRelPath).filter(Boolean))].sort();
}

export function existingFiles(repoRoot, paths) {
  return uniqueNormalizedPaths(paths).filter((rel) => existsSync(path.resolve(repoRoot, rel)));
}

export function globToRegExp(pattern) {
  const normalized = normalizeRelPath(pattern);
  if (!normalized) {
    return /^$/;
  }

  let regexStr = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 2;
        } else {
          regexStr += ".*";
          i += 1;
        }
      } else {
        regexStr += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      regexStr += "[^/]";
      continue;
    }
    regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

export function matchesPattern(relPath, pattern) {
  const normPath = normalizeRelPath(relPath);
  const normPattern = normalizeRelPath(pattern);
  if (!normPattern) {
    return false;
  }
  if (!/[*?]/.test(normPattern)) {
    if (normPattern.endsWith("/")) {
      return normPath.startsWith(normPattern);
    }
    return normPath === normPattern || normPath.startsWith(`${normPattern}/`);
  }
  return globToRegExp(normPattern).test(normPath);
}

export function matchesAnyPattern(relPath, patterns) {
  return (patterns ?? []).some((pattern) => matchesPattern(relPath, pattern));
}

function gitRefExists(repoRoot, ref) {
  return runStatus("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot) === 0;
}

function gitCurrentBranch(repoRoot) {
  const res = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return res.status === 0 ? (res.stdout ?? "").trim() : "";
}

function gitDiffNameOnly(repoRoot, args) {
  const res = spawnSync("git", ["diff", "--name-only", "-z", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    return [];
  }
  return (res.stdout ?? "").split("\0").filter(Boolean);
}

function gitStatusFiles(repoRoot) {
  const res = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    return [];
  }
  const entries = (res.stdout ?? "").split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }
  return files;
}

export function resolveChangedBase(repoRoot, config = null, options = {}) {
  if (options.base !== undefined && options.base !== "") {
    return { base: options.base, source: "--base" };
  }
  if (process.env.FEATFLOW_CHANGED_BASE) {
    return { base: process.env.FEATFLOW_CHANGED_BASE, source: "FEATFLOW_CHANGED_BASE" };
  }
  if (process.env.CHANGED_CHECKS_BASE) {
    return { base: process.env.CHANGED_CHECKS_BASE, source: "CHANGED_CHECKS_BASE" };
  }

  const current = gitCurrentBranch(repoRoot);
  const remote = config?.remote || "origin";

  if (config?.mode === "developer-branch") {
    const devKey = config.developerBranchConfigKey || "featflow.developerBranch";
    const devBranch = gitConfigGet(devKey, repoRoot);
    if (devBranch) {
      if (current === devBranch) {
        return { base: "HEAD", source: `developer branch ${devBranch} working tree` };
      }
      if (gitRefExists(repoRoot, devBranch)) {
        return { base: devBranch, source: `configured developer branch ${devBranch}` };
      }
      if (gitRefExists(repoRoot, `${remote}/${devBranch}`)) {
        return { base: `${remote}/${devBranch}`, source: `remote developer branch ${remote}/${devBranch}` };
      }
    }
  }

  const baseBranch = config?.baseBranch || "main";
  if (current === baseBranch) {
    return { base: "HEAD", source: `base branch ${baseBranch} working tree` };
  }
  if (gitRefExists(repoRoot, baseBranch)) {
    return { base: baseBranch, source: `base branch ${baseBranch}` };
  }
  if (gitRefExists(repoRoot, `${remote}/${baseBranch}`)) {
    return { base: `${remote}/${baseBranch}`, source: `remote base branch ${remote}/${baseBranch}` };
  }
  return { base: "HEAD", source: "fallback HEAD working tree" };
}

export function changedFileSelection(repoRoot, config = null, options = {}) {
  if (options.files?.length > 0) {
    return {
      base: null,
      head: null,
      source: "explicit files",
      files: uniqueNormalizedPaths(options.files),
    };
  }

  if (process.env.FEATFLOW_TEST_CHANGED_FILES) {
    const testFiles = process.env.FEATFLOW_TEST_CHANGED_FILES.split(/\r?\n|,/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    return {
      base: null,
      head: null,
      source: "FEATFLOW_TEST_CHANGED_FILES",
      files: uniqueNormalizedPaths(testFiles),
    };
  }

  const files = [];
  const { base, source } = resolveChangedBase(repoRoot, config, options);
  const head = options.head || process.env.FEATFLOW_CHANGED_HEAD || process.env.CHANGED_CHECKS_HEAD || "HEAD";

  if (base && base !== "HEAD" && gitRefExists(repoRoot, base) && gitRefExists(repoRoot, head)) {
    files.push(...gitDiffNameOnly(repoRoot, [`${base}...${head}`]));
  }
  files.push(...gitDiffNameOnly(repoRoot, ["--cached"]));
  files.push(...gitDiffNameOnly(repoRoot, []));
  files.push(...gitStatusFiles(repoRoot));

  return {
    base,
    head,
    source,
    files: uniqueNormalizedPaths(files),
  };
}

export function changedFiles(repoRoot, config = null, options = {}) {
  return changedFileSelection(repoRoot, config, options).files;
}
