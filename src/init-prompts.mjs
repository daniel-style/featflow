import { resolveAgentDocTargets } from "./agent-docs.mjs";
import { promptMultiSelect, promptSingleSelect } from "./tui-select.mjs";

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
      const profile = await promptSingleSelect(prompter, {
        title: "Setup profile",
        defaultId: "full",
        choices: [
          { id: "full", label: "full", detail: "features/ templates, skills, guardrails & hooks", aliases: ["f"] },
          { id: "minimal", label: "minimal", detail: "lightweight (.featflow.json + AGENTS.md + local hooks)", aliases: ["m"] },
        ],
      });
      if (profile === "minimal") {
        options.minimal = true;
      }
    }

    if (!options.modeExplicit) {
      const defaultMode = detected.hasDevBranch ? "developer-branch" : "trunk";
      options.mode = await promptSingleSelect(prompter, {
        title: "Branch mode",
        defaultId: defaultMode,
        choices: [
          { id: "trunk", label: "trunk", detail: `branch directly from ${detected.defaultBranch}`, aliases: ["t"] },
          {
            id: "developer-branch",
            label: "developer-branch",
            detail: `personal dev branch -> ${detected.integrationBranch} PR -> ${detected.defaultBranch}`,
            aliases: ["dev", "d"],
          },
        ],
      });
    }

    if (options.mode === "trunk" && !options.finishTargetExplicit) {
      const defaultFinish = detected.isHostedGit ? "pr" : "merge";
      options.finishTarget = await promptSingleSelect(prompter, {
        title: "Trunk finish target",
        defaultId: defaultFinish,
        choices: [
          { id: "merge", label: "merge", detail: `merge locally into ${detected.defaultBranch} & push`, aliases: ["m"] },
          { id: "pr", label: "pr", detail: "push task branch for Pull Request", aliases: ["p"] },
        ],
      });
    }

    if (!options.hooksExplicit) {
      if (options.minimal) {
        const hookChoice = await promptSingleSelect(prompter, {
          title: "Git hooks",
          defaultId: "local",
          choices: [
            { id: "local", label: "local", detail: "install in .git/hooks/ (0 tracked files)", aliases: ["y", "yes", "l"] },
            { id: "none", label: "none", detail: "skip Git hooks", aliases: ["n", "no"] },
          ],
        });
        if (hookChoice === "local") {
          options.localHooks = true;
        } else {
          options.noHooks = true;
        }
      } else {
        const hookChoice = await promptSingleSelect(prompter, {
          title: "Git hooks",
          defaultId: "repo",
          choices: [
            { id: "repo", label: "repo", detail: "tracked .githooks/ via core.hooksPath", aliases: ["r", "y", "yes"] },
            { id: "local", label: "local", detail: "local .git/hooks/ (0 tracked files)", aliases: ["l"] },
            { id: "none", label: "none", detail: "skip Git hooks", aliases: ["n", "no"] },
          ],
        });
        if (hookChoice === "none") {
          options.noHooks = true;
        } else if (hookChoice === "local") {
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
          detail: "600 prod / 700 style / 900 test + pre-commit",
          checked: Boolean(options.withSizeBudget || options.preset === "full" || existingConfig?.fileSizeBudget),
        },
        {
          id: "regression",
          label: "Regression Guardian",
          detail: "regression-ledger.yml + impact check + Skill",
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
          label: "Codex subagents",
          detail: ".codex/agents/*.toml read-only templates",
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
