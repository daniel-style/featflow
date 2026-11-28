import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_ISSUES_CONFIG, DEFAULT_PREFIXES } from "./config.mjs";
import { commandExists, runReadSoft } from "./git.mjs";

export const VALID_ISSUE_TYPES = [...DEFAULT_PREFIXES];

export const TYPE_TO_DEFAULT_LABEL = {
  fix: "bug",
  feat: "enhancement",
  docs: "documentation",
};

export const VALID_PRIORITIES = ["p0", "p1", "p2"];

export const STANDARD_WORKFLOW_LABELS = [
  {
    name: "status:in-progress",
    color: "fbca04",
    description: "Claimed and actively being worked on in an isolated worktree",
  },
  {
    name: "status:in-review",
    color: "5319e7",
    description: "Fix pushed and verified; awaiting PR integration or manual review",
  },
  {
    name: "status:blocked",
    color: "b60205",
    description: "Work is blocked pending clarification or external dependency",
  },
  {
    name: "priority:p0",
    color: "b60205",
    description: "Critical urgency: production breakage, data loss, or security issue",
  },
  {
    name: "priority:p1",
    color: "d93f0b",
    description: "High priority: significant user or workflow impact",
  },
  {
    name: "priority:p2",
    color: "0e8a16",
    description: "Normal priority",
  },
  {
    name: "agent-ready",
    color: "0075ca",
    description: "Scoped and ready for AI coding agent pickup",
  },
];

export const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function failIssue(message) {
  throw new Error(message);
}

function formatLocalDateParts(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mi = pad(now.getMinutes());
  return {
    datePart: `${yyyy}-${mm}-${dd}`,
    featureStamp: `${yyyy}-${mm}-${dd}-${hh}${mi}`,
  };
}

function resolveGhInvocation(args) {
  const injectedScript = process.env.FEATFLOW_GH_SCRIPT;
  if (injectedScript) {
    return { command: process.execPath, argv: [injectedScript, ...args], isInjected: true };
  }
  return { command: "gh", argv: args, isInjected: false };
}

export function ghRun(args, { input, cwd = process.cwd() } = {}) {
  const { command, argv, isInjected } = resolveGhInvocation(args);
  if (!isInjected && !commandExists("gh")) {
    failIssue("GitHub CLI (`gh`) is required for `featflow issue`. Install `gh` and run `gh auth login`.");
  }
  const res = spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    input,
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (res.error) {
    failIssue(`gh ${args.join(" ")} failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || `exit code ${String(res.status)}`).trim();
    failIssue(`gh ${args.join(" ")} failed:\n${detail}`);
  }
  return (res.stdout ?? "").trim();
}

export function ghRunSoft(args, { input, cwd = process.cwd() } = {}) {
  const { command, argv } = resolveGhInvocation(args);
  const res = spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    input,
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  return {
    status: res.status ?? -1,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

export function getCurrentGitHubUser(cwd = process.cwd()) {
  return ghRun(["api", "user", "--jq", ".login"], { cwd });
}

export function parseGitHubRepoFromRemoteUrl(remoteUrl) {
  const trimmed = String(remoteUrl ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const patterns = [
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^https?:\/\/(?:[^@\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  ];
  for (const regex of patterns) {
    const match = trimmed.match(regex);
    if (match) {
      const owner = match[1];
      const name = match[2];
      return { owner, name, slug: `${owner}/${name}` };
    }
  }
  return null;
}

export function resolveGitHubRepoSlug(repoRoot, config, explicitRepo = "") {
  const cleanExplicit = String(explicitRepo ?? "").trim();
  if (cleanExplicit) {
    if (!cleanExplicit.includes("/")) {
      failIssue(`Invalid --repo "${cleanExplicit}". Expected "<owner>/<repo>".`);
    }
    const [owner, name] = cleanExplicit.split("/");
    return { owner, name, slug: `${owner}/${name}` };
  }

  if (config?.issues?.repo && config.issues.repo.includes("/")) {
    const [owner, name] = config.issues.repo.split("/");
    return { owner, name, slug: `${owner}/${name}` };
  }

  const remoteName = config?.remote || "origin";
  const remoteRes = runReadSoft("git", ["remote", "get-url", remoteName], repoRoot);
  if (remoteRes.status === 0 && remoteRes.stdout) {
    const parsed = parseGitHubRepoFromRemoteUrl(remoteRes.stdout);
    if (parsed) {
      return parsed;
    }
  }

  if (process.env.FEATFLOW_GH_SCRIPT || commandExists("gh")) {
    const ghRes = ghRunSoft(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: repoRoot });
    if (ghRes.status === 0 && ghRes.stdout.includes("/")) {
      const [owner, name] = ghRes.stdout.split("/");
      return { owner, name, slug: `${owner}/${name}` };
    }
  }

  failIssue(
    `Could not determine GitHub repository from remote "${remoteName}". Set \`issues.repo\` in .featflow.json or pass \`--repo <owner>/<repo>\`.`,
  );
}

export function parseIssueRef(rawRef, defaultRepoSlug = "") {
  const trimmed = String(rawRef ?? "").trim();
  if (!trimmed) {
    failIssue(
      "Missing issue reference (expected `<number>`, `#<number>`, `<owner>/<repo>#<number>`, or a GitHub Issue URL).",
    );
  }

  const urlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/i);
  if (urlMatch) {
    const [, owner, name, numStr] = urlMatch;
    return { owner, repoName: name, repoSlug: `${owner}/${name}`, number: Number(numStr), ref: `${name}#${numStr}` };
  }

  const slugHashMatch = trimmed.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (slugHashMatch) {
    const [, owner, name, numStr] = slugHashMatch;
    return { owner, repoName: name, repoSlug: `${owner}/${name}`, number: Number(numStr), ref: `${name}#${numStr}` };
  }

  const numMatch = trimmed.match(/^#?(\d+)$/);
  if (numMatch && defaultRepoSlug && defaultRepoSlug.includes("/")) {
    const [owner, name] = defaultRepoSlug.split("/");
    const numStr = numMatch[1];
    return { owner, repoName: name, repoSlug: `${owner}/${name}`, number: Number(numStr), ref: `${name}#${numStr}` };
  }

  failIssue(
    `Invalid issue reference "${rawRef}". Expected \`<number>\`, \`#<number>\`, \`<owner>/<repo>#<number>\`, or a GitHub Issue URL.`,
  );
}

export function parseIssueTitle(title) {
  const match = String(title ?? "")
    .trim()
    .match(/^(fix|feat|docs|refactor|perf|security|chore|test)(?:\(([^)]+)\))?:\s*(.+)$/i);
  if (!match) {
    return null;
  }
  return {
    type: match[1].toLowerCase(),
    scope: (match[2] ?? "").trim(),
    summary: match[3].trim(),
  };
}

export function formatIssueTitle(type, scope, rawTitle, validTypes = VALID_ISSUE_TYPES) {
  const cleanType = String(type ?? "").trim().toLowerCase();
  if (!validTypes.includes(cleanType)) {
    failIssue(`Invalid --type "${type}". Expected one of: ${validTypes.join(", ")}`);
  }
  const cleanScope = String(scope ?? "").trim();
  const cleanTitle = String(rawTitle ?? "").trim();
  if (!cleanTitle) {
    failIssue("Missing --title for issue creation.");
  }

  const parsed = parseIssueTitle(cleanTitle);
  if (parsed) {
    if (parsed.type !== cleanType) {
      failIssue(
        `Title prefix "${parsed.type}:" does not match --type "${cleanType}". Align them before creating the issue.`,
      );
    }
    const effectiveScope = parsed.scope || cleanScope;
    return `${cleanType}${effectiveScope ? `(${effectiveScope})` : ""}: ${parsed.summary}`;
  }

  return `${cleanType}${cleanScope ? `(${cleanScope})` : ""}: ${cleanTitle}`;
}

export function deriveBranchSpecFromIssue(issue) {
  const parsed = parseIssueTitle(issue.title);
  const labelNames = new Set((issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name).toLowerCase()));

  let prefix = parsed?.type ?? "";
  if (!prefix) {
    if (labelNames.has("bug")) prefix = "fix";
    else if (labelNames.has("documentation")) prefix = "docs";
    else if (labelNames.has("enhancement")) prefix = "feat";
    else prefix = "fix";
  }

  const rawSummary = parsed?.summary || String(issue.title ?? "");
  const asciiSlug = rawSummary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");

  const scopeSlug = (parsed?.scope ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${prefix}/issue-${issue.number}-${asciiSlug || scopeSlug || "task"}`;
}

export function deriveBranchNameFromIssue(issue, { mode = "trunk", developer = "" } = {}) {
  const spec = deriveBranchSpecFromIssue(issue);
  if (mode === "developer-branch" && developer) {
    const slash = spec.indexOf("/");
    return `${spec.slice(0, slash)}/${developer}-${spec.slice(slash + 1)}`;
  }
  return spec;
}

export function resolveAssetsConfig(issuesConfig, overrides = {}) {
  const cfg = issuesConfig ?? DEFAULT_ISSUES_CONFIG;
  const repo = String(overrides.assetsRepo || cfg.assetsRepo || "").trim() || null;
  const branch = String(overrides.assetsBranch || cfg.assetsBranch || "main").trim() || "main";
  const prefix =
    String(overrides.assetsPrefix || cfg.assetsPrefix || "assets")
      .trim()
      .replace(/^\/+|\/+$/g, "") || "assets";
  return { repo, branch, prefix };
}

function sanitizeFilename(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stem =
    path
      .basename(filePath, path.extname(filePath))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "screenshot";
  return `${stem}${ext}`;
}

export function uploadIssueAttachments(assetsConfig, repoName, attachPaths, { dryRun = false, cwd = process.cwd() } = {}) {
  if (!attachPaths || attachPaths.length === 0) {
    return [];
  }
  if (!assetsConfig?.repo) {
    failIssue(
      'Screenshot upload (--attach) requires `issues.assetsRepo` in .featflow.json (e.g. "owner/issue-assets") or passing `--assets-repo <owner/repo>`.',
    );
  }

  const stamps = formatLocalDateParts();
  const yearMonth = stamps.datePart.slice(0, 7);
  const tsCompact = stamps.featureStamp.replaceAll("-", "");
  const uploaded = [];

  for (const rawPath of attachPaths) {
    const absPath = path.resolve(rawPath);
    if (!existsSync(absPath)) failIssue(`Attachment file not found: ${absPath}`);
    const stat = statSync(absPath);
    if (!stat.isFile()) failIssue(`Attachment path is not a regular file: ${absPath}`);
    const ext = path.extname(absPath).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      failIssue(`Unsupported attachment type "${ext}" (${absPath}). Allowed: ${[...ALLOWED_IMAGE_EXTS].join(", ")}`);
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      failIssue(`Attachment exceeds 10 MB limit (${(stat.size / (1024 * 1024)).toFixed(1)} MB): ${absPath}`);
    }

    const id = randomBytes(4).toString("hex");
    const cleanName = sanitizeFilename(absPath);
    const remotePath = `${assetsConfig.prefix}/${yearMonth}/${repoName}-${tsCompact}-${id}-${cleanName}`;
    const url = `https://github.com/${assetsConfig.repo}/blob/${assetsConfig.branch}/${remotePath}?raw=true`;

    if (!dryRun) {
      const contentB64 = readFileSync(absPath).toString("base64");
      const payload = JSON.stringify({
        message: `chore(issues): upload screenshot for ${repoName} (${cleanName})`,
        content: contentB64,
        branch: assetsConfig.branch,
      });
      ghRun(["api", "-X", "PUT", `repos/${assetsConfig.repo}/contents/${remotePath}`, "--input", "-"], {
        input: payload,
        cwd,
      });
    }

    uploaded.push({ localPath: absPath, remotePath, url, alt: path.basename(absPath, ext) || "screenshot" });
  }

  return uploaded;
}

export function extractIssueAssetPaths(assetsConfig, texts) {
  if (!assetsConfig?.repo) {
    return [];
  }
  const branch = assetsConfig.branch || "main";
  const escapedRepo = assetsConfig.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedBranch = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `https://github\\.com/${escapedRepo}/(?:blob|raw)/${escapedBranch}/([^\\s)"'?#]+)(?:\\?raw=true)?`,
    "gi",
  );
  const found = [];
  const seen = new Set();

  for (const text of texts) {
    for (const match of String(text ?? "").matchAll(regex)) {
      const url = match[0];
      const remotePath = decodeURIComponent(match[1]);
      if (!seen.has(remotePath)) {
        seen.add(remotePath);
        found.push({ url, remotePath });
      }
    }
  }
  return found;
}

export function downloadIssueAssets(
  assetsConfig,
  repoName,
  issueNumber,
  assetRefs,
  { outDir = "", cwd = process.cwd() } = {},
) {
  if (!assetsConfig?.repo || !assetRefs || assetRefs.length === 0) {
    return [];
  }
  const branch = assetsConfig.branch || "main";
  const targetDir = outDir
    ? path.resolve(outDir)
    : path.join(tmpdir(), "featflow-issue-assets", `${repoName}-${issueNumber}`);
  mkdirSync(targetDir, { recursive: true });

  const downloaded = [];
  for (const item of assetRefs) {
    const rawJson = ghRun(["api", `repos/${assetsConfig.repo}/contents/${item.remotePath}?ref=${branch}`], { cwd });
    const parsed = JSON.parse(rawJson);
    const contentB64 = String(parsed.content ?? "").replace(/\s+/g, "");
    if (!contentB64) continue;
    const localPath = path.join(targetDir, path.basename(item.remotePath));
    writeFileSync(localPath, Buffer.from(contentB64, "base64"));
    downloaded.push({ url: item.url, remotePath: item.remotePath, localPath });
  }
  return downloaded;
}

export function buildWorkflowLabels(issuesConfig = DEFAULT_ISSUES_CONFIG) {
  const inProgress = issuesConfig?.inProgressLabel || DEFAULT_ISSUES_CONFIG.inProgressLabel;
  const inReview = issuesConfig?.inReviewLabel || DEFAULT_ISSUES_CONFIG.inReviewLabel;
  const blocked = issuesConfig?.blockedLabel || DEFAULT_ISSUES_CONFIG.blockedLabel;
  return STANDARD_WORKFLOW_LABELS.map((def) => {
    if (def.name === "status:in-progress") return { ...def, name: inProgress };
    if (def.name === "status:in-review") return { ...def, name: inReview };
    if (def.name === "status:blocked") return { ...def, name: blocked };
    return def;
  });
}

export function ensureWorkflowLabels(repoSlug, labelNames, { dryRun = false, cwd = process.cwd(), issuesConfig } = {}) {
  const wanted = new Set(labelNames);
  const byName = new Map(buildWorkflowLabels(issuesConfig).map((l) => [l.name, l]));
  for (const name of wanted) {
    const def = byName.get(name);
    if (!def || dryRun) continue;
    ghRunSoft(
      ["label", "create", def.name, "-R", repoSlug, "--color", def.color, "--description", def.description, "--force"],
      { cwd },
    );
  }
}

export function priorityRankOf(labels) {
  const set = new Set((labels ?? []).map((l) => l.toLowerCase()));
  if (set.has("priority:p0")) return 0;
  if (set.has("priority:p1")) return 1;
  if (set.has("priority:p2")) return 2;
  return 3;
}

export function sortIssues(items) {
  return [...items].sort((a, b) => {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    if (a.claimed !== b.claimed) return a.claimed ? 1 : -1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}
