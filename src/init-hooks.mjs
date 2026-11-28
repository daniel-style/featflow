import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { packageRoot } from "./config.mjs";

const CODEX_BLOCK_START = "# >>> featflow managed hooks >>>";
const CODEX_BLOCK_END = "# <<< featflow managed hooks <<<";

export const AGENT_HOOK_IDS = ["antigravity", "claude-code", "codex", "cursor"];

export function parseAgentHooksList(rawValue) {
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (!normalized || normalized === "none") {
    return new Set();
  }
  if (normalized === "all") {
    return new Set(AGENT_HOOK_IDS);
  }
  const aliases = {
    antigravity: "antigravity",
    agy: "antigravity",
    claude: "claude-code",
    "claude-code": "claude-code",
    codex: "codex",
    cursor: "cursor",
  };
  const selected = new Set();
  for (const part of normalized.split(",").map((s) => s.trim()).filter(Boolean)) {
    const mapped = aliases[part];
    if (!mapped) {
      throw new Error(
        `Unknown agent hook target "${part}". Expected comma-separated values from: ${AGENT_HOOK_IDS.join(", ")}, "all", or "none".`,
      );
    }
    selected.add(mapped);
  }
  return selected;
}

export function copyTemplateFile(src, dest, force, created, skipped) {
  if (existsSync(dest) && !force) {
    skipped.push(dest);
    return false;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  created.push(dest);
  return true;
}

export function writeTextFile(dest, content, force, created, skipped) {
  if (existsSync(dest) && !force) {
    skipped.push(dest);
    return false;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, content, "utf8");
  created.push(dest);
  return true;
}

export function ensureGitignoreEntries(repoRoot, entries) {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const toAdd = entries.filter((entry) => !lines.includes(entry));
  if (toAdd.length === 0) {
    return [];
  }

  const block = [
    existing && !existing.endsWith("\n") ? "\n" : "",
    existing ? "\n" : "",
    "# featflow local state\n",
    ...toAdd.map((entry) => `${entry}\n`),
  ].join("");
  writeFileSync(gitignorePath, `${existing}${block}`, "utf8");
  return toAdd;
}

function hasHookCommand(entries, command) {
  if (!Array.isArray(entries)) {
    return false;
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (entry.command === command) {
      return true;
    }
    if (Array.isArray(entry.hooks) && entry.hooks.some((item) => item && item.command === command)) {
      return true;
    }
  }
  return false;
}

export function installClaudeHooks(repoRoot, force, created, updated, skipped, notices) {
  const src = path.join(packageRoot, "templates", "adapters", "claude-code", "settings.json");
  const dest = path.join(repoRoot, ".claude", "settings.json");

  if (!existsSync(dest) || force) {
    copyTemplateFile(src, dest, force, created, skipped);
    return;
  }

  let existing;
  try {
    existing = JSON.parse(readFileSync(dest, "utf8"));
  } catch (error) {
    skipped.push(dest);
    notices.push(
      `Skipped merging .claude/settings.json (invalid JSON: ${error instanceof Error ? error.message : String(error)}).`,
    );
    return;
  }

  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    skipped.push(dest);
    notices.push("Skipped merging .claude/settings.json (expected a top-level JSON object).");
    return;
  }

  const template = JSON.parse(readFileSync(src, "utf8"));
  if (!existing.hooks || typeof existing.hooks !== "object" || Array.isArray(existing.hooks)) {
    existing.hooks = {};
  }

  let changed = false;
  for (const [eventName, templateEntries] of Object.entries(template.hooks ?? {})) {
    if (!Array.isArray(existing.hooks[eventName])) {
      existing.hooks[eventName] = [];
    }
    for (const templateEntry of templateEntries) {
      const targetCmd = templateEntry.hooks?.[0]?.command ?? templateEntry.command ?? "";
      if (targetCmd && !hasHookCommand(existing.hooks[eventName], targetCmd)) {
        existing.hooks[eventName].push(templateEntry);
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(dest, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    updated.push(dest);
  } else {
    skipped.push(dest);
  }
}

export function installAntigravityHooks(repoRoot, force, created, updated, skipped, notices) {
  const src = path.join(packageRoot, "templates", "adapters", "antigravity", "hooks.json");
  const dest = path.join(repoRoot, ".agents", "hooks.json");

  if (!existsSync(dest) || force) {
    copyTemplateFile(src, dest, force, created, skipped);
    return;
  }

  let existing;
  try {
    existing = JSON.parse(readFileSync(dest, "utf8"));
  } catch (error) {
    skipped.push(dest);
    notices.push(
      `Skipped merging .agents/hooks.json (invalid JSON: ${error instanceof Error ? error.message : String(error)}).`,
    );
    return;
  }

  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    skipped.push(dest);
    notices.push("Skipped merging .agents/hooks.json (expected a top-level JSON object).");
    return;
  }

  const template = JSON.parse(readFileSync(src, "utf8"));
  const before = JSON.stringify(existing.featflow ?? null);
  const after = JSON.stringify(template.featflow);
  if (before === after) {
    skipped.push(dest);
    return;
  }

  existing.featflow = template.featflow;
  writeFileSync(dest, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  updated.push(dest);
}

export function installCursorHooks(repoRoot, force, created, updated, skipped, notices) {
  const src = path.join(packageRoot, "templates", "adapters", "cursor", "hooks.json");
  const dest = path.join(repoRoot, ".cursor", "hooks.json");

  if (!existsSync(dest) || force) {
    copyTemplateFile(src, dest, force, created, skipped);
    return;
  }

  let existing;
  try {
    existing = JSON.parse(readFileSync(dest, "utf8"));
  } catch (error) {
    skipped.push(dest);
    notices.push(
      `Skipped merging .cursor/hooks.json (invalid JSON: ${error instanceof Error ? error.message : String(error)}).`,
    );
    return;
  }

  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    skipped.push(dest);
    notices.push("Skipped merging .cursor/hooks.json (expected a top-level JSON object).");
    return;
  }

  const template = JSON.parse(readFileSync(src, "utf8"));
  if (existing.version === undefined) {
    existing.version = template.version ?? 1;
  }
  if (!existing.hooks || typeof existing.hooks !== "object" || Array.isArray(existing.hooks)) {
    existing.hooks = {};
  }

  let changed = false;
  for (const [eventName, templateEntries] of Object.entries(template.hooks ?? {})) {
    if (!Array.isArray(existing.hooks[eventName])) {
      existing.hooks[eventName] = [];
    }
    for (const templateEntry of templateEntries) {
      const targetCmd = templateEntry.command ?? "";
      if (targetCmd && !hasHookCommand(existing.hooks[eventName], targetCmd)) {
        existing.hooks[eventName].push(templateEntry);
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(dest, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    updated.push(dest);
  } else {
    skipped.push(dest);
  }
}

export function installCodexHooks(repoRoot, force, created, updated, skipped, notices) {
  const src = path.join(packageRoot, "templates", "adapters", "codex", "config.toml");
  const dest = path.join(repoRoot, ".codex", "config.toml");

  if (!existsSync(dest) || force) {
    copyTemplateFile(src, dest, force, created, skipped);
    return;
  }

  const existing = readFileSync(dest, "utf8");
  if (existing.includes("featflow hook codex")) {
    skipped.push(dest);
    return;
  }

  if (/^\s*\[hooks\]\s*$/m.test(existing)) {
    skipped.push(dest);
    notices.push(
      [
        "Kept existing .codex/config.toml (custom [hooks] section already exists).",
        "Merge these featflow entries under [hooks]:",
        '  userPromptSubmit: { command = "featflow hook codex user-prompt", timeoutSec = 5 }',
        '  preToolUse:       { command = "featflow hook codex pre-tool-use", timeoutSec = 5 }',
        '  postToolUse:      { command = "featflow hook codex post-tool-use", timeoutSec = 30 }',
        '  stop:             { command = "featflow hook codex stop", timeoutSec = 8 }',
      ].join("\n"),
    );
    return;
  }

  const templateBody = readFileSync(src, "utf8").trim();
  const trimmed = existing.replace(/\s+$/, "");
  const appended = [trimmed, trimmed ? "" : null, CODEX_BLOCK_START, templateBody, CODEX_BLOCK_END, ""]
    .filter((line) => line !== null)
    .join("\n");
  writeFileSync(dest, appended, "utf8");
  updated.push(dest);
}

export function installCodexAgents(repoRoot, force, created, skipped) {
  const srcDir = path.join(packageRoot, "templates", "agents", "codex");
  const destDir = path.join(repoRoot, ".codex", "agents");
  for (const name of ["codebase-locator.toml", "implementation-scout.toml", "regression-guard-planner.toml"]) {
    copyTemplateFile(path.join(srcDir, name), path.join(destDir, name), force, created, skipped);
  }
}

export function installInitialRegressionLedger(repoRoot, ledgerRelPath, force, created, skipped) {
  const src = path.join(packageRoot, "templates", "regression", "regression-ledger.yml");
  const dest = path.resolve(repoRoot, ledgerRelPath || "context/regression-ledger.yml");
  return copyTemplateFile(src, dest, force, created, skipped);
}

export function parseYesNo(answer, defaultYes = true) {
  const normalized = String(answer ?? "").trim().toLowerCase();
  if (!normalized) {
    return defaultYes;
  }
  if (["y", "yes", "true", "1"].includes(normalized)) {
    return true;
  }
  if (["n", "no", "false", "0"].includes(normalized)) {
    return false;
  }
  return defaultYes;
}
