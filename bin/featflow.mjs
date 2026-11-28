#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

import { packageRoot } from "../src/config.mjs";
import { runCleanup } from "../src/commands/cleanup.mjs";
import { runCodegraph } from "../src/commands/codegraph.mjs";
import { runDoctor } from "../src/commands/doctor.mjs";
import { runFinish } from "../src/commands/finish.mjs";
import { runHook } from "../src/commands/hook-cmd.mjs";
import { runHooks } from "../src/commands/hooks-cmd.mjs";
import { runInit } from "../src/commands/init.mjs";
import { runIssue } from "../src/commands/issue.mjs";
import { runNew } from "../src/commands/new.mjs";
import { runPlanCheck } from "../src/commands/plan-check.mjs";
import { runPolicy } from "../src/commands/policy-cmd.mjs";
import { runPrCleanup } from "../src/commands/pr-cleanup.mjs";
import { runRegression } from "../src/commands/regression.mjs";
import { runSetup } from "../src/commands/setup.mjs";
import { runSizeCheck } from "../src/commands/size-check.mjs";
import { runStatus } from "../src/commands/status.mjs";
import { runSync } from "../src/commands/sync.mjs";
import { runVerify } from "../src/commands/verify.mjs";
import { runWorktree } from "../src/commands/worktree.mjs";

const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));

const usage = `
featflow v${pkg.version} — AI-native feature workflow (Skill + CLI + Hooks)

Usage:
  featflow <command> [options]

Commands:
  new           Create a feature or program record from repo or built-in template (--local for zero-footprint)
  hooks         Install/uninstall/inspect Git hooks (--local into .git/hooks/ or --repo into .githooks/)
  init          Auto-detect repo config, inject AGENTS.md block, and scaffold featflow (--minimal for lightweight)
  sync          Sync managed Skill, templates, .githooks, and AGENTS.md blocks (--check for CI)
  setup         Configure developer branch (if applicable) and safely enable Git hooks
  status        Show workflow mode, branch/worktree state, active features, and next step
  worktree      Create a typed task branch in a dedicated Git worktree
  finish        Merge/push a verified task branch and clean up its worktree
  issue         GitHub Issues closed-loop CLI (create | list | view | claim | review | release | labels:sync)
  size-check    Check files against configured fileSizeBudget (with legacy baseline ratchet)
  regression    Inspect or validate the regression memory ledger (impact | check | validate)
  verify        Run verifyCommands matching changed files (--all for full)
  codegraph     Bootstrap or inspect local CodeGraph index (.codegraph/codegraph.db)
  cleanup       Remove clean worktrees and local task branches already merged into base
  pr-cleanup    Sync base branch and clean up local worktree/branch after a GitHub PR merge
  plan-check    Validate that the active feature record has complete, approved Plan Details
  policy        Run Git hook guards (pre-commit | pre-push)
  hook          Run AI coding-agent hook adapters (antigravity | claude-code | codex | cursor)
  doctor        Check repository configuration, hooks, templates, and active feature health

Global Options:
  -h, --help     Show help
  -v, --version  Show version

Run "featflow <command> --help" for command-specific options.
`.trim();

const commands = {
  new: runNew,
  hooks: runHooks,
  init: runInit,
  sync: runSync,
  setup: runSetup,
  status: runStatus,
  worktree: runWorktree,
  finish: runFinish,
  issue: runIssue,
  issues: runIssue,
  "size-check": runSizeCheck,
  regression: runRegression,
  "regression-impact": (rest) => runRegression(rest, "impact"),
  verify: runVerify,
  codegraph: runCodegraph,
  cleanup: runCleanup,
  "pr-cleanup": runPrCleanup,
  "plan-check": runPlanCheck,
  policy: runPolicy,
  hook: runHook,
  doctor: runDoctor,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "-h" || command === "--help") {
    console.log(usage);
    return;
  }

  if (command === "-v" || command === "--version") {
    console.log(pkg.version);
    return;
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`error: Unknown command "${command}".\n`);
    console.error(usage);
    process.exit(1);
  }

  await handler(rest);
}

main().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
