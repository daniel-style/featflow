import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  findManagedAgentDocs,
  inspectAgentDocBlock,
  renderAgentWorkflowBlock,
  resolveAgentDocTargets,
  upsertAgentDocBlock,
} from "../agent-docs.mjs";
import { loadConfig, packageRoot } from "../config.mjs";
import { fail, findRepoRoot } from "../git.mjs";
import { configureGitHooksSafely } from "./hooks-cmd.mjs";

const VALID_GROUPS = new Set(["skill", "issues-skill", "templates", "githooks", "agent-docs"]);

const usage = `
Usage:
  featflow sync [options]

Synchronizes featflow-managed files (Skill, optional featflow-issues Skill, feature templates,
.githooks, and managed AGENTS.md / CLAUDE.md workflow blocks) from the installed featflow
package into the current repository without touching .featflow.json, active/done
feature records, or custom content outside <!-- FEATFLOW_START --> markers.

Options:
  --check              Verify managed files match the installed featflow version (exit 1 on drift).
  --dry-run            Print files that would be created or updated without writing.
  --only <groups>      Comma-separated subset: skill,issues-skill,templates,githooks,agent-docs.
  --with-issues-skill  Include .agents/skills/featflow-issues/SKILL.md even if issues is not configured yet.
  --skip-issues-skill  Skip .agents/skills/featflow-issues/SKILL.md even if issues is configured.
  --with-githooks      Include .githooks even if the directory does not exist yet.
  --skip-githooks      Skip .githooks even if the directory exists.
  --with-agent-docs    Include AGENTS.md / CLAUDE.md even if no managed block exists yet.
  --skip-agent-docs    Skip AGENTS.md / CLAUDE.md even if a managed block exists.
  --json               Output machine-readable JSON.
  -h, --help           Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    check: false,
    dryRun: false,
    only: null,
    withIssuesSkill: false,
    skipIssuesSkill: false,
    withGithooks: false,
    skipGithooks: false,
    withAgentDocs: false,
    skipAgentDocs: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--with-issues-skill") {
      options.withIssuesSkill = true;
      continue;
    }
    if (arg === "--skip-issues-skill") {
      options.skipIssuesSkill = true;
      continue;
    }
    if (arg === "--with-githooks") {
      options.withGithooks = true;
      continue;
    }
    if (arg === "--skip-githooks") {
      options.skipGithooks = true;
      continue;
    }
    if (arg === "--with-agent-docs") {
      options.withAgentDocs = true;
      continue;
    }
    if (arg === "--skip-agent-docs") {
      options.skipAgentDocs = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--only") {
      options.only = argv[++i] ?? "";
      continue;
    }
    if (arg.startsWith("--only=")) {
      options.only = arg.slice("--only=".length);
      continue;
    }
    fail(`Unknown option: ${arg}`, usage);
  }

  return options;
}

function normalizeLineEndings(content) {
  return content.replace(/\r\n/g, "\n");
}

function resolveGroups(options, repoRoot, config) {
  if (options.only !== null) {
    const requested = options.only
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (requested.length === 0) {
      fail("--only requires at least one group (skill, issues-skill, templates, githooks, agent-docs).", usage);
    }
    for (const group of requested) {
      if (!VALID_GROUPS.has(group)) {
        fail(`Unknown --only group "${group}". Valid groups: skill, issues-skill, templates, githooks, agent-docs.`, usage);
      }
    }
    return new Set(requested);
  }

  const hasRepoSkill = existsSync(path.join(repoRoot, ".agents", "skills", "featflow", "SKILL.md"));
  const hasIssuesSkill = existsSync(path.join(repoRoot, ".agents", "skills", "featflow-issues", "SKILL.md"));
  const hasRepoTemplates = existsSync(path.join(repoRoot, config.featuresDir, "_template.md"));
  const hasGithooksDir = existsSync(path.join(repoRoot, ".githooks"));
  const managedAgentDocs = findManagedAgentDocs(repoRoot);
  const isMinimalLayout = managedAgentDocs.length > 0 && !hasRepoSkill && !hasRepoTemplates;

  const groups = new Set();
  if (!isMinimalLayout) {
    groups.add("skill");
    groups.add("templates");
  }
  if (
    !options.skipIssuesSkill &&
    (options.withIssuesSkill || hasIssuesSkill || (!isMinimalLayout && Boolean(config.issues)))
  ) {
    groups.add("issues-skill");
  }
  if (!options.skipGithooks && (options.withGithooks || hasGithooksDir)) {
    groups.add("githooks");
  }
  if (!options.skipAgentDocs && (options.withAgentDocs || managedAgentDocs.length > 0)) {
    groups.add("agent-docs");
  }
  return groups;
}

export function buildManagedFiles(repoRoot, config, groups) {
  const files = [];

  if (groups.has("skill")) {
    files.push({
      kind: "file",
      group: "skill",
      src: path.join(packageRoot, "skills", "featflow", "SKILL.md"),
      dest: path.join(repoRoot, ".agents", "skills", "featflow", "SKILL.md"),
      executable: false,
    });
  }

  if (groups.has("issues-skill")) {
    files.push({
      kind: "file",
      group: "issues-skill",
      src: path.join(packageRoot, "skills", "featflow-issues", "SKILL.md"),
      dest: path.join(repoRoot, ".agents", "skills", "featflow-issues", "SKILL.md"),
      executable: false,
    });
  }

  if (groups.has("templates")) {
    const srcDir = path.join(packageRoot, "templates", "features");
    const destDir = path.join(repoRoot, config.featuresDir);
    for (const name of ["README.md", "_template.md", "_program_template.md"]) {
      files.push({
        kind: "file",
        group: "templates",
        src: path.join(srcDir, name),
        dest: path.join(destDir, name),
        executable: false,
      });
    }
  }

  if (groups.has("githooks")) {
    const srcDir = path.join(packageRoot, "templates", "githooks");
    const destDir = path.join(repoRoot, ".githooks");
    for (const hook of ["pre-commit", "pre-push", "post-merge"]) {
      files.push({
        kind: "file",
        group: "githooks",
        src: path.join(srcDir, hook),
        dest: path.join(destDir, hook),
        executable: true,
      });
    }
  }

  if (groups.has("agent-docs")) {
    const managed = findManagedAgentDocs(repoRoot);
    const targets = managed.length > 0 ? managed : resolveAgentDocTargets(repoRoot);
    for (const rel of targets) {
      files.push({
        kind: "agent-doc",
        group: "agent-docs",
        src: path.join(packageRoot, "templates", "snippets", "AGENTS-workflow.md"),
        dest: path.resolve(repoRoot, rel),
        executable: false,
      });
    }
  }

  return files;
}

export function inspectSyncState(repoRoot, config, groups) {
  const managed = buildManagedFiles(repoRoot, config, groups);
  const renderedBlock = groups.has("agent-docs") ? renderAgentWorkflowBlock() : "";
  const missing = [];
  const drifted = [];
  const upToDate = [];

  for (const entry of managed) {
    const rel = path.relative(repoRoot, entry.dest).replaceAll("\\", "/");
    if (entry.kind === "agent-doc") {
      const check = inspectAgentDocBlock(entry.dest, renderedBlock);
      if (check.status === "missing-file" || check.status === "missing-block") {
        missing.push({ ...entry, rel });
      } else if (check.status === "drifted") {
        drifted.push({ ...entry, rel });
      } else {
        upToDate.push({ ...entry, rel });
      }
      continue;
    }

    if (!existsSync(entry.dest)) {
      missing.push({ ...entry, rel });
      continue;
    }
    const expected = normalizeLineEndings(readFileSync(entry.src, "utf8"));
    const actual = normalizeLineEndings(readFileSync(entry.dest, "utf8"));
    if (expected !== actual) {
      drifted.push({ ...entry, rel });
    } else {
      upToDate.push({ ...entry, rel });
    }
  }

  return {
    ok: missing.length === 0 && drifted.length === 0,
    missing,
    drifted,
    upToDate,
  };
}

export async function runSync(argv) {
  const options = parseArgs(argv);
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    fail("Not inside a Git repository.");
  }

  const { config } = loadConfig(repoRoot);
  const groups = resolveGroups(options, repoRoot, config);
  const state = inspectSyncState(repoRoot, config, groups);

  if (options.check) {
    const summary = {
      ok: state.ok,
      groups: [...groups],
      missing: state.missing.map((item) => item.rel),
      drifted: state.drifted.map((item) => item.rel),
      upToDate: state.upToDate.map((item) => item.rel),
    };
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else if (state.ok) {
      console.log(`featflow sync --check passed (${state.upToDate.length} managed files up to date).`);
    } else {
      console.error("featflow sync --check found out-of-date managed files:");
      for (const item of state.missing) {
        console.error(`  [missing] ${item.rel}`);
      }
      for (const item of state.drifted) {
        console.error(`  [drifted] ${item.rel}`);
      }
      console.error("\nRun `featflow sync` to update them (your .featflow.json will not be modified).");
    }
    if (!state.ok) {
      process.exit(1);
    }
    return;
  }

  const pending = [...state.missing, ...state.drifted];
  const created = [];
  const updated = [];
  const renderedBlock = groups.has("agent-docs") ? renderAgentWorkflowBlock() : "";

  for (const item of pending) {
    if (item.kind === "agent-doc") {
      const result = upsertAgentDocBlock(item.dest, renderedBlock, { dryRun: options.dryRun });
      if (result.action === "created") {
        created.push(item.rel);
      } else if (result.action === "updated") {
        updated.push(item.rel);
      }
      continue;
    }

    const isNew = !existsSync(item.dest);
    if (!options.dryRun) {
      mkdirSync(path.dirname(item.dest), { recursive: true });
      copyFileSync(item.src, item.dest);
      if (item.executable) {
        chmodSync(item.dest, 0o755);
      }
    }
    if (isNew) {
      created.push(item.rel);
    } else {
      updated.push(item.rel);
    }
  }

  let hookResult = null;
  if (options.withGithooks && !options.dryRun) {
    hookResult = configureGitHooksSafely(repoRoot);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          dryRun: options.dryRun,
          groups: [...groups],
          created,
          updated,
          upToDate: state.upToDate.map((item) => item.rel),
          hookResult,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (created.length === 0 && updated.length === 0) {
    console.log(`All ${state.upToDate.length} managed featflow files are already up to date.`);
  } else {
    const verb = options.dryRun ? "Would sync" : "Synced";
    console.log(`${verb} featflow managed files (kept .featflow.json untouched):`);
    for (const rel of created) {
      console.log(`  + ${rel}`);
    }
    for (const rel of updated) {
      console.log(`  ~ ${rel}`);
    }
  }

  if (hookResult && !hookResult.configured) {
    console.log("");
    console.log(`Kept existing core.hooksPath=${hookResult.existingHooksPath} (did not overwrite).`);
  } else if (hookResult?.configured) {
    console.log("");
    console.log("Git hooks enabled: core.hooksPath=.githooks");
  }
}
