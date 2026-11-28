import { resolveAgentDocTargets } from "./agent-docs.mjs";
import { parseYesNo } from "./init-hooks.mjs";
import { promptMultiSelect } from "./tui-select.mjs";

export async function promptInteractiveOptions(prompter, options, detected, repoRoot, existingConfig = null) {
  console.log("Detected repository environment:");
  console.log(
    `  Base branch:    ${detected.defaultBranch}${detected.hasDevBranch ? ` (integration: ${detected.integrationBranch})` : ""}`,
  );
  console.log(`  Product paths:  ${detected.productPaths.join(", ")} (${detected.productPathsSource})`);
  console.log(`  Verify command: ${detected.verifyCommand || "(none detected)"}`);
  const docTargets = resolveAgentDocTargets(repoRoot, options.agentDocs);
  console.log(`  Agent docs:     ${docTargets.join(", ")}`);
  const detectedAgents = [
    detected.hasAgentsDir || detected.hasAntigravityHooks ? "antigravity" : null,
    detected.hasClaudeDir || detected.hasClaudeConfig ? "claude-code" : null,
    detected.hasCodexDir || detected.hasCodexConfig ? "codex" : null,
    detected.hasCursorDir || detected.hasCursorHooks ? "cursor" : null,
  ].filter(Boolean);
  if (detectedAgents.length > 0) {
    console.log(`  Agent dirs:     ${detectedAgents.join(", ")}`);
  }
  if (detected.existingHooksPath) {
    console.log(`  Git hooks path: ${detected.existingHooksPath} (will not overwrite)`);
  }
  console.log("");

  if (!options.merge) {
    if (!options.minimalExplicit && !options.localFeatures && !options.trackPointer) {
      const answer = (await prompter.question("Setup profile [full/minimal] (full): ")).trim().toLowerCase();
      if (answer === "minimal" || answer === "m") {
        options.minimal = true;
      }
    }

    if (!options.modeExplicit) {
      const defaultMode = detected.hasDevBranch ? "developer-branch" : "trunk";
      const answer = (await prompter.question(`Branch mode [trunk/developer-branch] (${defaultMode}): `))
        .trim()
        .toLowerCase();
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
      const answer = (await prompter.question(`Trunk finish target [merge/pr] (${defaultFinish}): `))
        .trim()
        .toLowerCase();
      if (answer === "pr" || answer === "merge") {
        options.finishTarget = answer;
      } else {
        options.finishTarget = defaultFinish;
      }
    }

    if (!options.hooksExplicit) {
      if (options.minimal) {
        const answer = await prompter.question("Install local Git hooks in .git/hooks/? [Y/n]: ");
        if (parseYesNo(answer, true)) {
          options.localHooks = true;
        } else {
          options.noHooks = true;
        }
      } else {
        const answer = (await prompter.question("Enable Git hooks? [repo/local/none] (repo): "))
          .trim()
          .toLowerCase();
        if (answer === "none" || answer === "n") {
          options.noHooks = true;
        } else if (answer === "local" || answer === "l") {
          options.localHooks = true;
        } else {
          options.withGithooks = true;
        }
      }
    }
  }

  if (!options.minimal && !options.capabilitiesExplicit) {
    const selectedCaps = await promptMultiSelect(prompter, {
      title: "Workflow guardrails & modules",
      choices: [
        {
          id: "size-budget",
          label: "File-size budget",
          detail: "600 prod / 700 style / 900 test lines + pre-commit guard",
          checked: Boolean(options.withSizeBudget || options.preset === "full" || existingConfig?.fileSizeBudget),
        },
        {
          id: "regression",
          label: "Regression Guardian",
          detail: "regression-ledger.yml + impact check + featflow-regression Skill",
          checked: Boolean(options.withRegression || options.preset === "full" || existingConfig?.regression),
        },
        {
          id: "issues",
          label: "GitHub Issues loop",
          detail: "featflow issue CLI + featflow-issues Skill",
          checked: Boolean(options.withIssues || options.preset === "full" || existingConfig?.issues),
        },
        {
          id: "codex-agents",
          label: "Codex read-only subagents",
          detail: ".codex/agents/*.toml templates",
          checked: Boolean(options.withCodexAgents || options.preset === "full"),
        },
      ],
    });
    const capSet = new Set(selectedCaps);
    options.withSizeBudget = capSet.has("size-budget");
    options.withRegression = capSet.has("regression");
    options.withIssues = capSet.has("issues");
    options.withCodexAgents = capSet.has("codex-agents");

    if (options.withIssues && !options.issueAssetsRepo && !existingConfig?.issues?.assetsRepo) {
      const assetsRepo = (
        await prompter.question("GitHub issue screenshot assets repo (<owner>/<repo>, Enter to skip): ")
      ).trim();
      if (assetsRepo && assetsRepo.includes("/")) {
        options.issueAssetsRepo = assetsRepo;
      }
    }
  }

  if (!options.agentHooksExplicit) {
    const precheckAll = options.preset === "full";
    const selectedHooks = await promptMultiSelect(prompter, {
      title: "AI Coding Agent Hooks",
      choices: [
        {
          id: "antigravity",
          label: "Antigravity",
          detail: ".agents/hooks.json",
          checked: precheckAll || options.withAntigravityHooks || detected.hasAgentsDir || detected.hasAntigravityHooks,
        },
        {
          id: "claude-code",
          label: "Claude Code",
          detail: ".claude/settings.json",
          checked: precheckAll || options.withClaudeHooks || detected.hasClaudeDir || detected.hasClaudeConfig,
        },
        {
          id: "codex",
          label: "OpenAI Codex",
          detail: ".codex/config.toml",
          checked: precheckAll || options.withCodexHooks || detected.hasCodexDir || detected.hasCodexConfig,
        },
        {
          id: "cursor",
          label: "Cursor",
          detail: ".cursor/hooks.json",
          checked: precheckAll || options.withCursorHooks || detected.hasCursorDir || detected.hasCursorHooks,
        },
      ],
    });
    const hookSet = new Set(selectedHooks);
    options.withAntigravityHooks = hookSet.has("antigravity");
    options.withClaudeHooks = hookSet.has("claude-code");
    options.withCodexHooks = hookSet.has("codex");
    options.withCursorHooks = hookSet.has("cursor");
  }
}
