import { loadConfig } from "../config.mjs";
import { fail } from "../git.mjs";
import {
  dispatchHookAdapter,
  resolveHookCwd,
  SUPPORTED_HOOK_ADAPTERS,
  SUPPORTED_HOOK_EVENTS,
} from "../hook-adapters.mjs";

const usage = `
Usage:
  featflow hook <codex|claude-code|antigravity|cursor> <event>

Supported events:
  codex / claude-code: pre-tool-use | post-tool-use | user-prompt | stop
  antigravity:         pre-invocation | pre-tool-use | post-tool-use | stop
  cursor:              before-submit-prompt | pre-tool-use | post-tool-use | stop

Reads hook JSON from stdin and emits the adapter-appropriate response and exit code.
`.trim();

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

export async function runHook(argv) {
  const [adapter, event] = argv;
  if (!adapter || adapter === "-h" || adapter === "--help") {
    console.log(usage);
    return;
  }

  if (!SUPPORTED_HOOK_ADAPTERS.includes(adapter)) {
    fail(
      `Unsupported hook adapter "${adapter}". Expected one of: ${SUPPORTED_HOOK_ADAPTERS.join(", ")}.`,
      usage,
    );
  }
  const validEvents = SUPPORTED_HOOK_EVENTS[adapter] ?? [];
  if (!validEvents.includes(event ?? "")) {
    fail(
      `Unsupported hook event "${event ?? ""}" for adapter "${adapter}". Expected one of: ${validEvents.join(", ")}.`,
      usage,
    );
  }

  const rawInput = await readStdinJson();
  const startCwd = resolveHookCwd(rawInput, process.cwd());
  const { config, repoRoot } = loadConfig(startCwd);

  const outcome = dispatchHookAdapter(adapter, event, rawInput, {
    repoRoot,
    config,
    env: process.env,
  });

  if (outcome.stdout) {
    process.stdout.write(outcome.stdout);
  }
  if (outcome.stderr) {
    process.stderr.write(outcome.stderr);
  }
  if (outcome.exitCode && outcome.exitCode !== 0) {
    process.exit(outcome.exitCode);
  }
}
