import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_ISSUES_CONFIG, DEFAULT_PREFIXES, resolveIssuesConfig } from "./config.mjs";
import { commandExists, gitConfigGet, runReadSoft } from "./git.mjs";
import { createTaskWorktree, preflightTaskWorktree } from "./commands/worktree.mjs";

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

function fail(message) {
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

export function ghRun(args, { input, cwd = process.cwd() } = {}) {
  if (!commandExists("gh")) {
    fail("GitHub CLI (`gh`) is required for `featflow issue`. Install `gh` and run `gh auth login`.");
  }
  const res = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (res.error) {
    fail(`gh ${args.join(" ")} failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || `exit code ${String(res.status)}`).trim();
    fail(`gh ${args.join(" ")} failed:\n${detail}`);
  }
  return (res.stdout ?? "").trim();
}

export function ghRunSoft(args, { input, cwd = process.cwd() } = {}) {
  const res = spawnSync("gh", args, {
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
      fail(`Invalid --repo "${cleanExplicit}". Expected "<owner>/<repo>".`);
    }
    const [owner, name] = cleanExplicit.split("/");
    return { owner, name, slug: `${owner}/${name}` };
  }

  const issuesConfig = resolveIssuesConfig(config);
  if (issuesConfig.repo && issuesConfig.repo.includes("/")) {
    const [owner, name] = issuesConfig.repo.split("/");
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

  if (commandExists("gh")) {
    const ghRes = ghRunSoft(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: repoRoot });
    if (ghRes.status === 0 && ghRes.stdout.includes("/")) {
      const [owner, name] = ghRes.stdout.split("/");
      return { owner, name, slug: `${owner}/${name}` };
    }
  }

  fail(
    `Could not determine GitHub repository from remote "${remoteName}". Set \`issues.repo\` in .featflow.json or pass \`--repo <owner>/<repo>\`.`,
  );
}

export function parseIssueRef(rawRef, defaultRepoSlug = "") {
  const trimmed = String(rawRef ?? "").trim();
  if (!trimmed) {
    fail("Missing issue reference (expected `<number>`, `#<number>`, `<owner>/<repo>#<number>`, or a GitHub Issue URL).");
  }

  const urlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/i);
  if (urlMatch) {
    const [, owner, name, numStr] = urlMatch;
    return {
      owner,
      repoName: name,
      repoSlug: `${owner}/${name}`,
      number: Number(numStr),
      ref: `${name}#${numStr}`,
    };
  }

  const slugHashMatch = trimmed.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (slugHashMatch) {
    const [, owner, name, numStr] = slugHashMatch;
    return {
      owner,
      repoName: name,
      repoSlug: `${owner}/${name}`,
      number: Number(numStr),
      ref: `${name}#${numStr}`,
    };
  }

  const numMatch = trimmed.match(/^#?(\d+)$/);
  if (numMatch && defaultRepoSlug && defaultRepoSlug.includes("/")) {
    const [owner, name] = defaultRepoSlug.split("/");
    const numStr = numMatch[1];
    return {
      owner,
      repoName: name,
      repoSlug: `${owner}/${name}`,
      number: Number(numStr),
      ref: `${name}#${numStr}`,
    };
  }

  fail(
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
    fail(`Invalid --type "${type}". Expected one of: ${validTypes.join(", ")}`);
  }
  const cleanScope = String(scope ?? "").trim();
  const cleanTitle = String(rawTitle ?? "").trim();
  if (!cleanTitle) {
    fail("Missing --title for issue creation.");
  }

  const parsed = parseIssueTitle(cleanTitle);
  if (parsed) {
    if (parsed.type !== cleanType) {
      fail(`Title prefix "${parsed.type}:" does not match --type "${cleanType}". Align them before creating the issue.`);
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
    if (labelNames.has("bug")) {
      prefix = "fix";
    } else if (labelNames.has("documentation")) {
      prefix = "docs";
    } else if (labelNames.has("enhancement")) {
      prefix = "feat";
    } else {
      prefix = "fix";
    }
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

  const suffix = asciiSlug || scopeSlug || "task";
  return `${prefix}/issue-${issue.number}-${suffix}`;
}

export function deriveBranchNameFromIssue(issue, { mode = "trunk", developer = "" } = {}) {
  const spec = deriveBranchSpecFromIssue(issue);
  if (mode === "developer-branch" && developer) {
    const slash = spec.indexOf("/");
    const prefix = spec.slice(0, slash);
    const rest = spec.slice(slash + 1);
    return `${prefix}/${developer}-${rest}`;
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
    fail(
      "Screenshot upload (--attach) requires `issues.assetsRepo` in .featflow.json (e.g. \"owner/issue-assets\") or passing `--assets-repo <owner/repo>`.",
    );
  }

  const stamps = formatLocalDateParts();
  const yearMonth = stamps.datePart.slice(0, 7);
  const tsCompact = stamps.featureStamp.replaceAll("-", "");
  const uploaded = [];

  for (const rawPath of attachPaths) {
    const absPath = path.resolve(rawPath);
    if (!existsSync(absPath)) {
      fail(`Attachment file not found: ${absPath}`);
    }
    const stat = statSync(absPath);
    if (!stat.isFile()) {
      fail(`Attachment path is not a regular file: ${absPath}`);
    }
    const ext = path.extname(absPath).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      fail(`Unsupported attachment type "${ext}" (${absPath}). Allowed: ${[...ALLOWED_IMAGE_EXTS].join(", ")}`);
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      fail(`Attachment exceeds 10 MB limit (${(stat.size / (1024 * 1024)).toFixed(1)} MB): ${absPath}`);
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

    uploaded.push({
      localPath: absPath,
      remotePath,
      url,
      alt: path.basename(absPath, ext) || "screenshot",
    });
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
    if (!contentB64) {
      continue;
    }
    const filename = path.basename(item.remotePath);
    const localPath = path.join(targetDir, filename);
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
  const defs = buildWorkflowLabels(issuesConfig);
  const byName = new Map(defs.map((l) => [l.name, l]));
  for (const name of wanted) {
    const def = byName.get(name);
    if (!def || dryRun) {
      continue;
    }
    ghRunSoft(
      [
        "label",
        "create",
        def.name,
        "-R",
        repoSlug,
        "--color",
        def.color,
        "--description",
        def.description,
        "--force",
      ],
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

export function createIssue({
  repoSlug,
  repoName,
  type,
  scope = "",
  title,
  body = "",
  bodyFile = "",
  priority = "",
  agentReady = false,
  labels: extraLabels = [],
  attaches = [],
  imageUrls = [],
  assetsConfig = null,
  issuesConfig = DEFAULT_ISSUES_CONFIG,
  validTypes = VALID_ISSUE_TYPES,
  dryRun = false,
  cwd = process.cwd(),
}) {
  const resolvedRepoName = repoName || repoSlug.split("/")[1] || repoSlug;
  const formattedTitle = formatIssueTitle(type, scope, title, validTypes);

  let effectiveBody = body;
  if (bodyFile) {
    const absBody = path.resolve(bodyFile);
    if (!existsSync(absBody)) {
      fail(`Body file not found: ${absBody}`);
    }
    effectiveBody = readFileSync(absBody, "utf8");
  }
  if (!String(effectiveBody ?? "").trim()) {
    fail("Missing issue body. Pass `--body \"...\"` or `--body-file <path>`.");
  }

  if (priority && !VALID_PRIORITIES.includes(priority.toLowerCase())) {
    fail(`Invalid --priority "${priority}". Expected one of: ${VALID_PRIORITIES.join(", ")}`);
  }

  const uploaded = uploadIssueAttachments(assetsConfig, resolvedRepoName, attaches, { dryRun, cwd });
  const imageLines = [
    ...uploaded.map((img) => `![${img.alt}](${img.url})`),
    ...(imageUrls ?? []).map((url, idx) => `![screenshot-${idx + 1}](${url})`),
  ];

  let finalBody = effectiveBody.trimEnd();
  if (imageLines.length > 0) {
    finalBody = `${finalBody}\n\n## Screenshots\n\n${imageLines.join("\n\n")}\n`;
  }

  const labels = [];
  const defaultLabel = TYPE_TO_DEFAULT_LABEL[String(type).toLowerCase()];
  if (defaultLabel) {
    labels.push(defaultLabel);
  }
  if (priority) {
    labels.push(`priority:${priority.toLowerCase()}`);
  }
  if (agentReady) {
    labels.push("agent-ready");
  }
  for (const extra of extraLabels ?? []) {
    for (const part of String(extra)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!labels.includes(part)) {
        labels.push(part);
      }
    }
  }

  ensureWorkflowLabels(repoSlug, labels, { dryRun, cwd, issuesConfig });

  let createdUrl = "";
  let issueNumber = null;
  if (!dryRun) {
    const createArgs = ["issue", "create", "-R", repoSlug, "--title", formattedTitle, "--body-file", "-"];
    for (const label of labels) {
      createArgs.push("--label", label);
    }
    createdUrl = ghRun(createArgs, { input: finalBody, cwd });
    const numMatch = createdUrl.match(/\/issues\/(\d+)$/);
    issueNumber = numMatch ? Number(numMatch[1]) : null;
  }

  return {
    repo: resolvedRepoName,
    repoSlug,
    number: issueNumber,
    ref: issueNumber ? `${resolvedRepoName}#${issueNumber}` : null,
    url: createdUrl || null,
    title: formattedTitle,
    labels,
    uploadedAttachments: uploaded,
    dryRun,
  };
}

export function listIssues({
  repoSlug,
  repoName,
  state = "open",
  limit = 30,
  labels = [],
  mine = false,
  unassigned = false,
  currentLogin = "",
  issuesConfig = DEFAULT_ISSUES_CONFIG,
  cwd = process.cwd(),
}) {
  const resolvedRepoName = repoName || repoSlug.split("/")[1] || repoSlug;
  const inProgressLabel = issuesConfig?.inProgressLabel || DEFAULT_ISSUES_CONFIG.inProgressLabel;
  const effectiveLogin = mine ? currentLogin || getCurrentGitHubUser(cwd) : "";

  const args = [
    "issue",
    "list",
    "-R",
    repoSlug,
    "--state",
    state || "open",
    "--limit",
    String(limit || 30),
    "--json",
    "number,title,state,url,labels,assignees,createdAt,updatedAt,comments",
  ];
  for (const label of labels ?? []) {
    args.push("--label", label);
  }
  if (mine && effectiveLogin) {
    args.push("--assignee", effectiveLogin);
  }

  const raw = ghRun(args, { cwd });
  const parsed = raw ? JSON.parse(raw) : [];
  const items = [];

  for (const item of parsed) {
    const labelNames = (item.labels ?? []).map((l) => l.name);
    const assigneeLogins = (item.assignees ?? []).map((a) => a.login);
    const claimed = assigneeLogins.length > 0 || labelNames.includes(inProgressLabel);
    if (unassigned && claimed) {
      continue;
    }
    const parsedTitle = parseIssueTitle(item.title);
    items.push({
      repo: resolvedRepoName,
      repoSlug,
      number: item.number,
      ref: `${resolvedRepoName}#${item.number}`,
      title: item.title,
      parsedType: parsedTitle?.type ?? null,
      parsedScope: parsedTitle?.scope || null,
      state: item.state,
      url: item.url,
      labels: labelNames,
      assignees: assigneeLogins,
      claimed,
      priorityRank: priorityRankOf(labelNames),
      commentCount: Array.isArray(item.comments) ? item.comments.length : 0,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }

  return sortIssues(items);
}

export function viewIssue({
  repoSlug,
  repoName,
  number,
  ref,
  assetsConfig = null,
  downloadImages = false,
  outDir = "",
  issuesConfig = DEFAULT_ISSUES_CONFIG,
  branchMode = "trunk",
  developer = "",
  cwd = process.cwd(),
}) {
  const resolvedRepoName = repoName || repoSlug.split("/")[1] || repoSlug;
  const resolvedRef = ref || `${resolvedRepoName}#${number}`;
  const inProgressLabel = issuesConfig?.inProgressLabel || DEFAULT_ISSUES_CONFIG.inProgressLabel;

  const raw = ghRun(
    [
      "issue",
      "view",
      String(number),
      "-R",
      repoSlug,
      "--json",
      "number,title,body,state,url,author,labels,assignees,comments,createdAt,updatedAt",
    ],
    { cwd },
  );
  const issue = JSON.parse(raw);
  const labels = (issue.labels ?? []).map((l) => l.name);
  const assignees = (issue.assignees ?? []).map((a) => a.login);
  const comments = (issue.comments ?? []).map((c) => ({
    author: c.author?.login ?? "unknown",
    createdAt: c.createdAt,
    body: c.body,
  }));

  const assetRefs = extractIssueAssetPaths(assetsConfig, [issue.body, ...comments.map((c) => c.body)]);
  const downloadedImages = downloadImages
    ? downloadIssueAssets(assetsConfig, resolvedRepoName, issue.number, assetRefs, { outDir, cwd })
    : [];

  const suggestedBranchSpec = deriveBranchSpecFromIssue({ number: issue.number, title: issue.title, labels });
  const suggestedBranch = deriveBranchNameFromIssue(
    { number: issue.number, title: issue.title, labels },
    { mode: branchMode, developer },
  );

  return {
    repo: resolvedRepoName,
    repoSlug,
    number: issue.number,
    ref: resolvedRef,
    url: issue.url,
    state: issue.state,
    title: issue.title,
    parsedTitle: parseIssueTitle(issue.title),
    suggestedBranchSpec,
    suggestedBranch,
    author: issue.author?.login ?? "unknown",
    labels,
    assignees,
    claimed: assignees.length > 0 || labels.includes(inProgressLabel),
    body: issue.body ?? "",
    comments,
    issueAssets: assetRefs,
    downloadedImages,
  };
}

export function fetchIssueForClaim(repoSlug, number, { cwd = process.cwd() } = {}) {
  const raw = ghRun(
    ["issue", "view", String(number), "-R", repoSlug, "--json", "number,title,state,url,labels,assignees"],
    { cwd },
  );
  const issue = JSON.parse(raw);
  return {
    ...issue,
    labelNames: (issue.labels ?? []).map((l) => l.name),
    assigneeLogins: (issue.assignees ?? []).map((a) => a.login),
  };
}

export function checkIssueClaimable(
  issue,
  currentUser,
  { force = false, inProgressLabel = DEFAULT_ISSUES_CONFIG.inProgressLabel, ref = `#${issue.number}` } = {},
) {
  const labels = issue.labelNames ?? (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  const assignees = issue.assigneeLogins ?? (issue.assignees ?? []).map((a) => (typeof a === "string" ? a : a.login));

  if (issue.state === "CLOSED" && !force) {
    fail(`${ref} is already CLOSED. Pass --force to override.`);
  }

  const otherAssignees = assignees.filter((login) => login !== currentUser);
  if (otherAssignees.length > 0 && !force) {
    fail(`${ref} is already assigned to ${otherAssignees.join(", ")}. Refusing to steal claim (pass --force to override).`);
  }
  if (labels.includes(inProgressLabel) && !assignees.includes(currentUser) && !force) {
    fail(`${ref} is already labeled ${inProgressLabel}. Refusing to double-claim (pass --force to override).`);
  }
}

export function mutateIssueClaim({
  repoSlug,
  number,
  currentUser,
  existingLabels = [],
  branchLabel,
  targetsDescription = "",
  issuesConfig = DEFAULT_ISSUES_CONFIG,
  dryRun = false,
  cwd = process.cwd(),
}) {
  const inProgressLabel = issuesConfig?.inProgressLabel || DEFAULT_ISSUES_CONFIG.inProgressLabel;
  const blockedLabel = issuesConfig?.blockedLabel || DEFAULT_ISSUES_CONFIG.blockedLabel;

  ensureWorkflowLabels(repoSlug, [inProgressLabel], { dryRun, cwd, issuesConfig });

  const lines = [`Claimed by @${currentUser}.`, `- Branch: \`${branchLabel}\``];
  if (targetsDescription) {
    lines.push(targetsDescription);
  }
  const claimComment = lines.join("\n");

  if (!dryRun) {
    const editArgs = [
      "issue",
      "edit",
      String(number),
      "-R",
      repoSlug,
      "--add-assignee",
      currentUser,
      "--add-label",
      inProgressLabel,
    ];
    if (existingLabels.includes(blockedLabel)) {
      editArgs.push("--remove-label", blockedLabel);
    }
    ghRun(editArgs, { cwd });
    ghRun(["issue", "comment", String(number), "-R", repoSlug, "--body-file", "-"], {
      input: claimComment,
      cwd,
    });
  }

  return { claimComment, inProgressLabel };
}

export function claimIssue({
  repoRoot,
  config,
  repoSlug,
  repoName,
  number,
  ref,
  branch = "",
  worktreePath = "",
  base = "",
  noWorktree = false,
  skipPostCreate = false,
  force = false,
  dryRun = false,
  captureOutput = false,
}) {
  const resolvedRepoName = repoName || repoSlug.split("/")[1] || repoSlug;
  const resolvedRef = ref || `${resolvedRepoName}#${number}`;
  const issuesConfig = resolveIssuesConfig(config);

  const issue = fetchIssueForClaim(repoSlug, number, { cwd: repoRoot });
  const me = getCurrentGitHubUser(repoRoot);
  checkIssueClaimable(issue, me, {
    force,
    inProgressLabel: issuesConfig.inProgressLabel,
    ref: resolvedRef,
  });

  const developer =
    config.mode === "developer-branch" ? gitConfigGet(config.developerBranchConfigKey, repoRoot) : "";
  const branchSpec = deriveBranchSpecFromIssue({
    number: issue.number,
    title: issue.title,
    labels: issue.labelNames,
  });
  const branchName =
    branch ||
    deriveBranchNameFromIssue(
      { number: issue.number, title: issue.title, labels: issue.labelNames },
      { mode: config.mode, developer },
    );

  const shouldCreateWorktree = !noWorktree && issuesConfig.autoWorktree;

  // Preflight local worktree creation BEFORE mutating GitHub state so failed local setup never leaves a half-claimed issue
  let preflighted = null;
  if (shouldCreateWorktree) {
    preflighted = preflightTaskWorktree(repoRoot, config, {
      branch: branchName,
      path: worktreePath,
      base,
      baseProvided: Boolean(base),
    });
  }

  mutateIssueClaim({
    repoSlug,
    number: issue.number,
    currentUser: me,
    existingLabels: issue.labelNames,
    branchLabel: branchName,
    targetsDescription: shouldCreateWorktree
      ? `- Repository: \`${resolvedRepoName}\``
      : "- Mode: issue claim only (`--no-worktree`)",
    issuesConfig,
    dryRun,
    cwd: repoRoot,
  });

  let worktree = null;
  if (shouldCreateWorktree) {
    worktree = createTaskWorktree(
      repoRoot,
      config,
      {
        branch: branchName,
        path: worktreePath,
        base,
        baseProvided: Boolean(base),
        skipPostCreate,
        dryRun,
        captureOutput,
      },
      preflighted,
    );
  }

  return {
    ref: resolvedRef,
    repo: resolvedRepoName,
    repoSlug,
    number: issue.number,
    url: issue.url,
    claimedBy: me,
    branchSpec,
    branch: branchName,
    dryRun,
    worktree,
  };
}

export function reviewIssue({
  repoSlug,
  repoName,
  number,
  ref,
  summary,
  commit = "",
  pr = "",
  checks = "",
  risks = "",
  integrationBranch = "main",
  issuesConfig = DEFAULT_ISSUES_CONFIG,
  dryRun = false,
  cwd = process.cwd(),
}) {
  const resolvedRepoName = repoName || repoSlug.split("/")[1] || repoSlug;
  const resolvedRef = ref || `${resolvedRepoName}#${number}`;
  if (!String(summary ?? "").trim()) {
    fail("Missing `--summary \"...\"` for issue review.");
  }

  const inProgressLabel = issuesConfig?.inProgressLabel || DEFAULT_ISSUES_CONFIG.inProgressLabel;
  const inReviewLabel = issuesConfig?.inReviewLabel || DEFAULT_ISSUES_CONFIG.inReviewLabel;
  const blockedLabel = issuesConfig?.blockedLabel || DEFAULT_ISSUES_CONFIG.blockedLabel;

  const raw = ghRun(["issue", "view", String(number), "-R", repoSlug, "--json", "labels,url"], { cwd });
  const issue = JSON.parse(raw);
  const existingLabels = new Set((issue.labels ?? []).map((l) => l.name));

  ensureWorkflowLabels(repoSlug, [inReviewLabel], { dryRun, cwd, issuesConfig });

  const lines = ["### Ready for Review", "", String(summary).trim(), ""];
  if (commit) lines.push(`- **Commit**: \`${commit}\``);
  if (pr) lines.push(`- **PR**: ${pr}`);
  if (checks) lines.push(`- **Verification**: ${checks}`);
  if (risks) lines.push(`- **Residual risk / notes**: ${risks}`);
  lines.push(
    `- **Next**: Will be closed once integrated into \`${integrationBranch}\` (with \`Closes #${number}\`) or after manual verification.`,
  );

  const commentBody = `${lines.join("\n")}\n`;

  if (!dryRun) {
    const editArgs = ["issue", "edit", String(number), "-R", repoSlug, "--add-label", inReviewLabel];
    if (existingLabels.has(inProgressLabel)) {
      editArgs.push("--remove-label", inProgressLabel);
    }
    if (existingLabels.has(blockedLabel)) {
      editArgs.push("--remove-label", blockedLabel);
    }
    ghRun(editArgs, { cwd });
    ghRun(["issue", "comment", String(number), "-R", repoSlug, "--body-file", "-"], {
      input: commentBody,
      cwd,
    });
  }

  return {
    ref: resolvedRef,
    url: issue.url,
    status: inReviewLabel,
    commit: commit || null,
    pr: pr || null,
    dryRun,
  };
}

export function releaseIssue({
  repoSlug,
  repoName,
  number,
  ref,
  blocked = false,
  reason = "",
  issuesConfig = DEFAULT_ISSUES_CONFIG,
  dryRun = false,
  cwd = process.cwd(),
}) {
  const resolvedRepoName = repoName || repoSlug.split("/")[1] || repoSlug;
  const resolvedRef = ref || `${resolvedRepoName}#${number}`;
  const inProgressLabel = issuesConfig?.inProgressLabel || DEFAULT_ISSUES_CONFIG.inProgressLabel;
  const blockedLabel = issuesConfig?.blockedLabel || DEFAULT_ISSUES_CONFIG.blockedLabel;

  const raw = ghRun(["issue", "view", String(number), "-R", repoSlug, "--json", "labels,assignees,url"], { cwd });
  const issue = JSON.parse(raw);
  const existingLabels = new Set((issue.labels ?? []).map((l) => l.name));
  const me = getCurrentGitHubUser(cwd);

  if (blocked) {
    ensureWorkflowLabels(repoSlug, [blockedLabel], { dryRun, cwd, issuesConfig });
  }

  const commentBody = [
    blocked ? `Marked blocked and released by @${me}.` : `Released claim by @${me}.`,
    reason ? `\nReason: ${reason}` : "",
  ].join("");

  if (!dryRun) {
    const editArgs = ["issue", "edit", String(number), "-R", repoSlug];
    if ((issue.assignees ?? []).some((a) => a.login === me)) {
      editArgs.push("--remove-assignee", me);
    }
    if (existingLabels.has(inProgressLabel)) {
      editArgs.push("--remove-label", inProgressLabel);
    }
    if (blocked) {
      editArgs.push("--add-label", blockedLabel);
    }
    if (editArgs.length > 5) {
      ghRun(editArgs, { cwd });
    }
    ghRun(["issue", "comment", String(number), "-R", repoSlug, "--body-file", "-"], {
      input: commentBody,
      cwd,
    });
  }

  return {
    ref: resolvedRef,
    url: issue.url,
    releasedBy: me,
    blocked: Boolean(blocked),
    reason: reason || null,
    dryRun,
  };
}

export function syncIssueLabels({
  repoSlug,
  repoName,
  issuesConfig = DEFAULT_ISSUES_CONFIG,
  dryRun = false,
  cwd = process.cwd(),
}) {
  const resolvedRepoName = repoName || repoSlug.split("/")[1] || repoSlug;
  const defs = buildWorkflowLabels(issuesConfig);
  if (!dryRun) {
    for (const label of defs) {
      ghRun(
        [
          "label",
          "create",
          label.name,
          "-R",
          repoSlug,
          "--color",
          label.color,
          "--description",
          label.description,
          "--force",
        ],
        { cwd },
      );
    }
  }
  return {
    repo: resolvedRepoName,
    repoSlug,
    labels: defs.map((l) => l.name),
  };
}
