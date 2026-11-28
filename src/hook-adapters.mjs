import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { changedFiles } from "./changed-files.mjs";
import {
  evaluatePostToolUse,
  evaluatePreToolUse,
  evaluateStopGate,
  evaluateUserPrompt,
  normalizeHookPayload,
  stateFilePath,
} from "./hooks-core.mjs";
import { evaluateFileSizeBudget } from "./size-check.mjs";

export const SUPPORTED_HOOK_ADAPTERS = ["codex", "claude-code", "antigravity", "cursor"];

export const SUPPORTED_HOOK_EVENTS = {
  codex: ["pre-tool-use", "post-tool-use", "user-prompt", "stop"],
  "claude-code": ["pre-tool-use", "post-tool-use", "user-prompt", "stop"],
  antigravity: ["pre-invocation", "user-prompt", "pre-tool-use", "post-tool-use", "stop"],
  cursor: ["before-submit-prompt", "user-prompt", "pre-tool-use", "post-tool-use", "stop"],
};

export function resolveHookCwd(rawInput, fallbackCwd = process.cwd()) {
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const candidates = [
    input.cwd,
    Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : null,
    Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() && existsSync(candidate.trim())) {
      return candidate.trim();
    }
  }
  return fallbackCwd;
}

function formatSizeFailureReason(result) {
  return [
    "featflow changed-file size budget failed:",
    ...result.failures.map((f) => `- ${f.path}: ${f.lines} lines exceeds ${f.label}`),
    "Split oversized files into smaller focused modules before finishing.",
  ].join("\n");
}

function runAntigravityHook(event, rawInput, payload, { repoRoot, config, env }) {
  if (event === "pre-invocation" || event === "user-prompt") {
    const prompt = payload.prompt.trim();
    if (!prompt) {
      return { stdout: "{}\n", exitCode: 0 };
    }
    const sig = createHash("sha256")
      .update(JSON.stringify({ conversationId: rawInput?.conversationId ?? "", prompt }))
      .digest("hex");
    const sigPath = stateFilePath(repoRoot, "antigravity-pre-invocation.sig", env);
    if (existsSync(sigPath) && readFileSync(sigPath, "utf8").trim() === sig) {
      return { stdout: "{}\n", exitCode: 0 };
    }
    writeFileSync(sigPath, `${sig}\n`);

    const result = evaluateUserPrompt(config, payload);
    if (result.additionalContext) {
      return {
        stdout: `${JSON.stringify({
          injectSteps: [{ systemMessage: { systemMessage: result.additionalContext } }],
        })}\n`,
        exitCode: 0,
      };
    }
    return { stdout: "{}\n", exitCode: 0 };
  }

  if (event === "pre-tool-use") {
    const result = evaluatePreToolUse(repoRoot, config, payload, env);
    if (result.decision === "block") {
      return {
        stdout: `${JSON.stringify({ decision: "deny", reason: result.message })}\n`,
        exitCode: 0,
      };
    }
    return { stdout: `${JSON.stringify({ decision: "allow" })}\n`, exitCode: 0 };
  }

  if (event === "post-tool-use") {
    // Antigravity PostToolUse hooks are observational and cannot block;
    // changed-file size enforcement runs in Stop and Git pre-commit.
    return { stdout: "{}\n", exitCode: 0 };
  }

  if (event === "stop") {
    if (rawInput?.continuationActive === true) {
      return { stdout: "{}\n", exitCode: 0 };
    }
    const budget = config.fileSizeBudget;
    if (
      budget &&
      budget.enforceInPostToolUse &&
      env.FEATFLOW_SKIP_POST_TOOL_QUALITY !== "1" &&
      env.FEATFLOW_DISABLE_STOP_GATE !== "1"
    ) {
      const extSet = new Set(budget.extensions.map((ext) => ext.toLowerCase()));
      const touched = changedFiles(repoRoot, config).filter((file) => extSet.has(path.extname(file).toLowerCase()));
      if (touched.length > 0) {
        const sizeRes = evaluateFileSizeBudget(repoRoot, config, { changed: true, files: touched });
        if (!sizeRes.ok) {
          return {
            stdout: `${JSON.stringify({ decision: "continue", reason: formatSizeFailureReason(sizeRes) })}\n`,
            exitCode: 0,
          };
        }
      }
    }

    const stopRes = evaluateStopGate(repoRoot, config, env);
    if (stopRes.decision === "block") {
      return {
        stdout: `${JSON.stringify({ decision: "continue", reason: stopRes.message })}\n`,
        exitCode: 0,
      };
    }
    return { stdout: "{}\n", exitCode: 0 };
  }

  return { stdout: "{}\n", exitCode: 0 };
}

function runCursorHook(event, payload, { repoRoot, config, env }) {
  if (event === "before-submit-prompt" || event === "user-prompt") {
    return { stdout: `${JSON.stringify({ continue: true })}\n`, exitCode: 0 };
  }

  if (event === "pre-tool-use") {
    const result = evaluatePreToolUse(repoRoot, config, payload, env);
    if (result.decision === "block") {
      return {
        stdout: `${JSON.stringify({
          permission: "deny",
          user_message: result.message,
          agent_message: result.message,
        })}\n`,
        exitCode: 0,
      };
    }
    return { stdout: `${JSON.stringify({ permission: "allow" })}\n`, exitCode: 0 };
  }

  if (event === "post-tool-use") {
    const result = evaluatePostToolUse(repoRoot, config, payload, env);
    if (result.decision === "block") {
      return {
        stdout: `${JSON.stringify({ additional_context: result.message })}\n`,
        exitCode: 0,
      };
    }
    return { stdout: "{}\n", exitCode: 0 };
  }

  if (event === "stop") {
    const result = evaluateStopGate(repoRoot, config, env);
    if (result.decision === "block") {
      return {
        stdout: `${JSON.stringify({ followup_message: result.message })}\n`,
        exitCode: 0,
      };
    }
    return { stdout: "{}\n", exitCode: 0 };
  }

  return { stdout: "{}\n", exitCode: 0 };
}

function runCodexOrClaudeHook(event, payload, { repoRoot, config, env }) {
  if (event === "pre-tool-use") {
    const result = evaluatePreToolUse(repoRoot, config, payload, env);
    return result.decision === "block" ? { stderr: `${result.message}\n`, exitCode: 2 } : { exitCode: 0 };
  }

  if (event === "post-tool-use") {
    const result = evaluatePostToolUse(repoRoot, config, payload, env);
    return result.decision === "block" ? { stderr: `${result.message}\n`, exitCode: 2 } : { exitCode: 0 };
  }

  if (event === "user-prompt") {
    const result = evaluateUserPrompt(config, payload);
    if (result.additionalContext) {
      return {
        stdout: `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: result.additionalContext,
          },
        })}\n`,
        exitCode: 0,
      };
    }
    return { exitCode: 0 };
  }

  if (event === "stop") {
    const result = evaluateStopGate(repoRoot, config, env);
    return result.decision === "block" ? { stderr: `${result.message}\n`, exitCode: 2 } : { exitCode: 0 };
  }

  return { exitCode: 0 };
}

export function dispatchHookAdapter(adapter, event, rawInput, context) {
  const payload = normalizeHookPayload(adapter, rawInput);
  if (adapter === "antigravity") {
    return runAntigravityHook(event, rawInput, payload, context);
  }
  if (adapter === "cursor") {
    return runCursorHook(event, payload, context);
  }
  return runCodexOrClaudeHook(event, payload, context);
}
