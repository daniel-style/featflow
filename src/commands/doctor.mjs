import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "../config.mjs";
import { commandExists, findGitCommonDir, findRepoRoot, gitConfigGet, localBranchExists } from "../git.mjs";
import { validateActiveFeaturePlan } from "../plan.mjs";
import { inspectSyncState } from "./sync.mjs";

const usage = `
Usage:
  featflow doctor

Checks Git, .featflow.json, feature templates, skill installation, Git hooks,
and active feature plan health.
`.trim();

export async function runDoctor(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(usage);
    return;
  }

  const checks = [];
  const add = (status, label, detail) => checks.push({ status, label, detail });

  add(commandExists("git") ? "PASS" : "FAIL", "Git CLI", commandExists("git") ? "available" : "git not found");
  add(commandExists("gh") ? "PASS" : "INFO", "GitHub CLI (gh)", commandExists("gh") ? "available (for pr-cleanup)" : "optional — needed only for pr-cleanup");

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
      loaded.hasConfigFile ? "PASS" : "WARN",
      "Config (.featflow.json)",
      loaded.hasConfigFile ? `mode=${loaded.config.mode}` : "not found (using defaults; run `featflow init`)",
    );
  } catch (error) {
    add("FAIL", "Config (.featflow.json)", error instanceof Error ? error.message : String(error));
    printChecks(checks);
    process.exit(1);
  }

  const { config } = loaded;

  const templatePath = path.join(repoRoot, config.featuresDir, "_template.md");
  add(
    existsSync(templatePath) ? "PASS" : "WARN",
    "Feature template",
    existsSync(templatePath) ? path.relative(repoRoot, templatePath) : `missing (${config.featuresDir}/_template.md)`,
  );

  const skillPath = path.join(repoRoot, ".agents", "skills", "featflow", "SKILL.md");
  add(
    existsSync(skillPath) ? "PASS" : "WARN",
    "Agent Skill",
    existsSync(skillPath) ? ".agents/skills/featflow/SKILL.md" : "not installed in repo (run `featflow init` or `npx skills add`)",
  );

  const syncGroups = new Set(["skill", "templates"]);
  if (existsSync(path.join(repoRoot, ".githooks"))) {
    syncGroups.add("githooks");
  }
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
