import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_AGENT_DOC_CANDIDATES,
  findManagedAgentDocs,
  inspectAgentDocBlock,
  renderAgentWorkflowBlock,
} from "../agent-docs.mjs";
import { loadConfig } from "../config.mjs";
import { commandExists, findGitCommonDir, findRepoRoot, gitConfigGet, localBranchExists } from "../git.mjs";
import { validateActiveFeaturePlan } from "../plan.mjs";
import { inspectCodegraphState } from "./codegraph.mjs";
import { inspectSyncState } from "./sync.mjs";

const usage = `
Usage:
  featflow doctor

Checks Git, .featflow.json, feature templates, skill installation (repo or global),
managed AGENTS.md / CLAUDE.md blocks, Git hooks, and active feature plan health.
`.trim();

function findGlobalSkillPath() {
  const home = process.env.FEATFLOW_HOME || os.homedir();
  if (!home) {
    return null;
  }
  const candidates = [
    path.join(home, ".agents", "skills", "featflow", "SKILL.md"),
    path.join(home, ".claude", "skills", "featflow", "SKILL.md"),
    path.join(home, ".codex", "skills", "featflow", "SKILL.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const display = candidate.startsWith(home)
        ? `~${candidate.slice(home.length).replaceAll("\\", "/")}`
        : candidate;
      return { fullPath: candidate, display };
    }
  }
  return null;
}

export async function runDoctor(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(usage);
    return;
  }

  const checks = [];
  const add = (status, label, detail) => checks.push({ status, label, detail });

  add(commandExists("git") ? "PASS" : "FAIL", "Git CLI", commandExists("git") ? "available" : "git not found");
  add(
    commandExists("gh") ? "PASS" : "INFO",
    "GitHub CLI (gh)",
    commandExists("gh") ? "available (for issue & pr-cleanup)" : "optional — needed only for issue & pr-cleanup",
  );

  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    add("FAIL", "Git repository", "Not inside a Git repository.");
    printChecks(checks);
    process.exit(1);
  }

  let loaded;
  try {
    loaded = loadConfig(repoRoot);
    add(
      loaded.hasConfigFile ? "PASS" : "INFO",
      "Config (.featflow.json)",
      loaded.hasConfigFile
        ? `mode=${loaded.config.mode}`
        : "not found (using global defaults; run `featflow init --minimal` to customize)",
    );
  } catch (error) {
    add("FAIL", "Config (.featflow.json)", error instanceof Error ? error.message : String(error));
    printChecks(checks);
    process.exit(1);
  }

  const { config } = loaded;

  const templatePath = path.join(repoRoot, config.featuresDir, "_template.md");
  const hasRepoTemplates =
    existsSync(templatePath) ||
    existsSync(path.join(repoRoot, config.featuresDir, "README.md")) ||
    existsSync(path.join(repoRoot, config.featuresDir, "_program_template.md"));

  if (existsSync(templatePath)) {
    add("PASS", "Feature template", path.relative(repoRoot, templatePath));
  } else {
    add("PASS", "Feature template", "using built-in template (global/minimal mode)");
  }

  const repoSkillPath = path.join(repoRoot, ".agents", "skills", "featflow", "SKILL.md");
  const hasRepoSkill = existsSync(repoSkillPath);
  const globalSkill = hasRepoSkill ? null : findGlobalSkillPath();
  if (hasRepoSkill) {
    add("PASS", "Agent Skill", ".agents/skills/featflow/SKILL.md");
  } else if (globalSkill) {
    add("PASS", "Agent Skill", `global (${globalSkill.display})`);
  } else {
    add(
      "WARN",
      "Agent Skill",
      "not found in repo or global skill dirs (run `npx skills add https://github.com/daniel-style/featflow --skill featflow -g` or `featflow init`)",
    );
  }

  const managedAgentDocs = findManagedAgentDocs(repoRoot);
  if (managedAgentDocs.length > 0) {
    const renderedBlock = renderAgentWorkflowBlock();
    const driftedDocs = managedAgentDocs.filter(
      (rel) => inspectAgentDocBlock(path.resolve(repoRoot, rel), renderedBlock).status !== "up-to-date",
    );
    if (driftedDocs.length === 0) {
      add("PASS", "Agent docs", `${managedAgentDocs.join(", ")} (managed block up to date)`);
    } else {
      add("WARN", "Agent docs", `drifted: ${driftedDocs.join(", ")} (run \`featflow sync\`)`);
    }
  } else {
    const existingRawDocs = DEFAULT_AGENT_DOC_CANDIDATES.filter((rel) => existsSync(path.join(repoRoot, rel)));
    if (existingRawDocs.length > 0) {
      add(
        "INFO",
        "Agent docs",
        `${existingRawDocs.join(", ")} has no featflow managed block (run \`featflow sync --only agent-docs\`)`,
      );
    } else {
      add("INFO", "Agent docs", "no AGENTS.md/CLAUDE.md managed block (run `featflow sync --only agent-docs` or `featflow init`)");
    }
  }

  const hasIssuesSkill = existsSync(path.join(repoRoot, ".agents", "skills", "featflow-issues", "SKILL.md"));
  const hasRegressionSkill = existsSync(path.join(repoRoot, ".agents", "skills", "featflow-regression", "SKILL.md"));
  if (config.issues) {
    const assetsDetail = config.issues.assetsRepo ? `, assetsRepo=${config.issues.assetsRepo}` : "";
    add("PASS", "Issues workflow", `enabled (${config.issues.provider}${assetsDetail})`);
  }
  if (config.fileSizeBudget) {
    const preCommitTag = config.fileSizeBudget.enforceInPreCommit ? ", pre-commit=on" : "";
    add(
      "PASS",
      "File size budget",
      `enabled (prod=${config.fileSizeBudget.production}, style=${config.fileSizeBudget.style}, test=${config.fileSizeBudget.test}${preCommitTag})`,
    );
  }
  if (config.regression) {
    const ledgerExists = existsSync(path.resolve(repoRoot, config.regression.ledgerFile));
    add(
      ledgerExists ? "PASS" : "WARN",
      "Regression ledger",
      ledgerExists ? config.regression.ledgerFile : `configured "${config.regression.ledgerFile}" not found`,
    );
  }

  const configuredAgentHooks = [];
  if (existsSync(path.join(repoRoot, ".agents", "hooks.json"))) configuredAgentHooks.push("antigravity");
  if (existsSync(path.join(repoRoot, ".claude", "settings.json"))) configuredAgentHooks.push("claude-code");
  if (existsSync(path.join(repoRoot, ".codex", "config.toml"))) configuredAgentHooks.push("codex");
  if (existsSync(path.join(repoRoot, ".cursor", "hooks.json"))) configuredAgentHooks.push("cursor");
  if (configuredAgentHooks.length > 0) {
    add("PASS", "AI Agent hooks", configuredAgentHooks.join(", "));
  } else {
    add("INFO", "AI Agent hooks", "none installed (run `featflow init --merge --with-all-hooks` or interactive `featflow init --merge`)");
  }

  const cg = inspectCodegraphState(repoRoot);
  if (cg.installed) {
    add("PASS", "CodeGraph", cg.indexed ? "CLI available, local index present" : "CLI available (run `featflow codegraph` to index)");
  } else {
    add("INFO", "CodeGraph", "optional — CLI not installed");
  }

  const syncGroups = new Set();
  if (hasRepoSkill) {
    syncGroups.add("skill");
  }
  if (hasIssuesSkill || (Boolean(config.issues) && (hasRepoSkill || hasRepoTemplates))) {
    syncGroups.add("issues-skill");
  }
  if (hasRegressionSkill) {
    syncGroups.add("regression-skill");
  }
  if (hasRepoTemplates) {
    syncGroups.add("templates");
  }
  if (existsSync(path.join(repoRoot, ".githooks"))) {
    syncGroups.add("githooks");
  }
  if (managedAgentDocs.length > 0) {
    syncGroups.add("agent-docs");
  }

  if (syncGroups.size === 0) {
    add("PASS", "Managed files sync", "zero-footprint mode (no repo-managed files)");
  } else {
    const syncState = inspectSyncState(repoRoot, config, syncGroups);
    if (syncState.ok) {
      add("PASS", "Managed files sync", `${syncState.upToDate.length} files match installed featflow`);
    } else {
      const issues = [
        ...syncState.missing.map((item) => `missing ${item.rel}`),
        ...syncState.drifted.map((item) => `drifted ${item.rel}`),
      ];
      add("WARN", "Managed files sync", `${issues.join(", ")} (run \`featflow sync\`)`);
    }
  }

  const hooksPath = gitConfigGet("core.hooksPath", repoRoot);
  const commonDir = findGitCommonDir(repoRoot);
  const localPreCommit = commonDir ? path.join(commonDir, "hooks", "pre-commit") : "";
  const hasLocalHook = Boolean(localPreCommit && existsSync(localPreCommit) && readFileSync(localPreCommit, "utf8").includes("featflow managed hook"));
  if (hooksPath === ".githooks") {
    add("PASS", "Git hooks", "core.hooksPath=.githooks");
  } else if (hooksPath) {
    add("INFO", "Git hooks", `external hooks manager detected (core.hooksPath=${hooksPath})`);
  } else if (hasLocalHook) {
    add("PASS", "Git hooks", "local .git/hooks managed blocks installed");
  } else {
    add("INFO", "Git hooks", "not configured (run `featflow hooks install --local` or `featflow init --with-githooks`)");
  }

  if (config.mode === "developer-branch") {
    const devBranch = gitConfigGet(config.developerBranchConfigKey, repoRoot);
    if (!devBranch) {
      add("FAIL", "Developer branch", `not configured (run \`featflow setup <your-branch>\`)`);
    } else if (!localBranchExists(devBranch, repoRoot)) {
      add("FAIL", "Developer branch", `configured "${devBranch}" does not exist locally`);
    } else {
      add("PASS", "Developer branch", devBranch);
    }
  } else {
    add(
      localBranchExists(config.baseBranch, repoRoot) ? "PASS" : "WARN",
      "Base branch",
      localBranchExists(config.baseBranch, repoRoot) ? config.baseBranch : `local branch "${config.baseBranch}" not found yet`,
    );
  }

  const plan = validateActiveFeaturePlan(repoRoot, { featuresDir: config.featuresDir });
  if (plan.skipped) {
    add("PASS", "Active feature plan", "no active feature record");
  } else if (plan.ok) {
    add("PASS", "Active feature plan", `${plan.activeFeature} is complete and approved`);
  } else {
    add("WARN", "Active feature plan", `${plan.activeFeature}: ${plan.errors.join("; ")}`);
  }

  printChecks(checks);

  if (checks.some((item) => item.status === "FAIL")) {
    process.exit(1);
  }
}

function printChecks(checks) {
  for (const item of checks) {
    console.log(`[${item.status}] ${item.label}: ${item.detail}`);
  }
}
