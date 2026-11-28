import { loadConfig } from "../config.mjs";
import { fail, findRepoRoot } from "../git.mjs";
import { evaluateFileSizeBudget, updateFileSizeBaseline } from "../size-check.mjs";

const usage = `
Usage:
  featflow size-check [options]

Checks repository files against the configured fileSizeBudget in .featflow.json
(with legacy baseline ratchet support: legacy files may only shrink, never grow).

Options:
  --changed            Check only files changed vs developer/base branch + working tree
  --base <ref>         Override base ref for --changed
  --head <ref>         Override head ref for --changed (default: HEAD)
  --files <paths...>   Check explicit file paths
  --update-baseline    Generate or tighten the configured baselineFile from current repo state
  --dry-run            Preview --update-baseline without writing
  --json               Output machine-readable JSON
  -h, --help           Show this help
`.trim();

function parseArgs(argv) {
  const options = {
    changed: false,
    base: "",
    head: "",
    files: [],
    updateBaseline: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--changed") {
      options.changed = true;
      continue;
    }
    if (arg === "--update-baseline") {
      options.updateBaseline = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--base" || arg === "--head") {
      const value = argv[++i] ?? "";
      if (!value) fail(`Missing value for ${arg}.`, usage);
      options[arg.slice(2)] = value;
      continue;
    }
    if (arg.startsWith("--base=") || arg.startsWith("--head=")) {
      const idx = arg.indexOf("=");
      options[arg.slice(2, idx)] = arg.slice(idx + 1);
      continue;
    }
    if (arg === "--files") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        options.files.push(argv[++i]);
      }
      options.changed = true;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option for size-check: ${arg}`, usage);
    }
    options.files.push(arg);
    options.changed = true;
  }

  return options;
}

export async function runSizeCheck(argv) {
  const options = parseArgs(argv);
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    fail("Not inside a Git repository.");
  }

  const { config } = loadConfig(repoRoot);

  if (options.updateBaseline) {
    const updated = updateFileSizeBaseline(repoRoot, config, { dryRun: options.dryRun });
    if (options.json) {
      console.log(JSON.stringify(updated, null, 2));
      return;
    }
    console.log(
      `${options.dryRun ? "[dry-run] Would write" : "Updated"} ${updated.baselineFile} (${updated.entryCount} legacy entries across ${updated.checkedCount} checked files).`,
    );
    return;
  }

  const result = evaluateFileSizeBudget(repoRoot, config, options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  if (!result.ok) {
    console.error(
      result.changedOnly
        ? "Changed-file size budget failed. Split large changed files before adding more code."
        : "File size budget failed. Split large files before adding more code.",
    );
    for (const failure of result.failures) {
      console.error(`- ${failure.path}: ${failure.lines} lines exceeds ${failure.label}`);
    }
    process.exit(1);
  }

  if (result.staleBaseline.length > 0) {
    console.warn("File size baseline contains paths that no longer exist:");
    for (const stalePath of result.staleBaseline) {
      console.warn(`- ${stalePath}`);
    }
  }

  console.log(
    result.changedOnly
      ? `Changed-file size budget passed (${result.checkedCount} changed size-checked files).`
      : `File size budget passed (${result.budgets.production} production, ${result.budgets.style} style, ${result.budgets.test} test lines; legacy baselines may only shrink).`,
  );
}
