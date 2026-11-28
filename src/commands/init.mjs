import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderAgentWorkflowBlock, resolveAgentDocTargets, upsertAgentDocBlock } from "../agent-docs.mjs";
import {
  CONFIG_FILENAME,
  DEFAULT_FILE_SIZE_BUDGET,
  DEFAULT_ISSUES_CONFIG,
  DEFAULT_REGRESSION_CONFIG,
  packageRoot,
  presetConfig,
} from "../config.mjs";
import { applyDetectedConfig, detectRepoEnvironment } from "../detect.mjs";
import { fail, findRepoRoot } from "../git.mjs";
import {
  copyTemplateFile,
  ensureGitignoreEntries,
  installClaudeHooks,
  installCodexAgents,
  installCodexHooks,
  parseYesNo,
  promptInteractiveOptions,
  writeTextFile,
} from "../init-hooks.mjs";
import { configureGitHooksSafely, installLocalHooks } from "./hooks-cmd.mjs";
import { createPromptReader, setupDeveloperBranchWorkflow } from "./setup.mjs";

export { configureGitHooksSafely, installClaudeHooks, installCodexAgents, installCodexHooks };

const usage = `
Usage:
  featflow init [options]

Scaffolds featflow in the current Git repository with automatic environment
detection and non-destructive AGENTS.md / CLAUDE.md workflow injection.

Options:
  --minimal                        Lightweight setup: .featflow.json + AGENTS.md block + local .git/hooks/ (reuses global Skill & built-in templates).
  --mode <trunk|developer-branch>  Branch topology preset (default: trunk, or prompted on TTY).
  --finish-target <merge|pr>       In trunk mode, whether "finish" merges into base or pushes for PR (default: merge).
  --features-dir <dir>             Custom directory for feature records (default: features).
  --local-features                 Store feature records locally (.gitignore features/) instead of tracking in Git.
  --track-pointer                  Track features/current-feature.md in Git instead of ignoring it locally.
  --with-githooks                  Copy tracked .githooks/ and enable core.hooksPath when not claimed by Husky/Lefthook.
  --local-hooks                    Install managed Git hook blocks in .git/hooks/ (default in --minimal).
  --no-hooks                       Skip Git hook installation.
  --with-codex-hooks               Install or merge Codex hook configuration (.codex/config.toml).
  --with-claude-hooks              Install or merge Claude Code hook configuration (.claude/settings.json).
  --with-codex-agents              Install generic read-only Codex subagent templates (.codex/agents/*.toml).
  --with-issues                    Enable optional GitHub Issues closed-loop config & featflow-issues Skill.
  --issue-assets-repo <o/r>        Configure issues.assetsRepo for screenshot uploads (implies --with-issues).
  --with-size-budget               Enable optional fileSizeBudget (600 prod / 700 style / 900 test lines).
  --with-regression                Enable optional regression ledger config & featflow-regression Skill.
  --agent-docs <files>             Comma-separated agent doc files to update (e.g. AGENTS.md,CLAUDE.md).
  --no-agent-docs                  Skip injecting the managed workflow block into AGENTS.md / CLAUDE.md.
  --no-detect                      Skip automatic branch, productPaths, and verifyCommands detection.
  --developer-branch <name>        In developer-branch mode, also run personal branch setup immediately.
  --local-only                     When setting up a developer branch during init, do not touch the remote.
  --no-gitignore                   Do not update .gitignore automatically.
  -y, --yes                        Accept detected defaults without interactive prompts.
  --force                          Overwrite existing featflow templates and config.
  -h, --help                       Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    minimal: false,
    minimalExplicit: false,
    mode: "trunk",
    modeExplicit: false,
    finishTarget: "",
    finishTargetExplicit: false,
    featuresDir: "",
    localFeatures: false,
    trackPointer: false,
    withGithooks: false,
    localHooks: false,
    noHooks: false,
    hooksExplicit: false,
    withCodexHooks: false,
    withClaudeHooks: false,
    withCodexAgents: false,
    withIssues: false,
    issueAssetsRepo: "",
    withSizeBudget: false,
    withRegression: false,
    agentDocs: null,
    updateAgentDocs: true,
    detect: true,
    developerBranch: "",
    localOnly: false,
    updateGitignore: true,
    yes: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--minimal") {
      options.minimal = true;
      options.minimalExplicit = true;
      continue;
    }
    if (arg === "--mode") {
      options.mode = argv[++i] ?? "";
      options.modeExplicit = true;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
      options.modeExplicit = true;
      continue;
    }
    if (arg === "--finish-target") {
      options.finishTarget = argv[++i] ?? "";
      options.finishTargetExplicit = true;
      continue;
    }
    if (arg.startsWith("--finish-target=")) {
      options.finishTarget = arg.slice("--finish-target=".length);
      options.finishTargetExplicit = true;
      continue;
    }
    if (arg === "--features-dir") {
      options.featuresDir = argv[++i] ?? "";
      if (!options.featuresDir) {
        fail("Missing value for --features-dir.", usage);
      }
      continue;
    }
    if (arg.startsWith("--features-dir=")) {
      options.featuresDir = arg.slice("--features-dir=".length);
      if (!options.featuresDir) {
        fail("Missing value for --features-dir.", usage);
      }
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
      options.hooksExplicit = true;
      continue;
    }
    if (arg === "--local-hooks") {
      options.localHooks = true;
      options.hooksExplicit = true;
      continue;
    }
    if (arg === "--no-hooks") {
      options.noHooks = true;
      options.hooksExplicit = true;
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
    if (arg === "--with-codex-agents") {
      options.withCodexAgents = true;
      continue;
    }
    if (arg === "--with-size-budget") {
      options.withSizeBudget = true;
      continue;
    }
    if (arg === "--with-regression") {
      options.withRegression = true;
      continue;
    }
    if (arg === "--with-issues") {
      options.withIssues = true;
      continue;
    }
    if (arg === "--issue-assets-repo") {
      options.issueAssetsRepo = argv[++i] ?? "";
      if (!options.issueAssetsRepo || !options.issueAssetsRepo.includes("/")) {
        fail('Invalid value for --issue-assets-repo. Expected "<owner>/<repo>".', usage);
      }
      options.withIssues = true;
      continue;
    }
    if (arg.startsWith("--issue-assets-repo=")) {
      options.issueAssetsRepo = arg.slice("--issue-assets-repo=".length);
      if (!options.issueAssetsRepo || !options.issueAssetsRepo.includes("/")) {
        fail('Invalid value for --issue-assets-repo. Expected "<owner>/<repo>".', usage);
      }
      options.withIssues = true;
      continue;
    }
    if (arg === "--agent-docs") {
      const value = argv[++i] ?? "";
      if (!value) {
        fail("Missing value for --agent-docs.", usage);
      }
      options.agentDocs = value.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (arg.startsWith("--agent-docs=")) {
      const value = arg.slice("--agent-docs=".length);
      if (!value) {
        fail("Missing value for --agent-docs.", usage);
      }
      options.agentDocs = value.split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--no-agent-docs") {
      options.updateAgentDocs = false;
      continue;
    }
    if (arg === "--no-detect") {
      options.detect = false;
      continue;
    }
    if (arg === "--developer-branch") {
      options.developerBranch = argv[++i] ?? "";
      if (!options.developerBranch) {
        fail("Missing value for --developer-branch.", usage);
      }
      continue;
    }
    if (arg.startsWith("--developer-branch=")) {
      options.developerBranch = arg.slice("--developer-branch=".length);
      if (!options.developerBranch) {
        fail("Missing value for --developer-branch.", usage);
      }
      continue;
    }
    if (arg === "--local-only") {
      options.localOnly = true;
      continue;
    }
    if (arg === "--no-gitignore") {
      options.updateGitignore = false;
      continue;
    }
    if (arg === "-y" || arg === "--yes") {
      options.yes = true;
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

export async function runInit(argv) {
  const options = parseArgs(argv);
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    fail("Not inside a Git repository. Run `git init` first.");
  }

  const detected = options.detect
    ? detectRepoEnvironment(repoRoot, { featuresDir: options.featuresDir || "features" })
    : null;

  const isInteractive =
    !options.yes &&
    (Boolean(process.stdin.isTTY && process.stdout.isTTY) || process.env.FEATFLOW_FORCE_TTY === "1");

  const rl = isInteractive ? createPromptReader() : null;

  try {
    if (rl && detected) {
      await promptInteractiveOptions(rl, options, detected, repoRoot);
    }

    let config;
    try {
      config = presetConfig(options.mode);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), usage);
    }

    if (detected) {
      config = applyDetectedConfig(config, detected, {
        explicitFeaturesDir: Boolean(options.featuresDir),
        minimal: options.minimal,
        localFeatures: options.localFeatures,
      });
    }

    if (options.featuresDir) {
      config.featuresDir = options.featuresDir;
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
    if (options.withIssues) {
      config.issues = {
        ...DEFAULT_ISSUES_CONFIG,
        assetsRepo: options.issueAssetsRepo || null,
      };
    }
    if (options.withSizeBudget) {
      config.fileSizeBudget = { ...DEFAULT_FILE_SIZE_BUDGET };
    }
    if (options.withRegression) {
      config.regression = { ...DEFAULT_REGRESSION_CONFIG };
    }

    // In --minimal mode, default to local .git/hooks/ unless --no-hooks or --with-githooks was chosen
    const shouldInstallLocalHooks =
      !options.noHooks && !options.withGithooks && (options.localHooks || options.minimal);
    const shouldInstallRepoHooks = !options.noHooks && options.withGithooks;

    const created = [];
    const updated = [];
    const skipped = [];
    const notices = [];

    if (detected?.featuresDirConflict && !options.featuresDir) {
      notices.push(
        `Detected existing non-featflow "features/" directory; set featuresDir="${config.featuresDir}" to avoid collision (override with --features-dir).`,
      );
    }

    writeTextFile(
      path.join(repoRoot, CONFIG_FILENAME),
      `${JSON.stringify(config, null, 2)}\n`,
      options.force,
      created,
      skipped,
    );

    if (!options.minimal) {
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
      if (options.withIssues) {
        copyTemplateFile(
          path.join(packageRoot, "skills", "featflow-issues", "SKILL.md"),
          path.join(repoRoot, ".agents", "skills", "featflow-issues", "SKILL.md"),
          options.force,
          created,
          skipped,
        );
      }
      if (options.withRegression) {
        copyTemplateFile(
          path.join(packageRoot, "skills", "featflow-regression", "SKILL.md"),
          path.join(repoRoot, ".agents", "skills", "featflow-regression", "SKILL.md"),
          options.force,
          created,
          skipped,
        );
      }
    }

    if (options.updateAgentDocs) {
      const targets = resolveAgentDocTargets(repoRoot, options.agentDocs);
      const renderedBlock = renderAgentWorkflowBlock();
      for (const relTarget of targets) {
        const absTarget = path.resolve(repoRoot, relTarget);
        const result = upsertAgentDocBlock(absTarget, renderedBlock);
        if (result.action === "created") {
          created.push(absTarget);
        } else if (result.action === "updated") {
          updated.push(absTarget);
        } else {
          skipped.push(absTarget);
        }
      }
    }

    let hookNotice = "";
    if (shouldInstallRepoHooks) {
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
    } else if (shouldInstallLocalHooks) {
      const localResult = installLocalHooks(repoRoot, { quiet: true });
      if (localResult.installed) {
        hookNotice = `Local Git hooks enabled in ${localResult.hooksDir}: ${localResult.hooks.join(", ")}`;
      } else {
        hookNotice = [
          `Kept existing core.hooksPath=${localResult.existingHooksPath} (did not overwrite).`,
          "Add these lines to your existing hook manager instead:",
          "  pre-commit: featflow policy pre-commit",
          "  pre-push:   featflow policy pre-push",
          "  post-merge: featflow cleanup --post-merge || true",
        ].join("\n");
      }
    }

    if (options.withCodexHooks) {
      installCodexHooks(repoRoot, options.force, created, updated, skipped, notices);
    }

    if (options.withClaudeHooks) {
      installClaudeHooks(repoRoot, options.force, created, updated, skipped, notices);
    }

    if (options.withCodexAgents) {
      installCodexAgents(repoRoot, options.force, created, skipped);
    }

    let ignoredAdded = [];
    if (options.updateGitignore) {
      const entries = [".featflow/"];
      if (!options.minimal) {
        if (!config.trackFeaturesInGit) {
          entries.push(`${config.featuresDir}/`);
        } else if (!config.trackCurrentFeaturePointer) {
          entries.push(`${config.featuresDir}/current-feature.md`);
        }
      }
      ignoredAdded = ensureGitignoreEntries(repoRoot, entries);
    }

    let devSetupSummary = "";
    if (config.mode === "developer-branch") {
      let shouldRunSetup = Boolean(options.developerBranch);
      if (!shouldRunSetup && rl) {
        const answer = await rl.question("Set up your personal developer branch now? [Y/n]: ");
        shouldRunSetup = parseYesNo(answer, true);
      }
      if (shouldRunSetup) {
        try {
          const setupRes = await setupDeveloperBranchWorkflow(repoRoot, config, {
            branch: options.developerBranch,
            localOnly: options.localOnly,
            rl,
          });
          devSetupSummary = `Developer branch configured: ${setupRes.branch} (${setupRes.result})`;
        } catch (error) {
          notices.push(
            `Skipped developer branch setup: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    const profileLabel = options.minimal ? "minimal" : "full";
    console.log(`Initialized featflow in ${repoRoot} (mode: ${config.mode}, profile: ${profileLabel})`);
    if (detected) {
      const verifySummary =
        Object.keys(config.verifyCommands).length > 0
          ? Object.values(config.verifyCommands)[0]
          : "(none)";
      console.log(
        `Detected: baseBranch=${config.baseBranch}, protected=[${config.protectedBranches.join(", ")}], productPaths=[${config.productPaths.join(", ")}], verify=${verifySummary}`,
      );
    }
    if (created.length > 0) {
      console.log("Created:");
      for (const file of created) {
        console.log(`  - ${path.relative(repoRoot, file)}`);
      }
    }
    if (updated.length > 0) {
      console.log("Updated (non-destructive):");
      for (const file of updated) {
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
    if (devSetupSummary) {
      console.log("");
      console.log(devSetupSummary);
    }
    for (const notice of notices) {
      console.log("");
      console.log(notice);
    }

    if (detected?.suggestions?.length > 0) {
      console.log("");
      console.log("Optional .featflow.json suggestions:");
      for (const suggestion of detected.suggestions) {
        console.log(`  - ${suggestion}`);
      }
    }

    console.log("");
    console.log("Next steps:");
    const steps = [];
    if (config.mode === "developer-branch" && !devSetupSummary) {
      steps.push("Run: featflow setup <your-branch-name>");
    }
    if (options.minimal) {
      steps.push("Start a task worktree: featflow worktree feat/my-first-task");
      steps.push("Draft a feature record inside the worktree: featflow new my-first-task --local");
    } else {
      steps.push("Start a task worktree: featflow worktree feat/my-first-task");
      steps.push("Check workflow health anytime with: featflow doctor");
    }
    steps.forEach((step, idx) => {
      console.log(`  ${idx + 1}. ${step}`);
    });
  } finally {
    if (rl) {
      rl.close();
    }
  }
}
