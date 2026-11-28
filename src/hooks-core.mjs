import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { currentBranch, gitChangedFiles } from "./git.mjs";
import { validateActiveFeaturePlan } from "./plan.mjs";
import { checkWorkflowReady } from "./policy.mjs";

const MUTATING_SHELL_PATTERNS = [
  /\b(?:sed|perl)\s+-i\b/,
  /(?:^|[;&|]\s*)(?:cp|mv|rm|touch|mkdir|chmod|truncate|install)\b/,
  /(?:^|[;&|]\s*)tee\b/,
  /(?:^|[^0-9])>>?\s*[^\s&]/,
  /\bgit\s+(?:apply|checkout\s+--|restore)\b/,
];

const WORKFLOW_MUTATING_PATTERNS = [
  /\bgit\s+(?:add|commit|merge|rebase|rm|mv|push)\b/,
  /\bgit\s+(?:switch|checkout)\s+-[^\n;]*[cb]\b/,
  /\bgit\s+branch\s+(?!--show-current\b|--list\b|-l\b|-a\b|-r\b|-v\b|-vv\b)/,
  /\bgit\s+worktree\s+(?:add|remove|prune)\b/,
  /\bfeatflow\s+(?:worktree|finish)\b/,
];

export function extractCodexPatchPaths(patchText) {
  const paths = [];
  for (const line of String(patchText ?? "").split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match) {
      paths.push(match[1].trim());
    }
  }
  return paths;
}

export function normalizeHookPayload(adapter, rawInput) {
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  const toolName = String(input.tool_name ?? input.toolName ?? "");
  const toolInput = input.tool_input ?? input.toolInput ?? {};
  const prompt = String(input.prompt ?? input.user_prompt ?? input.userPrompt ?? "");

  let command = "";
  let filePaths = [];

  if (typeof toolInput === "string") {
    if (toolInput.includes("*** Begin Patch")) {
      filePaths = extractCodexPatchPaths(toolInput);
    } else {
      command = toolInput;
    }
  } else if (toolInput && typeof toolInput === "object") {
    command = String(
      toolInput.cmd ?? toolInput.command ?? toolInput.shell_command ?? "",
    );
    const patch = String(toolInput.patch ?? toolInput.diff ?? toolInput.input ?? "");
    if (patch.includes("*** Begin Patch")) {
      filePaths.push(...extractCodexPatchPaths(patch));
    }
    if (typeof toolInput.file_path === "string" && toolInput.file_path.trim()) {
      filePaths.push(toolInput.file_path.trim());
    }
    if (typeof toolInput.path === "string" && toolInput.path.trim() && isEditToolName(toolName)) {
      filePaths.push(toolInput.path.trim());
    }
    if (typeof toolInput.notebook_path === "string" && toolInput.notebook_path.trim()) {
      filePaths.push(toolInput.notebook_path.trim());
    }
  }

  return {
    adapter,
    toolName,
    command,
    filePaths: [...new Set(filePaths)],
    prompt,
  };
}

function isEditToolName(toolName) {
  return /^(?:edit|multiedit|write|write_file|edit_file|notebookedit|apply_patch)$/i.test(toolName);
}

function isSetupCommand(command) {
  return /\bfeatflow\s+(?:init|setup)\b/.test(command);
}

function isMutatingShellCommand(command) {
  return MUTATING_SHELL_PATTERNS.some((pattern) => pattern.test(command));
}

function isMutatingWorkflowCommand(command) {
  return WORKFLOW_MUTATING_PATTERNS.some((pattern) => pattern.test(command)) || isMutatingShellCommand(command);
}

function normalizeRelativePath(repoRoot, rawPath) {
  const resolved = path.isAbsolute(rawPath) ? path.relative(repoRoot, rawPath) : rawPath;
  return resolved.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isProductPath(relPath, productPaths) {
  return productPaths.some((prefix) => {
    const normalized = prefix.replaceAll("\\", "/").replace(/^\.\//, "");
    return normalized.endsWith("/") ? relPath.startsWith(normalized) : relPath === normalized || relPath.startsWith(`${normalized}/`);
  });
}

function commandTargetsProductPath(command, productPaths) {
  if (!command || !isMutatingShellCommand(command)) {
    return false;
  }
  return productPaths.some((prefix) => {
    const normalized = prefix.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[\\s"'=/>])${escaped}(?:/|\\b)`).test(command);
  });
}

function commandPushesProtectedBranch(command, protectedBranches) {
  const match = command.match(/\bgit\s+push\b([^\n;]*)/);
  if (!match || protectedBranches.length === 0) {
    return null;
  }
  const args = match[1];
  for (const branch of protectedBranches) {
    const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?:^|\\s)(?:[\\w.-]+\\s+)?${escaped}(?=\\s|$)|refs/heads/${escaped}\\b`);
    if (regex.test(args)) {
      return branch;
    }
  }
  return null;
}

function checkDangerousCommands(command, config) {
  if (!command) {
    return null;
  }
  const rules = config.dangerousCommands ?? {};

  if (
    rules.blockDestructiveGit &&
    /\bgit\s+reset\s+--hard\b|\bgit\s+checkout\s+--\b|\bgit\s+clean\s+-[^\n;]*[fd]/.test(command)
  ) {
    return "Destructive Git cleanup can discard user work. Ask the user explicitly before running it.";
  }

  if (
    rules.blockForcePush &&
    /\bgit\s+push\b[^\n;]*(?:--force(?:-with-lease)?|-f)\b|\bgit\s+branch\s+-D\b/.test(command)
  ) {
    return "Force pushes and force-deleting branches are blocked unless the user explicitly asks for them.";
  }

  if (
    rules.blockEnvWrite &&
    /(?:^|[;&|]\s*)(?:echo|printf|cat|tee|cp|mv|touch)\b[^\n;]*(?:>\s*|\.\/)?\.env(?:\.[\w.-]+)?\b/.test(command) &&
    !/\.env\.example\b/.test(command)
  ) {
    return "Do not overwrite real `.env` files from automated commands; edit `.env.example` or ask the user.";
  }

  for (const pm of rules.blockedPackageManagers ?? []) {
    const escaped = pm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[;&|()\\s])${escaped}(?:\\s|$)`).test(command)) {
      return `Package manager "${pm}" is disallowed by .featflow.json.`;
    }
  }

  return null;
}

export function evaluatePreToolUse(repoRoot, config, payload, env = process.env) {
  const { command, filePaths } = payload;

  const danger = checkDangerousCommands(command, config);
  if (danger) {
    return {
      decision: "block",
      message: `featflow blocked this command: ${danger}\nCommand: ${command}`,
    };
  }

  const protectedPush = commandPushesProtectedBranch(command, config.protectedBranches);
  if (protectedPush && env.FEATFLOW_BOOTSTRAP !== "1") {
    return {
      decision: "block",
      message: `featflow blocked direct push to protected branch "${protectedPush}". Use a pull request or featflow finish.`,
    };
  }

  const needsWriteCheck =
    env.FEATFLOW_BOOTSTRAP !== "1" &&
    !isSetupCommand(command) &&
    (filePaths.length > 0 || isMutatingWorkflowCommand(command));

  if (needsWriteCheck) {
    const ready = checkWorkflowReady(repoRoot, config, env);
    if (!ready.ok) {
      return {
        decision: "block",
        message: `featflow blocked write-oriented work:\n${ready.message}`,
      };
    }

    const branch = currentBranch(repoRoot);
    if (new Set(config.protectedBranches).has(branch)) {
      return {
        decision: "block",
        message: `featflow blocked direct edits on protected branch "${branch}". Create a task worktree first: featflow worktree <prefix>/<task>`,
      };
    }
  }

  const relFilePaths = filePaths.map((entry) => normalizeRelativePath(repoRoot, entry));
  const editsProductCode =
    relFilePaths.some((rel) => isProductPath(rel, config.productPaths)) ||
    commandTargetsProductPath(command, config.productPaths);

  if (editsProductCode) {
    const planResult = validateActiveFeaturePlan(repoRoot, {
      featuresDir: config.featuresDir,
      requireApproved: true,
    });
    if (!planResult.ok) {
      return {
        decision: "block",
        message: [
          `featflow blocked product-code edits because the active feature plan (${planResult.activeFeature}) is incomplete:`,
          ...planResult.errors.map((err) => `- ${err}`),
        ].join("\n"),
      };
    }
  }

  return { decision: "allow" };
}

export function evaluateUserPrompt(config, payload) {
  const lower = (payload.prompt ?? "").toLowerCase();
  const reminders = [];

  if (/feature|plan|workflow|worktree|milestone|roadmap|refactor|implement|迁移|重构|计划|工作流|功能|实现/.test(lower)) {
    reminders.push(
      `For substantial or write-oriented work, follow the featflow skill (\`.agents/skills/featflow/SKILL.md\`): complete read-only discovery, present a concrete plan, wait for approval, and work in a dedicated worktree (\`featflow worktree\`).`,
    );
  }

  if (/bug|fix|regression|broken|failing|error|报错|修复|故障|失败/.test(lower)) {
    reminders.push(
      "For bug fixes or regressions, inspect existing behavior/tests first, present the root cause and fix plan before editing, and include a regression test in the Test Plan.",
    );
  }

  if (
    config.issues &&
    /\b(?:issues?|claim|triage)\b|#\d+|提单|提个单|提个\s*bug|提个需求|提个\s*feat|记个单|记一下.*bug|拉单|看单|认领|工单/.test(
      lower,
    )
  ) {
    reminders.push(
      "For GitHub Issues (filing with prefixes/screenshots or claiming & reviewing), follow `.agents/skills/featflow-issues/SKILL.md` and use `featflow issue create|list|view|claim|review|release` (do not create an Issue for plain direct fix requests).",
    );
  }

  if (reminders.length === 0) {
    return { additionalContext: "" };
  }

  const modeNote =
    config.mode === "developer-branch"
      ? `Branch mode: developer-branch (base from \`git config ${config.developerBranchConfigKey}\`, finish with \`featflow finish <branch>\`).`
      : `Branch mode: trunk (base from \`${config.baseBranch}\`, finish with \`featflow finish <branch>\`).`;

  return {
    additionalContext: `featflow reminders:\n- ${modeNote}\n- ${reminders.join("\n- ")}`,
  };
}

function stateFilePath(repoRoot, name, env = process.env) {
  const dir = env.FEATFLOW_HOOK_STATE_DIR ?? path.resolve(repoRoot, ".featflow", "hook-state");
  mkdirSync(dir, { recursive: true });
  return path.resolve(dir, name);
}

export function evaluateStopGate(repoRoot, config, env = process.env) {
  if (env.FEATFLOW_DISABLE_STOP_GATE === "1") {
    return { decision: "allow" };
  }

  const changedFiles = gitChangedFiles(repoRoot);
  if (changedFiles.length === 0) {
    return { decision: "allow" };
  }

  const recommendations = [];
  for (const [prefix, command] of Object.entries(config.verifyCommands ?? {})) {
    const normalized = prefix.replaceAll("\\", "/").replace(/^\.\//, "");
    const matched =
      normalized === "*" ||
      changedFiles.some((file) =>
        normalized.endsWith("/") ? file.startsWith(normalized) : file === normalized || file.startsWith(`${normalized}/`),
      );
    if (matched) {
      recommendations.push(`${prefix}: run \`${command}\`.`);
    }
  }

  if (changedFiles.some((file) => file.startsWith(`${config.featuresDir}/`))) {
    recommendations.push("Feature records changed: ensure `Verification` and `Handoff` sections reflect actual results.");
  }

  if (recommendations.length === 0) {
    return { decision: "allow" };
  }

  const sig = createHash("sha256")
    .update(JSON.stringify({ changedFiles, recommendations }))
    .digest("hex");
  const sigPath = stateFilePath(repoRoot, "stop-gate.sig", env);
  if (existsSync(sigPath) && readFileSync(sigPath, "utf8").trim() === sig) {
    return { decision: "allow" };
  }
  writeFileSync(sigPath, `${sig}\n`);

  return {
    decision: "block",
    message: [
      "Before final handoff, account for these featflow verification checks:",
      ...recommendations.map((item) => `- ${item}`),
      "Run the relevant commands or explicitly record skipped checks and residual risks in your handoff.",
    ].join("\n"),
  };
}
