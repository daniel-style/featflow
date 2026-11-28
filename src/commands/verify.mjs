import { spawnSync } from "node:child_process";

import { changedFileSelection, matchesPattern } from "../changed-files.mjs";
import { loadConfig } from "../config.mjs";
import { fail, findRepoRoot } from "../git.mjs";
import { evaluateFileSizeBudget } from "../size-check.mjs";
import { analyzeRegressionImpact } from "../regression.mjs";

const usage = `
Usage:
  featflow verify [options]

Runs verification commands from \`.featflow.json\` (\`verifyCommands\`) that match
the current changed files (or all configured commands with \`--all\`).

Options:
  --changed            Run only commands matching changed files (default)
  --all                Run all configured verifyCommands
  --base <ref>         Override git diff base ref for --changed
  --head <ref>         Override git diff head ref (default: HEAD)
  --files <paths...>   Match explicit file paths instead of git diff
  --with-size          Also run configured fileSizeBudget check (--changed)
  --with-regression    Also include commands from impacted regression ledger entries
  --dry-run            Print matched commands without executing them
  --json               Output machine-readable JSON
  -h, --help           Show this help
`.trim();

function parseArgs(argv) {
  const options = {
    all: false,
    base: "",
    head: "",
    files: [],
    withSize: false,
    withRegression: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--changed") {
      options.all = false;
      continue;
    }
    if (arg === "--with-size") {
      options.withSize = true;
      continue;
    }
    if (arg === "--with-regression") {
      options.withRegression = true;
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
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option for verify: ${arg}`, usage);
    }
    options.files.push(arg);
  }

  return options;
}

export function planVerifyCommands(repoRoot, config, options = {}) {
  const verifyMap = config.verifyCommands ?? {};
  const selection = options.all
    ? { base: null, head: null, source: "--all", files: [] }
    : changedFileSelection(repoRoot, config, {
        base: options.base,
        head: options.head,
        files: options.files,
      });

  const planned = [];
  const seenCommands = new Set();

  for (const [pattern, command] of Object.entries(verifyMap)) {
    if (!command || seenCommands.has(command)) continue;
    const matched =
      options.all ||
      pattern === "*" ||
      selection.files.some((file) => matchesPattern(file, pattern));
    if (matched) {
      seenCommands.add(command);
      planned.push({ source: `verifyCommands[${pattern}]`, command });
    }
  }

  let regressionReport = null;
  if (options.withRegression && config.regression) {
    regressionReport = analyzeRegressionImpact(repoRoot, config, options);
    for (const cmd of regressionReport.uniqueCommands) {
      if (!seenCommands.has(cmd)) {
        seenCommands.add(cmd);
        planned.push({ source: "regression", command: cmd });
      }
    }
  }

  return { selection, planned, regressionReport };
}

export async function runVerify(argv) {
  const options = parseArgs(argv);
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    fail("Not inside a Git repository.");
  }
  const { config } = loadConfig(repoRoot);

  let sizeResult = null;
  if (options.withSize && config.fileSizeBudget) {
    sizeResult = evaluateFileSizeBudget(repoRoot, config, {
      changed: !options.all,
      base: options.base,
      head: options.head,
      files: options.files,
    });
  }

  const { selection, planned } = planVerifyCommands(repoRoot, config, options);
  const results = [];

  for (const entry of planned) {
    if (options.dryRun) {
      results.push({ ...entry, ok: true, skipped: true, exitCode: 0, durationMs: 0 });
      continue;
    }
    const start = Date.now();
    const res = spawnSync(entry.command, [], {
      cwd: repoRoot,
      shell: true,
      stdio: options.json ? ["ignore", "pipe", "pipe"] : "inherit",
      encoding: "utf8",
    });
    results.push({
      ...entry,
      ok: res.status === 0,
      skipped: false,
      exitCode: res.status ?? -1,
      durationMs: Date.now() - start,
    });
  }

  const ok = results.every((r) => r.ok) && (sizeResult ? sizeResult.ok : true);

  if (options.json) {
    console.log(JSON.stringify({ ok, selection, sizeCheck: sizeResult, results }, null, 2));
    if (!ok) process.exit(1);
    return;
  }

  if (sizeResult) {
    console.log(`[${sizeResult.ok ? "PASS" : "FAIL"}] size-check (${sizeResult.checkedCount} files)`);
    for (const f of sizeResult.failures) {
      console.error(`  - ${f.path}: ${f.lines} lines exceeds ${f.label}`);
    }
  }

  if (results.length === 0) {
    console.log("No matching verifyCommands for the current changed files.");
  } else {
    console.log(`Verification summary (${results.length} command(s)):`);
    for (const r of results) {
      const tag = r.skipped ? "DRY-RUN" : r.ok ? "PASS" : "FAIL";
      console.log(`  [${tag}] ${r.source}: ${r.command}`);
    }
  }

  if (!ok) {
    process.exit(1);
  }
}
