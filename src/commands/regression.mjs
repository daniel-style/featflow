import { spawnSync } from "node:child_process";

import { loadConfig } from "../config.mjs";
import { fail, findRepoRoot } from "../git.mjs";
import { analyzeRegressionImpact, validateRegressionLedger } from "../regression.mjs";

const usage = `
Usage:
  featflow regression <impact|check|validate> [options]

Inspects or validates the repository's regression memory ledger (YAML or JSON)
configured via \`regression.ledgerFile\` in .featflow.json.

Subcommands:
  impact               Find regression entries whose \`files\` patterns match changed files
  check                Shorthand for \`impact --run\` (runs every matched regression command)
  validate             Validate ledger schema, duplicate IDs, and referenced guard paths

Options:
  --ledger <path>      Override ledger path (defaults to regression.ledgerFile)
  --base <ref>         Override git diff base ref
  --head <ref>         Override git diff head ref (default: HEAD)
  --files <paths...>   Evaluate explicit file paths instead of git diff
  --run                Execute all unique verification commands for impacted entries
  --strict             (validate) Exit non-zero if any concrete guard file path is missing on disk
  --dry-run            Preview commands with --run without executing them
  --json               Output machine-readable JSON
  -h, --help           Show this help
`.trim();

function parseArgs(argv) {
  const options = {
    subcommand: "",
    ledgerFile: "",
    base: "",
    head: "",
    files: [],
    run: false,
    strict: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--run") {
      options.run = true;
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
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
    if (arg === "--ledger" || arg === "--base" || arg === "--head") {
      const value = argv[++i] ?? "";
      if (!value) fail(`Missing value for ${arg}.`, usage);
      options[arg === "--ledger" ? "ledgerFile" : arg.slice(2)] = value;
      continue;
    }
    if (/^--(?:ledger|base|head)=/.test(arg)) {
      const idx = arg.indexOf("=");
      const key = arg.slice(2, idx);
      options[key === "ledger" ? "ledgerFile" : key] = arg.slice(idx + 1);
      continue;
    }
    if (arg === "--files") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        options.files.push(argv[++i]);
      }
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option for regression: ${arg}`, usage);
    }
    if (!options.subcommand) {
      options.subcommand = arg;
    } else {
      options.files.push(arg);
    }
  }

  return options;
}

export async function runRegression(argv, forcedSubcommand = "") {
  const options = parseArgs(argv);
  const sub = forcedSubcommand || options.subcommand;
  if (!sub) {
    console.log(usage);
    return;
  }

  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    fail("Not inside a Git repository.");
  }
  const { config } = loadConfig(repoRoot);

  try {
    if (sub === "validate") {
      const result = validateRegressionLedger(repoRoot, config, options);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exit(1);
        return;
      }
      if (!result.ok) {
        console.error(`Regression ledger validation failed (${result.ledgerFile}):`);
        for (const err of result.errors) console.error(`  [error] ${err}`);
        for (const warn of result.warnings) console.error(`  [warn]  ${warn}`);
        process.exit(1);
      }
      console.log(`Regression ledger valid: ${result.ledgerFile} (${result.entryCount} entries).`);
      if (result.warnings.length > 0) {
        console.warn(`Warnings (${result.warnings.length}):`);
        for (const warn of result.warnings.slice(0, 10)) console.warn(`  - ${warn}`);
        if (result.warnings.length > 10) console.warn(`  ... and ${result.warnings.length - 10} more`);
      }
      return;
    }

    if (sub === "impact" || sub === "check") {
      const shouldRun = options.run || sub === "check";
      const report = analyzeRegressionImpact(repoRoot, config, options);
      const executions = [];

      if (shouldRun && report.uniqueCommands.length > 0) {
        for (const cmd of report.uniqueCommands) {
          if (options.dryRun) {
            executions.push({ command: cmd, ok: true, skipped: true, exitCode: 0 });
            continue;
          }
          const res = spawnSync(cmd, [], {
            cwd: repoRoot,
            shell: true,
            stdio: options.json ? ["ignore", "pipe", "pipe"] : "inherit",
            encoding: "utf8",
          });
          executions.push({
            command: cmd,
            ok: res.status === 0,
            skipped: false,
            exitCode: res.status ?? -1,
          });
        }
      }

      const allPassed = executions.every((e) => e.ok);
      const payload = { ...report, executions, ok: report.ok && allPassed };

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        if (!payload.ok) process.exit(1);
        return;
      }

      if (report.impacted.length === 0) {
        console.log(`No regression ledger entries impacted (${report.changedFiles.length} changed file(s) checked against ${report.entryCount} entries).`);
        return;
      }

      console.log(`Impacted regression entries (${report.impacted.length} of ${report.entryCount}):`);
      for (const item of report.impacted) {
        console.log(`- [${item.status}] ${item.id}: ${item.title}`);
        console.log(`    Matched:   ${item.matchedFiles.join(", ")}`);
        console.log(`    Invariant: ${item.invariant}`);
        if (item.commands.length > 0) {
          console.log(`    Commands:  ${item.commands.join(" ; ")}`);
        }
        if (item.missingGuards.length > 0) {
          console.log(`    Missing guards: ${item.missingGuards.join(", ")}`);
        }
      }

      if (shouldRun && executions.length > 0) {
        console.log("");
        console.log("Executed regression guard commands:");
        for (const exec of executions) {
          const tag = exec.skipped ? "DRY-RUN" : exec.ok ? "PASS" : "FAIL";
          console.log(`  [${tag}] ${exec.command}`);
        }
      }

      if (!payload.ok) {
        process.exit(1);
      }
      return;
    }

    fail(`Unknown regression subcommand "${sub}".`, usage);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
