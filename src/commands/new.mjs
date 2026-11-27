import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadConfig, packageRoot } from "../config.mjs";
import {
  currentBranch,
  fail,
  findGitCommonDir,
  findRepoRoot,
  gitConfigGet,
} from "../git.mjs";

const LOCAL_FEATURES_DIR = ".featflow/features";

const usage = `
Usage:
  featflow new <slug> [options]

Creates a new feature (or program) record using the repository's template if
present, or featflow's built-in template — works even in repositories without
running "featflow init".

Options:
  --title <text>      Human-readable title (defaults to Title Case of <slug>).
  --branch <name>     Override tracked branch recorded in frontmatter & Branch Plan.
  --status <status>   Initial status (default: planned).
  --program           Create a multi-phase program record under programs/ instead of active/.
  --local             Write to .featflow/features/ and add to .git/info/exclude (zero tracked files).
  --dir <path>        Override features base directory.
  --update-pointer    Update current-feature.md pointer file when creating a feature record.
  --template          Print the resolved template to stdout without writing any file.
  --dry-run           Print target path without writing.
  -h, --help          Show this help.
`.trim();

function parseArgs(argv) {
  const options = {
    slug: "",
    title: "",
    branch: "",
    status: "planned",
    program: false,
    local: false,
    dir: "",
    updatePointer: false,
    templateOnly: false,
    dryRun: false,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--program") {
      options.program = true;
      continue;
    }
    if (arg === "--local") {
      options.local = true;
      continue;
    }
    if (arg === "--update-pointer") {
      options.updatePointer = true;
      continue;
    }
    if (arg === "--template") {
      options.templateOnly = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (["--title", "--branch", "--status", "--dir"].includes(arg)) {
      const value = argv[++i] ?? "";
      if (!value) {
        fail(`Missing value for ${arg}.`, usage);
      }
      options[arg.slice(2)] = value;
      continue;
    }
    if (/^--(?:title|branch|status|dir)=/.test(arg)) {
      const idx = arg.indexOf("=");
      options[arg.slice(2, idx)] = arg.slice(idx + 1);
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`, usage);
    }
    positional.push(arg);
  }

  if (!options.templateOnly && positional.length === 0) {
    fail("Missing feature slug (e.g. `featflow new oauth-pkce-login`).", usage);
  }
  options.slug = positional.join("-");
  return options;
}

export function slugify(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleFromSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatLocalTimestamps(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offH = pad(Math.floor(absOffset / 60));
  const offM = pad(absOffset % 60);
  const tz = offsetMinutes === 0 ? "Z" : `${sign}${offH}:${offM}`;

  return {
    datePart: `${year}-${month}-${day}`,
    dateTimePart: `${year}-${month}-${day}-${hour}${minute}`,
    logStamp: `${year}-${month}-${day} ${hour}:${minute}`,
    iso: `${year}-${month}-${day}T${hour}:${minute}:${second}${tz}`,
  };
}

export function ensureGitInfoExclude(repoRoot, entries) {
  const commonDir = findGitCommonDir(repoRoot);
  if (!commonDir) {
    return [];
  }
  const excludePath = path.join(commonDir, "info", "exclude");
  mkdirSync(path.dirname(excludePath), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const toAdd = entries.filter((entry) => !lines.includes(entry));
  if (toAdd.length === 0) {
    return [];
  }
  const block = [
    existing && !existing.endsWith("\n") ? "\n" : "",
    existing ? "\n" : "",
    "# featflow local-only state\n",
    ...toAdd.map((entry) => `${entry}\n`),
  ].join("");
  writeFileSync(excludePath, `${existing}${block}`, "utf8");
  return toAdd;
}

function loadTemplate(repoRoot, featuresBaseDir, isProgram) {
  const filename = isProgram ? "_program_template.md" : "_template.md";
  const repoTemplate = path.join(repoRoot, featuresBaseDir, filename);
  if (existsSync(repoTemplate)) {
    return readFileSync(repoTemplate, "utf8");
  }
  return readFileSync(path.join(packageRoot, "templates", "features", filename), "utf8");
}

function populateTemplate(template, vars) {
  let content = template;
  if (vars.isProgram) {
    content = content
      .replace(/^id:\s*.*$/m, `id: ${vars.id}`)
      .replace(/^title:\s*.*$/m, `title: ${vars.title}`)
      .replace(/^status:\s*.*$/m, `status: ${vars.status}`)
      .replace(/^created:\s*.*$/m, `created: ${vars.iso}`)
      .replace(/^updated:\s*.*$/m, `updated: ${vars.iso}`)
      .replace(/^owner:\s*.*$/m, `owner: ${vars.owner}`)
      .replace(/^- YYYY-MM-DD HH:MM: Program record created\.$/m, `- ${vars.logStamp}: Program record created.`);
    return content;
  }

  content = content
    .replace(/^id:\s*.*$/m, `id: ${vars.id}`)
    .replace(/^title:\s*.*$/m, `title: ${vars.title}`)
    .replace(/^status:\s*.*$/m, `status: ${vars.status}`)
    .replace(/^branch:\s*.*$/m, `branch: ${vars.branch}`)
    .replace(/^created:\s*.*$/m, `created: ${vars.iso}`)
    .replace(/^updated:\s*.*$/m, `updated: ${vars.iso}`)
    .replace(/^owner:\s*.*$/m, `owner: ${vars.owner}`)
    .replace(/^- Workflow mode:.*$/m, `- Workflow mode: \`${vars.mode}\``)
    .replace(/^- Base branch:.*$/m, `- Base branch: \`${vars.baseBranch}\``)
    .replace(/^- Tracked branch:.*$/m, `- Tracked branch: \`${vars.branch}\``)
    .replace(/^- Worktree path:.*$/m, `- Worktree path: \`${vars.worktreePath}\``)
    .replace(/^- YYYY-MM-DD HH:MM: Started planning\.$/m, `- ${vars.logStamp}: Started planning.`);

  return content;
}

export async function runNew(argv) {
  const options = parseArgs(argv);
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    fail("Not inside a Git repository.");
  }

  const { config } = loadConfig(repoRoot);
  const featuresBaseDir = options.dir || (options.local ? LOCAL_FEATURES_DIR : config.featuresDir);
  const rawTemplate = loadTemplate(repoRoot, featuresBaseDir, options.program);

  if (options.templateOnly) {
    process.stdout.write(rawTemplate);
    return;
  }

  const cleanSlug = slugify(options.slug);
  if (!cleanSlug) {
    fail(`Invalid slug "${options.slug}". Provide alphanumeric words such as "oauth-login".`, usage);
  }

  const stamps = formatLocalTimestamps();
  const id = options.program ? `${stamps.datePart}-${cleanSlug}` : `${stamps.dateTimePart}-${cleanSlug}`;
  const title = options.title || titleFromSlug(cleanSlug);
  const owner = gitConfigGet("user.name", repoRoot) || "Unknown";
  const branchNow = currentBranch(repoRoot);
  const devBranch = config.mode === "developer-branch" ? gitConfigGet(config.developerBranchConfigKey, repoRoot) : "";
  const baseBranch = config.mode === "developer-branch" ? (devBranch || config.integrationBranch) : config.baseBranch;
  const protectedSet = new Set(config.protectedBranches);
  const inferredBranch =
    branchNow && !protectedSet.has(branchNow) && branchNow !== devBranch
      ? branchNow
      : config.mode === "developer-branch" && devBranch
        ? `feat/${devBranch}-${cleanSlug}`
        : `feat/${cleanSlug}`;
  const branch = options.branch || inferredBranch;

  const subdir = options.program ? "programs" : "active";
  const relPath = path.posix.join(featuresBaseDir.replaceAll("\\", "/"), subdir, `${id}.md`);
  const absPath = path.resolve(repoRoot, relPath);

  if (existsSync(absPath)) {
    fail(`Record already exists: ${relPath}`);
  }

  const rendered = populateTemplate(rawTemplate, {
    isProgram: options.program,
    id,
    title,
    status: options.status,
    branch,
    iso: stamps.iso,
    logStamp: stamps.logStamp,
    owner,
    mode: config.mode,
    baseBranch,
    worktreePath: repoRoot,
  });

  if (options.dryRun) {
    console.log(`[dry-run] Would create ${relPath}`);
    return;
  }

  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, rendered, "utf8");

  if (options.local) {
    ensureGitInfoExclude(repoRoot, [".featflow/"]);
  }

  if (!options.program && (options.updatePointer || existsSync(path.resolve(repoRoot, featuresBaseDir, "current-feature.md")))) {
    const pointerPath = path.resolve(repoRoot, featuresBaseDir, "current-feature.md");
    const existingPointer = existsSync(pointerPath) ? readFileSync(pointerPath, "utf8") : "";
    const lastCompletedMatch = existingPointer.match(/^last_completed:[ \t]*([^\r\n]*)$/m);
    const lastCompleted = lastCompletedMatch ? lastCompletedMatch[1].trim() : "";
    const pointerContent = [
      "---",
      `status: ${options.status}`,
      `updated: ${stamps.iso}`,
      `active_feature: active/${id}.md`,
      lastCompleted ? `last_completed: ${lastCompleted}` : "last_completed:",
      "---",
      "",
      "# Current Feature",
      "",
      `${title} (${branch}).`,
      "",
      "# Next Step",
      "",
      "- Complete `Plan Details` and wait for approval before editing product code.",
      "",
      "# Blockers",
      "",
      "- None.",
      "",
    ].join("\n");
    writeFileSync(pointerPath, pointerContent, "utf8");
  }

  console.log(`Created ${options.program ? "program" : "feature"} record: ${relPath}`);
  if (options.local) {
    console.log("Stored locally under .featflow/features/ (excluded via .git/info/exclude; zero tracked files added).");
  }
  console.log(`Next: fill Plan Details and run \`featflow plan-check ${relPath}\`.`);
}
