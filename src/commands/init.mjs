import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findManagedAgentDocs, renderAgentWorkflowBlock, resolveAgentDocTargets, upsertAgentDocBlock } from "../agent-docs.mjs";
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
import { INIT_USAGE, parseInitArgs } from "../init-args.mjs";
import {
  copyTemplateFile,
  ensureGitignoreEntries,
  installAntigravityHooks,
  installClaudeHooks,
  installCodexAgents,
  installCodexHooks,
  installCursorHooks,
  installInitialRegressionLedger,
  writeTextFile,
} from "../init-hooks.mjs";
import { promptInteractiveOptions } from "../init-prompts.mjs";
import { evaluateFileSizeBudget, updateFileSizeBaseline } from "../size-check.mjs";
import { createSmartPrompter, promptSingleSelect } from "../tui-select.mjs";
import { configureGitHooksSafely, installLocalHooks } from "./hooks-cmd.mjs";
import { setupDeveloperBranchWorkflow } from "./setup.mjs";

export {
  configureGitHooksSafely,
  installAntigravityHooks,
  installClaudeHooks,
  installCodexAgents,
  installCodexHooks,
  installCursorHooks,
};

function readExistingRawConfig(configPath) {
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    fail(`Existing ${CONFIG_FILENAME} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runInit(argv) {
  const options = parseInitArgs(argv);
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    fail("Not inside a Git repository. Run `git init` first.");
  }

  const configPath = path.join(repoRoot, CONFIG_FILENAME);
  const existingConfig = options.merge ? readExistingRawConfig(configPath) : null;

  const detected = options.detect
    ? detectRepoEnvironment(repoRoot, { featuresDir: options.featuresDir || existingConfig?.featuresDir || "features" })
    : null;

  const isInteractive =
    !options.yes &&
    (Boolean(process.stdin.isTTY && process.stdout.isTTY) || process.env.FEATFLOW_FORCE_TTY === "1");

  const prompter = isInteractive ? createSmartPrompter() : null;

  try {
    if (prompter && detected) {
      await promptInteractiveOptions(prompter, options, detected, repoRoot, existingConfig);
    }

    let config;
    let configChangedInMerge = false;
    if (options.merge && existingConfig) {
      config = structuredClone(existingConfig);
      if (options.withIssues && !config.issues) {
        config.issues = { ...DEFAULT_ISSUES_CONFIG, assetsRepo: options.issueAssetsRepo || null };
        configChangedInMerge = true;
      } else if (options.issueAssetsRepo && config.issues && !config.issues.assetsRepo) {
        config.issues.assetsRepo = options.issueAssetsRepo;
        configChangedInMerge = true;
      }
      if (options.withSizeBudget && !config.fileSizeBudget) {
        config.fileSizeBudget = { ...DEFAULT_FILE_SIZE_BUDGET };
        configChangedInMerge = true;
      }
      if (options.withRegression && !config.regression) {
        config.regression = { ...DEFAULT_REGRESSION_CONFIG };
        configChangedInMerge = true;
      }
    } else {
      try {
        config = presetConfig(options.mode);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error), INIT_USAGE);
      }
      if (detected) {
        config = applyDetectedConfig(config, detected, {
          explicitFeaturesDir: Boolean(options.featuresDir),
          minimal: options.minimal,
          localFeatures: options.localFeatures,
        });
      }
      if (options.featuresDir) config.featuresDir = options.featuresDir;
      if (options.finishTarget) {
        if (config.mode !== "trunk" || !["merge", "pr"].includes(options.finishTarget)) {
          fail(`--finish-target "${options.finishTarget}" is only valid in trunk mode ("merge" or "pr").`, INIT_USAGE);
        }
        config.finishTarget = options.finishTarget;
      }
      if (options.localFeatures) config.trackFeaturesInGit = false;
      if (options.trackPointer) config.trackCurrentFeaturePointer = true;
      if (options.withIssues) {
        config.issues = { ...DEFAULT_ISSUES_CONFIG, assetsRepo: options.issueAssetsRepo || null };
      }
      if (options.withSizeBudget) config.fileSizeBudget = { ...DEFAULT_FILE_SIZE_BUDGET };
      if (options.withRegression) config.regression = { ...DEFAULT_REGRESSION_CONFIG };
    }

    const shouldInstallLocalHooks =
      !options.noHooks && !options.withGithooks && (options.localHooks || (options.minimal && !options.merge));
    const shouldInstallRepoHooks = !options.noHooks && options.withGithooks;

    const created = [];
    const updated = [];
    const skipped = [];
    const notices = [];

    if (!options.merge && detected?.featuresDirConflict && !options.featuresDir) {
      notices.push(
        `Detected existing non-featflow "features/" directory; set featuresDir="${config.featuresDir}" to avoid collision (override with --features-dir).`,
      );
    }

    if (options.merge && existingConfig) {
      if (configChangedInMerge) {
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        updated.push(configPath);
      } else {
        skipped.push(configPath);
      }
    } else {
      writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`, options.force, created, skipped);
    }

    const featuresDir = config.featuresDir || "features";
    if (!options.minimal && !(options.merge && existingConfig)) {
      const featuresRoot = path.join(repoRoot, featuresDir);
      for (const subdir of ["active", "done", "paused", "programs"]) {
        mkdirSync(path.join(featuresRoot, subdir), { recursive: true });
        const gitkeep = path.join(featuresRoot, subdir, ".gitkeep");
        if (config.trackFeaturesInGit !== false && !existsSync(gitkeep)) {
          writeFileSync(gitkeep, "", "utf8");
          created.push(gitkeep);
        }
      }

      const templateFeaturesDir = path.join(packageRoot, "templates", "features");
      for (const file of ["README.md", "_template.md", "_program_template.md"]) {
        copyTemplateFile(path.join(templateFeaturesDir, file), path.join(featuresRoot, file), options.force, created, skipped);
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
    }

    if (!options.minimal) {
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
        installInitialRegressionLedger(
          repoRoot,
          config.regression?.ledgerFile || DEFAULT_REGRESSION_CONFIG.ledgerFile,
          options.force,
          created,
          skipped,
        );
      }
    }

    if (options.updateAgentDocs) {
      const targets =
        options.merge && existingConfig && !options.agentDocs
          ? findManagedAgentDocs(repoRoot)
          : resolveAgentDocTargets(repoRoot, options.agentDocs);
      const renderedBlock = renderAgentWorkflowBlock();
      for (const relTarget of targets) {
        const absTarget = path.resolve(repoRoot, relTarget);
        const result = upsertAgentDocBlock(absTarget, renderedBlock);
        if (result.action === "created") created.push(absTarget);
        else if (result.action === "updated") updated.push(absTarget);
        else skipped.push(absTarget);
      }
    }

    let hookNotice = "";
    if (shouldInstallRepoHooks) {
      const srcHooks = path.join(packageRoot, "templates", "githooks");
      const destHooks = path.join(repoRoot, ".githooks");
      for (const hook of ["pre-commit", "pre-push", "post-merge"]) {
        const dest = path.join(destHooks, hook);
        const copied = copyTemplateFile(path.join(srcHooks, hook), dest, options.force, created, skipped);
        if (copied || existsSync(dest)) chmodSync(dest, 0o755);
      }
      const hookResult = configureGitHooksSafely(repoRoot);
      hookNotice = hookResult.configured
        ? "Git hooks enabled: core.hooksPath=.githooks"
        : [
            `Kept existing core.hooksPath=${hookResult.existingHooksPath} (did not overwrite).`,
            "Add these lines to your existing hook manager instead:",
            "  pre-commit: featflow policy pre-commit",
            "  pre-push:   featflow policy pre-push",
            "  post-merge: featflow cleanup --post-merge || true",
          ].join("\n");
    } else if (shouldInstallLocalHooks) {
      const localResult = installLocalHooks(repoRoot, { quiet: true });
      hookNotice = localResult.installed
        ? `Local Git hooks enabled in ${localResult.hooksDir}: ${localResult.hooks.join(", ")}`
        : [
            `Kept existing core.hooksPath=${localResult.existingHooksPath} (did not overwrite).`,
            "Add these lines to your existing hook manager instead:",
            "  pre-commit: featflow policy pre-commit",
            "  pre-push:   featflow policy pre-push",
            "  post-merge: featflow cleanup --post-merge || true",
          ].join("\n");
    }

    if (options.withAntigravityHooks) {
      installAntigravityHooks(repoRoot, options.force, created, updated, skipped, notices);
    }
    if (options.withCodexHooks) {
      installCodexHooks(repoRoot, options.force, created, updated, skipped, notices);
    }
    if (options.withClaudeHooks) {
      installClaudeHooks(repoRoot, options.force, created, updated, skipped, notices);
    }
    if (options.withCursorHooks) {
      installCursorHooks(repoRoot, options.force, created, updated, skipped, notices);
    }
    if (options.withCodexAgents) {
      installCodexAgents(repoRoot, options.force, created, skipped);
    }

    if (options.withSizeBudget && config.fileSizeBudget?.baselineFile) {
      const baselineAbs = path.resolve(repoRoot, config.fileSizeBudget.baselineFile);
      if (!existsSync(baselineAbs)) {
        const evalRes = evaluateFileSizeBudget(repoRoot, config);
        if (!evalRes.ok) {
          const baseRes = updateFileSizeBaseline(repoRoot, config);
          created.push(baseRes.absPath);
          notices.push(
            `Generated legacy size baseline ${baseRes.baselineFile} (${baseRes.entryCount} oversized file(s) ratcheted so existing code passes immediately).`,
          );
        }
      }
    }

    let ignoredAdded = [];
    if (options.updateGitignore) {
      const entries = [".featflow/"];
      if (!options.minimal && !(options.merge && existingConfig)) {
        if (config.trackFeaturesInGit === false) entries.push(`${featuresDir}/`);
        else if (!config.trackCurrentFeaturePointer) entries.push(`${featuresDir}/current-feature.md`);
      }
      ignoredAdded = ensureGitignoreEntries(repoRoot, entries);
    }

    let devSetupSummary = "";
    if (!options.merge && config.mode === "developer-branch") {
      let shouldRunSetup = Boolean(options.developerBranch);
      if (!shouldRunSetup && prompter) {
        const answer = await promptSingleSelect(prompter, {
          title: "Set up your personal developer branch now?",
          defaultId: "yes",
          choices: [
            { id: "yes", label: "Yes", detail: "create/track your personal developer branch now", aliases: ["y", "true"] },
            { id: "no", label: "No", detail: "skip for now (run `featflow setup <name>` later)", aliases: ["n", "false"] },
          ],
        });
        shouldRunSetup = answer === "yes";
      }
      if (shouldRunSetup) {
        try {
          const setupRes = await setupDeveloperBranchWorkflow(repoRoot, config, {
            branch: options.developerBranch,
            localOnly: options.localOnly,
            rl: prompter,
          });
          devSetupSummary = `Developer branch configured: ${setupRes.branch} (${setupRes.result})`;
        } catch (error) {
          notices.push(`Skipped developer branch setup: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const actionVerb = options.merge && existingConfig ? "Upgraded" : "Initialized";
    const profileLabel = options.minimal ? "minimal" : options.preset || "full";
    console.log(`${actionVerb} featflow in ${repoRoot} (mode: ${config.mode}, profile: ${profileLabel})`);
    if (detected && !(options.merge && existingConfig)) {
      const verifySummary =
        Object.keys(config.verifyCommands ?? {}).length > 0 ? Object.values(config.verifyCommands)[0] : "(none)";
      console.log(
        `Detected: baseBranch=${config.baseBranch}, protected=[${(config.protectedBranches ?? []).join(", ")}], productPaths=[${(config.productPaths ?? []).join(", ")}], verify=${verifySummary}`,
      );
    }
    if (created.length > 0) {
      console.log("Created:");
      for (const file of created) console.log(`  - ${path.relative(repoRoot, file)}`);
    }
    if (updated.length > 0) {
      console.log("Updated (non-destructive):");
      for (const file of updated) console.log(`  - ${path.relative(repoRoot, file)}`);
    }
    if (skipped.length > 0) {
      console.log("Kept existing (pass --force to overwrite):");
      for (const file of skipped) console.log(`  - ${path.relative(repoRoot, file)}`);
    }
    if (ignoredAdded.length > 0) console.log(`Updated .gitignore with: ${ignoredAdded.join(", ")}`);
    if (hookNotice) console.log(`\n${hookNotice}`);
    if (devSetupSummary) console.log(`\n${devSetupSummary}`);
    for (const notice of notices) console.log(`\n${notice}`);

    if (!options.merge && detected?.suggestions?.length > 0) {
      console.log("\nOptional .featflow.json suggestions:");
      for (const suggestion of detected.suggestions) console.log(`  - ${suggestion}`);
    }

    console.log("\nNext steps:");
    const steps = [];
    if (!options.merge && config.mode === "developer-branch" && !devSetupSummary) {
      steps.push("Run: featflow setup <your-branch-name>");
    }
    steps.push("Start a task worktree: featflow worktree feat/my-first-task");
    steps.push(
      options.minimal
        ? "Draft a feature record inside the worktree: featflow new my-first-task --local"
        : "Check workflow health anytime with: featflow doctor",
    );
    steps.forEach((step, idx) => console.log(`  ${idx + 1}. ${step}`));
  } finally {
    if (prompter) prompter.close();
  }
}
