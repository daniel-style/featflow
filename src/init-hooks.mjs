import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveAgentDocTargets } from "./agent-docs.mjs";
import { packageRoot } from "./config.mjs";

const CODEX_BLOCK_START = "# >>> featflow managed hooks >>>";
const CODEX_BLOCK_END = "# <<< featflow managed hooks <<<";

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

function hasClaudeHookCommand(entries, command) {
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
      if (targetCmd && !hasClaudeHookCommand(existing.hooks[eventName], targetCmd)) {
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

export function parseYesNo(answer, defaultYes = true) {
  const normalized = answer.trim().toLowerCase();
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

export async function promptInteractiveOptions(rl, options, detected, repoRoot) {
  console.log("Detected repository environment:");
  console.log(
    `  Base branch:    ${detected.defaultBranch}${detected.hasDevBranch ? ` (integration: ${detected.integrationBranch})` : ""}`,
  );
  console.log(`  Product paths:  ${detected.productPaths.join(", ")} (${detected.productPathsSource})`);
  console.log(`  Verify command: ${detected.verifyCommand || "(none detected)"}`);
  const docTargets = resolveAgentDocTargets(repoRoot, options.agentDocs);
  console.log(`  Agent docs:     ${docTargets.join(", ")}`);
  if (detected.existingHooksPath) {
    console.log(`  Git hooks path: ${detected.existingHooksPath} (will not overwrite)`);
  }
  console.log("");

  if (!options.minimalExplicit && !options.localFeatures && !options.trackPointer) {
    const answer = (await rl.question("Setup profile [full/minimal] (full): ")).trim().toLowerCase();
    if (answer === "minimal" || answer === "m") {
      options.minimal = true;
    }
  }

  if (!options.modeExplicit) {
    const defaultMode = detected.hasDevBranch ? "developer-branch" : "trunk";
    const answer = (await rl.question(`Branch mode [trunk/developer-branch] (${defaultMode}): `)).trim().toLowerCase();
    if (answer === "developer-branch" || answer === "dev" || answer === "d") {
      options.mode = "developer-branch";
    } else if (answer === "trunk" || answer === "t") {
      options.mode = "trunk";
    } else {
      options.mode = defaultMode;
    }
  }

  if (options.mode === "trunk" && !options.finishTargetExplicit) {
    const defaultFinish = detected.isHostedGit ? "pr" : "merge";
    const answer = (await rl.question(`Trunk finish target [merge/pr] (${defaultFinish}): `)).trim().toLowerCase();
    if (answer === "pr" || answer === "merge") {
      options.finishTarget = answer;
    } else {
      options.finishTarget = defaultFinish;
    }
  }

  if (!options.hooksExplicit) {
    if (options.minimal) {
      const answer = await rl.question("Install local Git hooks in .git/hooks/? [Y/n]: ");
      if (parseYesNo(answer, true)) {
        options.localHooks = true;
      } else {
        options.noHooks = true;
      }
    } else {
      const answer = (await rl.question("Enable Git hooks? [repo/local/none] (repo): ")).trim().toLowerCase();
      if (answer === "none" || answer === "n") {
        options.noHooks = true;
      } else if (answer === "local" || answer === "l") {
        options.localHooks = true;
      } else {
        options.withGithooks = true;
      }
    }
  }

  if (detected.hasClaudeDir && !options.withClaudeHooks) {
    const answer = await rl.question("Install/merge Claude Code hooks (.claude/settings.json)? [Y/n]: ");
    if (parseYesNo(answer, true)) {
      options.withClaudeHooks = true;
    }
  }

  if (detected.hasCodexDir && !options.withCodexHooks) {
    const answer = await rl.question("Install/merge Codex hooks (.codex/config.toml)? [Y/n]: ");
    if (parseYesNo(answer, true)) {
      options.withCodexHooks = true;
    }
  }
}
