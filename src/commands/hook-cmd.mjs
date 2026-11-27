import { loadConfig } from "../config.mjs";
import { fail } from "../git.mjs";
import {
  evaluatePreToolUse,
  evaluateStopGate,
  evaluateUserPrompt,
  normalizeHookPayload,
} from "../hooks-core.mjs";

const usage = `
Usage:
  featflow hook <codex|claude-code> <pre-tool-use|user-prompt|stop>

Reads hook JSON from stdin and emits the adapter-appropriate response and exit code:
  - Exit 0: allow (and optional JSON stdout for user-prompt)
  - Exit 2: block with stderr message (for pre-tool-use and stop)
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

  if (!["codex", "claude-code"].includes(adapter)) {
    fail(`Unsupported hook adapter "${adapter}". Expected "codex" or "claude-code".`, usage);
  }
  if (!["pre-tool-use", "user-prompt", "stop"].includes(event ?? "")) {
    fail(`Unsupported hook event "${event ?? ""}". Expected "pre-tool-use", "user-prompt", or "stop".`, usage);
  }

  const rawInput = await readStdinJson();
  const { config, repoRoot } = loadConfig(process.cwd());
  const payload = normalizeHookPayload(adapter, rawInput);

  if (event === "pre-tool-use") {
    const result = evaluatePreToolUse(repoRoot, config, payload, process.env);
    if (result.decision === "block") {
      process.stderr.write(`${result.message}\n`);
      process.exit(2);
    }
    return;
  }

  if (event === "user-prompt") {
    const result = evaluateUserPrompt(config, payload);
    if (result.additionalContext) {
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: result.additionalContext,
          },
        })}\n`,
      );
    }
    return;
  }

  if (event === "stop") {
    const result = evaluateStopGate(repoRoot, config, process.env);
    if (result.decision === "block") {
      process.stderr.write(`${result.message}\n`);
      process.exit(2);
    }
  }
}
