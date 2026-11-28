import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { changedFileSelection, existingFiles, matchesAnyPattern, normalizeRelPath } from "./changed-files.mjs";
import { resolveFileSizeBudget } from "./config.mjs";

const STYLE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less"]);

function gitLsFiles(repoRoot, extraArgs = []) {
  const res = spawnSync("git", ["ls-files", "-z", ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error((res.stderr || "git ls-files failed").trim());
  }
  return (res.stdout ?? "").split("\0").filter(Boolean).map(normalizeRelPath);
}

export function isTestFilePath(relPath) {
  const norm = normalizeRelPath(relPath);
  const base = path.basename(norm);
  return (
    norm.startsWith("test/") ||
    norm.startsWith("tests/") ||
    norm.includes("/tests/") ||
    norm.includes("/test/") ||
    norm.includes("/__tests__/") ||
    /\.(?:spec|test)\.[a-z0-9]+$/i.test(base) ||
    /^test_.+\.py$/i.test(base) ||
    /_test\.[^.]+$/i.test(base)
  );
}

export function isStyleFilePath(relPath) {
  return STYLE_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

export function countFileLines(absPath) {
  const content = readFileSync(absPath, "utf8");
  if (content.length === 0) {
    return 0;
  }
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.split("\n").length - (normalized.endsWith("\n") ? 1 : 0);
}

export function budgetForFile(relPath, budgetConfig) {
  if (isStyleFilePath(relPath)) {
    return { category: "style", budget: budgetConfig.style };
  }
  if (isTestFilePath(relPath)) {
    return { category: "test", budget: budgetConfig.test };
  }
  return { category: "production", budget: budgetConfig.production };
}

export function loadSizeBaseline(repoRoot, baselineFile) {
  if (!baselineFile) {
    return { path: null, entries: {} };
  }
  const absPath = path.resolve(repoRoot, baselineFile);
  if (!existsSync(absPath)) {
    return { path: absPath, entries: {} };
  }
  const parsed = JSON.parse(readFileSync(absPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid file size baseline at ${absPath}: expected a JSON object.`);
  }
  const entries = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      entries[normalizeRelPath(key)] = Math.floor(value);
    }
  }
  return { path: absPath, entries };
}

export function evaluateFileSizeBudget(repoRoot, config, options = {}) {
  const budgetConfig = options.budgetConfig ?? resolveFileSizeBudget(config);
  const extSet = new Set(budgetConfig.extensions.map((ext) => ext.toLowerCase()));
  const { entries: baseline } = loadSizeBaseline(repoRoot, budgetConfig.baselineFile);
  const staleBaseline = new Set(Object.keys(baseline));

  let candidatePaths;
  let selection = null;
  if (options.changed || (options.files && options.files.length > 0)) {
    selection = changedFileSelection(repoRoot, config, {
      base: options.base,
      head: options.head,
      files: options.files,
    });
    candidatePaths = existingFiles(repoRoot, selection.files);
  } else {
    candidatePaths = [
      ...new Set([...gitLsFiles(repoRoot), ...gitLsFiles(repoRoot, ["--others", "--exclude-standard"])]),
    ].sort();
  }

  const failures = [];
  const tightenable = [];
  let checkedCount = 0;

  for (const relPath of candidatePaths) {
    const ext = path.extname(relPath).toLowerCase();
    if (!extSet.has(ext)) {
      continue;
    }
    if (matchesAnyPattern(relPath, budgetConfig.ignore)) {
      continue;
    }
    const absPath = path.resolve(repoRoot, relPath);
    if (!existsSync(absPath)) {
      continue;
    }

    checkedCount += 1;
    staleBaseline.delete(relPath);

    const lines = countFileLines(absPath);
    const { category, budget } = budgetForFile(relPath, budgetConfig);
    const baselineLimit = baseline[relPath];
    const hasBaseline = typeof baselineLimit === "number";
    const limit = hasBaseline ? Math.max(budget, baselineLimit) : budget;

    if (lines > limit) {
      failures.push({
        path: relPath,
        category,
        lines,
        budget,
        baselineLimit: hasBaseline ? baselineLimit : null,
        limit,
        label: hasBaseline ? `baseline ${baselineLimit}` : `budget ${budget}`,
      });
    } else if (hasBaseline && lines < baselineLimit) {
      tightenable.push({ path: relPath, lines, baselineLimit, budget });
    }
  }

  const stale = options.changed || (options.files && options.files.length > 0) ? [] : [...staleBaseline].sort();

  return {
    ok: failures.length === 0,
    changedOnly: Boolean(options.changed || (options.files && options.files.length > 0)),
    selection,
    checkedCount,
    budgets: {
      production: budgetConfig.production,
      style: budgetConfig.style,
      test: budgetConfig.test,
    },
    baselineFile: budgetConfig.baselineFile,
    failures,
    staleBaseline: stale,
    tightenable,
  };
}

export function updateFileSizeBaseline(repoRoot, config, options = {}) {
  const budgetConfig = options.budgetConfig ?? resolveFileSizeBudget(config);
  if (!budgetConfig.baselineFile) {
    throw new Error("Cannot update baseline because `fileSizeBudget.baselineFile` is null.");
  }

  const extSet = new Set(budgetConfig.extensions.map((ext) => ext.toLowerCase()));
  const allPaths = [
    ...new Set([...gitLsFiles(repoRoot), ...gitLsFiles(repoRoot, ["--others", "--exclude-standard"])]),
  ].sort();

  const nextBaseline = {};
  let checkedCount = 0;

  for (const relPath of allPaths) {
    if (!extSet.has(path.extname(relPath).toLowerCase())) continue;
    if (matchesAnyPattern(relPath, budgetConfig.ignore)) continue;
    const absPath = path.resolve(repoRoot, relPath);
    if (!existsSync(absPath)) continue;

    checkedCount += 1;
    const lines = countFileLines(absPath);
    const { budget } = budgetForFile(relPath, budgetConfig);
    if (lines > budget) {
      nextBaseline[relPath] = lines;
    }
  }

  const absTarget = path.resolve(repoRoot, budgetConfig.baselineFile);
  if (!options.dryRun) {
    mkdirSync(path.dirname(absTarget), { recursive: true });
    writeFileSync(absTarget, `${JSON.stringify(nextBaseline, null, 2)}\n`, "utf8");
  }

  return {
    baselineFile: budgetConfig.baselineFile,
    absPath: absTarget,
    checkedCount,
    entryCount: Object.keys(nextBaseline).length,
    entries: nextBaseline,
    dryRun: Boolean(options.dryRun),
  };
}
