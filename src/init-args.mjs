import { fail } from "./git.mjs";
import { parseAgentHooksList } from "./init-hooks.mjs";

export const INIT_USAGE = `
Usage:
  featflow init [options]

Scaffolds or upgrades featflow in the current Git repository with automatic
environment detection, interactive multi-select checkboxes on TTY, universal
AI agent hooks, and non-destructive AGENTS.md / CLAUDE.md workflow injection.

Options:
  --preset <minimal|standard|full> Preset bundle ("full" enables size-budget, regression, issues, codex-agents, repo Git hooks & all 4 agent hooks).
  --minimal                        Shortcut for --preset minimal (lightweight .featflow.json + AGENTS.md + local hooks).
  --merge                          Non-destructively upgrade an existing .featflow.json repo (preserves existing keys & unmanaged AGENTS.md).
  --mode <trunk|developer-branch>  Branch topology preset (default: trunk, or prompted on TTY).
  --finish-target <merge|pr>       In trunk mode, whether "finish" merges into base or pushes for PR (default: merge).
  --features-dir <dir>             Custom directory for feature records (default: features).
  --local-features                 Store feature records locally (.gitignore features/) instead of tracking in Git.
  --track-pointer                  Track features/current-feature.md in Git instead of ignoring it locally.
  --with-githooks                  Copy tracked .githooks/ and enable core.hooksPath when not claimed by Husky/Lefthook.
  --local-hooks                    Install managed Git hook blocks in .git/hooks/ (default in --minimal).
  --no-hooks                       Skip Git hook installation.
  --agent-hooks <list|all|none>    Comma-separated agent hooks: antigravity,claude-code,codex,cursor (or "all" / "none").
  --with-all-hooks                 Install/merge hooks for all 4 supported agents (antigravity, claude-code, codex, cursor).
  --with-antigravity-hooks         Install or merge Antigravity hook configuration (.agents/hooks.json).
  --with-codex-hooks               Install or merge Codex hook configuration (.codex/config.toml).
  --with-claude-hooks              Install or merge Claude Code hook configuration (.claude/settings.json).
  --with-cursor-hooks              Install or merge Cursor hook configuration (.cursor/hooks.json).
  --with-codex-agents              Install generic read-only Codex subagent templates (.codex/agents/*.toml).
  --with-issues                    Enable optional GitHub Issues closed-loop config & featflow-issues Skill.
  --issue-assets-repo <o/r>        Configure issues.assetsRepo for screenshot uploads (implies --with-issues).
  --with-size-budget               Enable optional fileSizeBudget (600 prod / 700 style / 900 test + pre-commit guard).
  --with-regression                Enable optional regression ledger config, starter ledger & featflow-regression Skill.
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

function applyAgentHookSet(options, hookSet) {
  options.withAntigravityHooks = hookSet.has("antigravity");
  options.withClaudeHooks = hookSet.has("claude-code");
  options.withCodexHooks = hookSet.has("codex");
  options.withCursorHooks = hookSet.has("cursor");
}

export function parseInitArgs(argv) {
  const options = {
    preset: "",
    minimal: false,
    minimalExplicit: false,
    merge: false,
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
    withAntigravityHooks: false,
    withCodexHooks: false,
    withClaudeHooks: false,
    withCursorHooks: false,
    agentHooksExplicit: false,
    withCodexAgents: false,
    withIssues: false,
    issueAssetsRepo: "",
    withSizeBudget: false,
    withRegression: false,
    capabilitiesExplicit: false,
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
      console.log(INIT_USAGE);
      process.exit(0);
    }
    if (arg === "--preset" || arg.startsWith("--preset=")) {
      const value = arg.startsWith("--preset=") ? arg.slice("--preset=".length) : (argv[++i] ?? "");
      if (!["minimal", "standard", "full"].includes(value)) {
        fail(`Invalid value for --preset "${value}". Expected minimal, standard, or full.`, INIT_USAGE);
      }
      options.preset = value;
      options.minimal = value === "minimal";
      options.minimalExplicit = true;
      continue;
    }
    if (arg === "--minimal") {
      options.preset = "minimal";
      options.minimal = true;
      options.minimalExplicit = true;
      continue;
    }
    if (arg === "--merge") {
      options.merge = true;
      continue;
    }
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      options.mode = arg.startsWith("--mode=") ? arg.slice("--mode=".length) : (argv[++i] ?? "");
      options.modeExplicit = true;
      continue;
    }
    if (arg === "--finish-target" || arg.startsWith("--finish-target=")) {
      options.finishTarget = arg.startsWith("--finish-target=")
        ? arg.slice("--finish-target=".length)
        : (argv[++i] ?? "");
      options.finishTargetExplicit = true;
      continue;
    }
    if (arg === "--features-dir" || arg.startsWith("--features-dir=")) {
      options.featuresDir = arg.startsWith("--features-dir=")
        ? arg.slice("--features-dir=".length)
        : (argv[++i] ?? "");
      if (!options.featuresDir) fail("Missing value for --features-dir.", INIT_USAGE);
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
    if (arg === "--agent-hooks" || arg.startsWith("--agent-hooks=")) {
      const value = arg.startsWith("--agent-hooks=") ? arg.slice("--agent-hooks=".length) : (argv[++i] ?? "");
      try {
        applyAgentHookSet(options, parseAgentHooksList(value));
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error), INIT_USAGE);
      }
      options.agentHooksExplicit = true;
      continue;
    }
    if (arg === "--with-all-hooks") {
      applyAgentHookSet(options, parseAgentHooksList("all"));
      options.agentHooksExplicit = true;
      continue;
    }
    if (arg === "--with-antigravity-hooks") {
      options.withAntigravityHooks = true;
      options.agentHooksExplicit = true;
      continue;
    }
    if (arg === "--with-codex-hooks") {
      options.withCodexHooks = true;
      options.agentHooksExplicit = true;
      continue;
    }
    if (arg === "--with-claude-hooks") {
      options.withClaudeHooks = true;
      options.agentHooksExplicit = true;
      continue;
    }
    if (arg === "--with-cursor-hooks") {
      options.withCursorHooks = true;
      options.agentHooksExplicit = true;
      continue;
    }
    if (arg === "--with-codex-agents") {
      options.withCodexAgents = true;
      options.capabilitiesExplicit = true;
      continue;
    }
    if (arg === "--with-size-budget") {
      options.withSizeBudget = true;
      options.capabilitiesExplicit = true;
      continue;
    }
    if (arg === "--with-regression") {
      options.withRegression = true;
      options.capabilitiesExplicit = true;
      continue;
    }
    if (arg === "--with-issues") {
      options.withIssues = true;
      options.capabilitiesExplicit = true;
      continue;
    }
    if (arg === "--issue-assets-repo" || arg.startsWith("--issue-assets-repo=")) {
      options.issueAssetsRepo = arg.startsWith("--issue-assets-repo=")
        ? arg.slice("--issue-assets-repo=".length)
        : (argv[++i] ?? "");
      if (!options.issueAssetsRepo || !options.issueAssetsRepo.includes("/")) {
        fail('Invalid value for --issue-assets-repo. Expected "<owner>/<repo>".', INIT_USAGE);
      }
      options.withIssues = true;
      options.capabilitiesExplicit = true;
      continue;
    }
    if (arg === "--agent-docs" || arg.startsWith("--agent-docs=")) {
      const value = arg.startsWith("--agent-docs=") ? arg.slice("--agent-docs=".length) : (argv[++i] ?? "");
      if (!value) fail("Missing value for --agent-docs.", INIT_USAGE);
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
    if (arg === "--developer-branch" || arg.startsWith("--developer-branch=")) {
      options.developerBranch = arg.startsWith("--developer-branch=")
        ? arg.slice("--developer-branch=".length)
        : (argv[++i] ?? "");
      if (!options.developerBranch) fail("Missing value for --developer-branch.", INIT_USAGE);
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
    fail(`Unknown option: ${arg}`, INIT_USAGE);
  }

  if (options.preset === "full") {
    options.withSizeBudget = true;
    options.withRegression = true;
    options.withIssues = true;
    options.withCodexAgents = true;
    options.capabilitiesExplicit = true;
    if (!options.hooksExplicit) {
      options.withGithooks = true;
      options.hooksExplicit = true;
    }
    if (!options.agentHooksExplicit) {
      applyAgentHookSet(options, parseAgentHooksList("all"));
      options.agentHooksExplicit = true;
    }
  }

  return options;
}
