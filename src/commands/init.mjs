import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_FILENAME, packageRoot, presetConfig } from "../config.mjs";
import { fail, findRepoRoot, gitConfigGet, gitConfigSet } from "../git.mjs";

const usage = `
Usage:
  featflow init [options]

Scaffolds featflow in the current Git repository.

Options:
  --mode <trunk|developer-branch>  Branch topology preset (default: trunk).
  --finish-target <merge|pr>       In trunk mode, whether "finish" merges into base or pushes for PR (default: merge).
  --local-features                 Store feature records locally (.gitignore features/) instead of tracking in Git.
  --track-pointer                  Track features/current-feature.md in Git instead of ignoring it locally.
  --with-githooks                  Copy .githooks/ and enable core.hooksPath when not claimed by Husky/Lefthook.
  --with-codex-hooks               Install Codex hook configuration (.codex/config.toml).
  --with-claude-hooks              Install Claude Code hook configuration (.claude/settings.json).
  --no-gitignore                   Do not update .gitignore automatically.
  --force                          Overwrite existing featflow templates and config.
  -h, --help                       Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    mode: "trunk",
    finishTarget: "",
    localFeatures: false,
    trackPointer: false,
    withGithooks: false,
    withCodexHooks: false,
    withClaudeHooks: false,
    updateGitignore: true,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--mode") {
      options.mode = argv[++i] ?? "";
      continue;
    }
    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
      continue;
    }
    if (arg === "--finish-target") {
      options.finishTarget = argv[++i] ?? "";
      continue;
    }
    if (arg.startsWith("--finish-target=")) {
      options.finishTarget = arg.slice("--finish-target=".length);
      continue;
    }
    if (arg === "--local-features") {
      options.localFeatures = true;
      continue;
    }
    if (arg === "--track-pointer") {
      options.trackPointer = true;
      continue;
    }
    if (arg === "--with-githooks") {
      options.withGithooks = true;
      continue;
    }
    if (arg === "--with-codex-hooks") {
      options.withCodexHooks = true;
      continue;
    }
    if (arg === "--with-claude-hooks") {
      options.withClaudeHooks = true;
      continue;
    }
    if (arg === "--no-gitignore") {
      options.updateGitignore = false;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    fail(`Unknown option: ${arg}`, usage);
  }

  return options;
}

function copyTemplateFile(src, dest, force, created, skipped) {
  if (existsSync(dest) && !force) {
    skipped.push(dest);
    return false;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  created.push(dest);
  return true;
}

function writeTextFile(dest, content, force, created, skipped) {
  if (existsSync(dest) && !force) {
    skipped.push(dest);
    return false;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, content, "utf8");
  created.push(dest);
  return true;
}

function ensureGitignoreEntries(repoRoot, entries) {
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

export function configureGitHooksSafely(repoRoot) {
  const existingHooksPath = gitConfigGet("core.hooksPath", repoRoot);
  if (!existingHooksPath || existingHooksPath === ".githooks") {
    gitConfigSet("core.hooksPath", ".githooks", repoRoot);
    return { configured: true, existingHooksPath: ".githooks" };
  }
  return { configured: false, existingHooksPath };
}

export async function runInit(argv) {
  const options = parseArgs(argv);
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    fail("Not inside a Git repository. Run `git init` first.");
  }

  let config;
  try {
    config = presetConfig(options.mode);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), usage);
  }

  if (options.finishTarget) {
    if (config.mode !== "trunk" || !["merge", "pr"].includes(options.finishTarget)) {
      fail(`--finish-target "${options.finishTarget}" is only valid in trunk mode ("merge" or "pr").`, usage);
    }
    config.finishTarget = options.finishTarget;
  }
  if (options.localFeatures) {
    config.trackFeaturesInGit = false;
  }
  if (options.trackPointer) {
    config.trackCurrentFeaturePointer = true;
  }

  const created = [];
  const skipped = [];

  writeTextFile(
    path.join(repoRoot, CONFIG_FILENAME),
    `${JSON.stringify(config, null, 2)}\n`,
    options.force,
    created,
    skipped,
  );

  const featuresRoot = path.join(repoRoot, config.featuresDir);
  for (const subdir of ["active", "done", "paused", "programs"]) {
    mkdirSync(path.join(featuresRoot, subdir), { recursive: true });
    const gitkeep = path.join(featuresRoot, subdir, ".gitkeep");
    if (config.trackFeaturesInGit && !existsSync(gitkeep)) {
      writeFileSync(gitkeep, "", "utf8");
      created.push(gitkeep);
    }
  }

  const templateFeaturesDir = path.join(packageRoot, "templates", "features");
  for (const file of ["README.md", "_template.md", "_program_template.md"]) {
    copyTemplateFile(
      path.join(templateFeaturesDir, file),
      path.join(featuresRoot, file),
      options.force,
      created,
      skipped,
    );
  }
  if (config.trackCurrentFeaturePointer) {
    copyTemplateFile(
      path.join(templateFeaturesDir, "current-feature.md"),
      path.join(featuresRoot, "current-feature.md"),
      options.force,
      created,
      skipped,
    );
  }

  copyTemplateFile(
    path.join(packageRoot, "skills", "featflow", "SKILL.md"),
    path.join(repoRoot, ".agents", "skills", "featflow", "SKILL.md"),
    options.force,
    created,
    skipped,
  );

  let hookNotice = "";
  if (options.withGithooks) {
    const srcHooks = path.join(packageRoot, "templates", "githooks");
    const destHooks = path.join(repoRoot, ".githooks");
    for (const hook of ["pre-commit", "pre-push", "post-merge"]) {
      const dest = path.join(destHooks, hook);
      const copied = copyTemplateFile(path.join(srcHooks, hook), dest, options.force, created, skipped);
      if (copied || existsSync(dest)) {
        chmodSync(dest, 0o755);
      }
    }
    const hookResult = configureGitHooksSafely(repoRoot);
    if (hookResult.configured) {
      hookNotice = "Git hooks enabled: core.hooksPath=.githooks";
    } else {
      hookNotice = [
        `Kept existing core.hooksPath=${hookResult.existingHooksPath} (did not overwrite).`,
        "Add these lines to your existing hook manager instead:",
        "  pre-commit: featflow policy pre-commit",
        "  pre-push:   featflow policy pre-push",
        "  post-merge: featflow cleanup --post-merge || true",
      ].join("\n");
    }
  }

  if (options.withCodexHooks) {
    copyTemplateFile(
      path.join(packageRoot, "templates", "adapters", "codex", "config.toml"),
      path.join(repoRoot, ".codex", "config.toml"),
      options.force,
      created,
      skipped,
    );
  }

  if (options.withClaudeHooks) {
    copyTemplateFile(
      path.join(packageRoot, "templates", "adapters", "claude-code", "settings.json"),
      path.join(repoRoot, ".claude", "settings.json"),
      options.force,
      created,
      skipped,
    );
  }

  let ignoredAdded = [];
  if (options.updateGitignore) {
    const entries = [".featflow/"];
    if (!config.trackFeaturesInGit) {
      entries.push(`${config.featuresDir}/`);
    } else if (!config.trackCurrentFeaturePointer) {
      entries.push(`${config.featuresDir}/current-feature.md`);
    }
    ignoredAdded = ensureGitignoreEntries(repoRoot, entries);
  }

  console.log(`Initialized featflow in ${repoRoot} (mode: ${config.mode})`);
  if (created.length > 0) {
    console.log("Created:");
    for (const file of created) {
      console.log(`  - ${path.relative(repoRoot, file)}`);
    }
  }
  if (skipped.length > 0) {
    console.log("Kept existing (pass --force to overwrite):");
    for (const file of skipped) {
      console.log(`  - ${path.relative(repoRoot, file)}`);
    }
  }
  if (ignoredAdded.length > 0) {
    console.log(`Updated .gitignore with: ${ignoredAdded.join(", ")}`);
  }
  if (hookNotice) {
    console.log("");
    console.log(hookNotice);
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Review .featflow.json and customize productPaths / verifyCommands / postWorktreeCreate.");
  console.log("  2. Copy the workflow snippet from templates/snippets/AGENTS-workflow.md into your AGENTS.md / CLAUDE.md.");
  if (config.mode === "developer-branch") {
    console.log("  3. Run: featflow setup <your-branch-name>");
  } else {
    console.log("  3. Start a task worktree: featflow worktree feat/my-first-task");
  }
}
