import { readFileSync } from "node:fs";

import { loadConfig } from "../config.mjs";
import { fail } from "../git.mjs";
import { evaluatePreCommit, evaluatePrePush } from "../policy.mjs";

const usage = `
Usage:
  featflow policy <pre-commit|pre-push>

Enforces branch protection and workflow setup guards for Git hooks.
Set FEATFLOW_BOOTSTRAP=1 to bypass for one-off repository bootstrap tasks.
`.trim();

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export async function runPolicy(argv) {
  const mode = argv[0] ?? "";
  if (!mode || mode === "-h" || mode === "--help") {
    console.log(usage);
    return;
  }

  const { config, repoRoot } = loadConfig(process.cwd());

  if (mode === "pre-commit") {
    const result = evaluatePreCommit(repoRoot, config, process.env);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    return;
  }

  if (mode === "pre-push") {
    const result = evaluatePrePush(repoRoot, config, readStdin(), process.env);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    return;
  }

  fail(`Unknown policy mode "${mode}". Expected "pre-commit" or "pre-push".`, usage);
}
