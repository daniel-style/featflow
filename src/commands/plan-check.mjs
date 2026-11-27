import { loadConfig } from "../config.mjs";
import { fail } from "../git.mjs";
import { validateActiveFeaturePlan } from "../plan.mjs";

const usage = `
Usage:
  featflow plan-check [feature-record-path] [options]

Validates that the active (or specified) feature record has all required Plan Details
headings, no unresolved template placeholders, and recorded pre-implementation approval.

Options:
  --allow-pending   Do not fail if Approval status is still "pending".
  --json            Output machine-readable JSON.
  -h, --help        Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    allowPending: false,
    filePath: null,
    json: false,
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--allow-pending") {
      options.allowPending = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`, usage);
    }
    if (options.filePath) {
      fail(`Unexpected extra argument: ${arg}`, usage);
    }
    options.filePath = arg;
  }

  return options;
}

export async function runPlanCheck(argv) {
  const options = parseArgs(argv);
  const { config, repoRoot } = loadConfig(process.cwd());
  const result = validateActiveFeaturePlan(repoRoot, {
    featuresDir: config.featuresDir,
    filePath: options.filePath,
    requireApproved: !options.allowPending,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.skipped) {
    console.log(result.reason);
  } else if (result.ok) {
    console.log(`Feature plan OK: ${result.activeFeature}`);
  } else {
    console.error(`Feature plan check failed (${result.activeFeature}):`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
  }

  if (!result.ok) {
    process.exit(1);
  }
}
