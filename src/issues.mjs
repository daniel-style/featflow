import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_ISSUES_CONFIG, resolveIssuesConfig } from "./config.mjs";
import { gitConfigGet } from "./git.mjs";
import { createTaskWorktree, preflightTaskWorktree } from "./commands/worktree.mjs";
import {
  buildWorkflowLabels,
  deriveBranchNameFromIssue,
  deriveBranchSpecFromIssue,
  downloadIssueAssets,
  ensureWorkflowLabels,
  extractIssueAssetPaths,
  failIssue,
  formatIssueTitle,
  getCurrentGitHubUser,
  ghRun,
  parseIssueTitle,
  priorityRankOf,
  sortIssues,
  TYPE_TO_DEFAULT_LABEL,
  uploadIssueAttachments,
  VALID_ISSUE_TYPES,
  VALID_PRIORITIES,
} from "./issues-helpers.mjs";

export * from "./issues-helpers.mjs";

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
      failIssue(`Body file not found: ${absBody}`);
    }
    effectiveBody = readFileSync(absBody, "utf8");
  }
  if (!String(effectiveBody ?? "").trim()) {
    failIssue('Missing issue body. Pass `--body "..."` or `--body-file <path>`.');
  }

  if (priority && !VALID_PRIORITIES.includes(priority.toLowerCase())) {
    failIssue(`Invalid --priority "${priority}". Expected one of: ${VALID_PRIORITIES.join(", ")}`);
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
  if (defaultLabel) labels.push(defaultLabel);
  if (priority) labels.push(`priority:${priority.toLowerCase()}`);
  if (agentReady) labels.push("agent-ready");
  for (const extra of extraLabels ?? []) {
    for (const part of String(extra).split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!labels.includes(part)) labels.push(part);
    }
  }

  ensureWorkflowLabels(repoSlug, labels, { dryRun, cwd, issuesConfig });

  let createdUrl = "";
  let issueNumber = null;
  if (!dryRun) {
    const createArgs = ["issue", "create", "-R", repoSlug, "--title", formattedTitle, "--body-file", "-"];
    for (const label of labels) createArgs.push("--label", label);
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
  for (const label of labels ?? []) args.push("--label", label);
  if (mine && effectiveLogin) args.push("--assignee", effectiveLogin);

  const raw = ghRun(args, { cwd });
  const parsed = raw ? JSON.parse(raw) : [];
  const items = [];

  for (const item of parsed) {
    const labelNames = (item.labels ?? []).map((l) => l.name);
    const assigneeLogins = (item.assignees ?? []).map((a) => a.login);
    const claimed = assigneeLogins.length > 0 || labelNames.includes(inProgressLabel);
    if (unassigned && claimed) continue;
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

  return {
    repo: resolvedRepoName,
    repoSlug,
    number: issue.number,
    ref: resolvedRef,
    url: issue.url,
    state: issue.state,
    title: issue.title,
    parsedTitle: parseIssueTitle(issue.title),
    suggestedBranchSpec: deriveBranchSpecFromIssue({ number: issue.number, title: issue.title, labels }),
    suggestedBranch: deriveBranchNameFromIssue(
      { number: issue.number, title: issue.title, labels },
      { mode: branchMode, developer },
    ),
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
    failIssue(`${ref} is already CLOSED. Pass --force to override.`);
  }
  const otherAssignees = assignees.filter((login) => login !== currentUser);
  if (otherAssignees.length > 0 && !force) {
    failIssue(
      `${ref} is already assigned to ${otherAssignees.join(", ")}. Refusing to steal claim (pass --force to override).`,
    );
  }
  if (labels.includes(inProgressLabel) && !assignees.includes(currentUser) && !force) {
    failIssue(`${ref} is already labeled ${inProgressLabel}. Refusing to double-claim (pass --force to override).`);
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
  if (targetsDescription) lines.push(targetsDescription);
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
    if (existingLabels.includes(blockedLabel)) editArgs.push("--remove-label", blockedLabel);
    ghRun(editArgs, { cwd });
    ghRun(["issue", "comment", String(number), "-R", repoSlug, "--body-file", "-"], { input: claimComment, cwd });
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
  checkIssueClaimable(issue, me, { force, inProgressLabel: issuesConfig.inProgressLabel, ref: resolvedRef });

  const developer =
    config.mode === "developer-branch" ? gitConfigGet(config.developerBranchConfigKey, repoRoot) : "";
  const branchSpec = deriveBranchSpecFromIssue({ number: issue.number, title: issue.title, labels: issue.labelNames });
  const branchName =
    branch ||
    deriveBranchNameFromIssue(
      { number: issue.number, title: issue.title, labels: issue.labelNames },
      { mode: config.mode, developer },
    );

  const shouldCreateWorktree = !noWorktree && issuesConfig.autoWorktree;
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

  const worktree = shouldCreateWorktree
    ? createTaskWorktree(
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
      )
    : null;

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
  if (!String(summary ?? "").trim()) failIssue('Missing `--summary "..."` for issue review.');

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

  if (!dryRun) {
    const editArgs = ["issue", "edit", String(number), "-R", repoSlug, "--add-label", inReviewLabel];
    if (existingLabels.has(inProgressLabel)) editArgs.push("--remove-label", inProgressLabel);
    if (existingLabels.has(blockedLabel)) editArgs.push("--remove-label", blockedLabel);
    ghRun(editArgs, { cwd });
    ghRun(["issue", "comment", String(number), "-R", repoSlug, "--body-file", "-"], {
      input: `${lines.join("\n")}\n`,
      cwd,
    });
  }

  return { ref: resolvedRef, url: issue.url, status: inReviewLabel, commit: commit || null, pr: pr || null, dryRun };
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

  if (blocked) ensureWorkflowLabels(repoSlug, [blockedLabel], { dryRun, cwd, issuesConfig });

  const commentBody = [
    blocked ? `Marked blocked and released by @${me}.` : `Released claim by @${me}.`,
    reason ? `\nReason: ${reason}` : "",
  ].join("");

  if (!dryRun) {
    const editArgs = ["issue", "edit", String(number), "-R", repoSlug];
    if ((issue.assignees ?? []).some((a) => a.login === me)) editArgs.push("--remove-assignee", me);
    if (existingLabels.has(inProgressLabel)) editArgs.push("--remove-label", inProgressLabel);
    if (blocked) editArgs.push("--add-label", blockedLabel);
    if (editArgs.length > 5) ghRun(editArgs, { cwd });
    ghRun(["issue", "comment", String(number), "-R", repoSlug, "--body-file", "-"], { input: commentBody, cwd });
  }

  return { ref: resolvedRef, url: issue.url, releasedBy: me, blocked: Boolean(blocked), reason: reason || null, dryRun };
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
        ["label", "create", label.name, "-R", repoSlug, "--color", label.color, "--description", label.description, "--force"],
        { cwd },
      );
    }
  }
  return { repo: resolvedRepoName, repoSlug, labels: defs.map((l) => l.name) };
}
