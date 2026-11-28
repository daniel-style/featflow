import { existsSync } from "node:fs";
import path from "node:path";

import { commandExists, fail, findRepoRoot, runWrite } from "../git.mjs";

const usage = `
Usage:
  featflow codegraph [bootstrap|status] [path] [options]

Initializes a local CodeGraph index when .codegraph/codegraph.db is missing,
or syncs the existing index when present. Skips cleanly in CI or when the
optional \`codegraph\` CLI is not installed.

Options:
  --dry-run    Print command without executing it
  --json       Output machine-readable JSON (for status)
  -h, --help   Show this help

Environment:
  FEATFLOW_SKIP_CODEGRAPH=1            Skip CodeGraph bootstrap
  CELHIVE_SKIP_CODEGRAPH=1             Skip CodeGraph bootstrap (legacy alias)
  FEATFLOW_CODEGRAPH_IN_CI=1           Allow bootstrap in CI
  CELHIVE_CODEGRAPH_BOOTSTRAP_IN_CI=1  Allow bootstrap in CI (legacy alias)
`.trim();

function parseArgs(argv) {
  const options = {
    subcommand: "bootstrap",
    targetPath: "",
    dryRun: false,
    json: false,
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option for codegraph: ${arg}`, usage);
    }
    if ((arg === "bootstrap" || arg === "status") && !options.targetPath && options.subcommand === "bootstrap") {
      options.subcommand = arg;
      continue;
    }
    if (options.targetPath) {
      fail(`Unexpected extra argument: ${arg}`, usage);
    }
    options.targetPath = arg;
  }

  return options;
}

export function inspectCodegraphState(repoRoot) {
  const installed = commandExists("codegraph");
  const indexPath = path.join(repoRoot, ".codegraph", "codegraph.db");
  const indexed = existsSync(indexPath);
  return { installed, indexed, indexPath };
}

export async function runCodegraph(argv) {
  const options = parseArgs(argv);
  const requestedPath = path.resolve(options.targetPath || ".");
  const repoRoot = findRepoRoot(requestedPath);
  if (!repoRoot) {
    fail(`Not inside a Git repository: ${requestedPath}`);
  }

  if (options.subcommand === "status") {
    const state = inspectCodegraphState(repoRoot);
    if (options.json) {
      console.log(JSON.stringify({ repoRoot, ...state }, null, 2));
      return;
    }
    console.log(`CodeGraph CLI:   ${state.installed ? "installed" : "not installed"}`);
    console.log(`Local index:     ${state.indexed ? `present (${state.indexPath})` : "not initialized"}`);
    return;
  }

  const skipFlag = process.env.FEATFLOW_SKIP_CODEGRAPH || process.env.CELHIVE_SKIP_CODEGRAPH;
  if (skipFlag === "1" || skipFlag === "true") {
    console.log("Skipping CodeGraph bootstrap because FEATFLOW_SKIP_CODEGRAPH is set.");
    return;
  }

  const allowInCi = process.env.FEATFLOW_CODEGRAPH_IN_CI === "1" || process.env.CELHIVE_CODEGRAPH_BOOTSTRAP_IN_CI === "1";
  if (process.env.CI && !allowInCi) {
    console.log("Skipping CodeGraph bootstrap in CI.");
    return;
  }

  const state = inspectCodegraphState(repoRoot);
  if (!state.installed) {
    console.log("CodeGraph CLI is not installed; skipping local index bootstrap.");
    return;
  }

  const action = state.indexed ? "sync" : "init";
  console.log(`CodeGraph ${action === "init" ? "initializing" : "syncing"} index for ${repoRoot}`);
  runWrite("codegraph", [action, repoRoot], repoRoot, { dryRun: options.dryRun });
}
