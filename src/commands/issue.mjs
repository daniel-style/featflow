import { loadConfig, resolveIssuesConfig } from "../config.mjs";
import { fail, gitConfigGet } from "../git.mjs";
import {
  claimIssue,
  createIssue,
  listIssues,
  parseIssueRef,
  releaseIssue,
  resolveAssetsConfig,
  resolveGitHubRepoSlug,
  reviewIssue,
  syncIssueLabels,
  viewIssue,
} from "../issues.mjs";

const usage = `
Usage:
  featflow issue <subcommand> [options]

Optional GitHub Issues closed-loop CLI (file -> list -> view -> claim + worktree -> review -> release).
Requires GitHub CLI ("gh") only when invoking this command.

Subcommands:
  create                 Create a prefixed GitHub Issue (supports --attach when issues.assetsRepo is set)
  list                   List GitHub Issues for the repository (sorted by priority, unclaimed first)
  view <ref>             Inspect Issue details/comments and optionally download attached images (--download-images)
  claim <ref>            Atomically preflight worktree, check collision lock, claim Issue, and create worktree
  review <ref>           Move a verified fix to status:in-review and post a structured verification comment
  release <ref>          Release a claimed Issue back to the pool (optionally add status:blocked)
  labels:sync            Idempotently create/update the 7 standard workflow labels on the repository

Common Options:
  --repo <owner/repo>    Override GitHub repository slug (defaults to issues.repo or git remote)
  --dry-run              Preview actions without mutating GitHub or creating worktrees
  --json                 Output machine-readable JSON
  -h, --help             Show this help

Examples:
  featflow issue create --type fix --scope auth --title "blank screen after callback" --body "..." --priority p1 --agent-ready
  featflow issue list --unassigned --json
  featflow issue view 12 --download-images --json
  featflow issue claim 12 --json
  featflow issue review 12 --commit a1b2c3d --summary "Fixed OAuth redirect state" --checks "npm test"
  featflow issue release 12 --blocked --reason "Waiting on backend contract"
  featflow issue labels:sync
`.trim();

function parseArgs(argv) {
  const options = {
    subcommand: "",
    positionals: [],
    repo: "",
    type: "",
    scope: "",
    title: "",
    body: "",
    bodyFile: "",
    priority: "",
    labels: [],
    attaches: [],
    imageUrls: [],
    assetsRepo: "",
    assetsBranch: "",
    assetsPrefix: "",
    agentReady: false,
    unassigned: false,
    mine: false,
    state: "open",
    limit: 30,
    downloadImages: false,
    outDir: "",
    branch: "",
    worktreePath: "",
    base: "",
    noWorktree: false,
    skipPostCreate: false,
    force: false,
    summary: "",
    commit: "",
    pr: "",
    checks: "",
    risks: "",
    reason: "",
    blocked: false,
    dryRun: false,
    json: false,
  };

  const boolFlags = {
    "--agent-ready": "agentReady",
    "--unassigned": "unassigned",
    "--mine": "mine",
    "--download-images": "downloadImages",
    "--no-worktree": "noWorktree",
    "--skip-post-create": "skipPostCreate",
    "--force": "force",
    "--blocked": "blocked",
    "--dry-run": "dryRun",
    "--json": "json",
  };

  const multiFlags = {
    "--label": "labels",
    "--attach": "attaches",
    "--image-url": "imageUrls",
  };

  const singleFlags = {
    "--repo": "repo",
    "--type": "type",
    "--scope": "scope",
    "--title": "title",
    "--body": "body",
    "--body-file": "bodyFile",
    "--priority": "priority",
    "--assets-repo": "assetsRepo",
    "--assets-branch": "assetsBranch",
    "--assets-prefix": "assetsPrefix",
    "--state": "state",
    "--limit": "limit",
    "--out-dir": "outDir",
    "--branch": "branch",
    "--path": "worktreePath",
    "--base": "base",
    "--summary": "summary",
    "--commit": "commit",
    "--pr": "pr",
    "--checks": "checks",
    "--risks": "risks",
    "--reason": "reason",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (boolFlags[arg]) {
      options[boolFlags[arg]] = true;
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const flagName = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const hasInline = eqIdx !== -1;

    if (multiFlags[flagName]) {
      const value = hasInline ? arg.slice(eqIdx + 1) : (argv[++i] ?? "");
      if (!value) {
        fail(`Missing value for ${flagName}.`, usage);
      }
      options[multiFlags[flagName]].push(value);
      continue;
    }
    if (singleFlags[flagName]) {
      const value = hasInline ? arg.slice(eqIdx + 1) : (argv[++i] ?? "");
      if (value === "" && flagName !== "--body") {
        fail(`Missing value for ${flagName}.`, usage);
      }
      options[singleFlags[flagName]] = flagName === "--limit" ? Number(value) : value;
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`Unknown option for issue: ${arg}`, usage);
    }
    if (!options.subcommand) {
      options.subcommand = arg;
    } else {
      options.positionals.push(arg);
    }
  }

  return options;
}

export async function runIssue(argv) {
  const options = parseArgs(argv);
  if (!options.subcommand) {
    console.log(usage);
    return;
  }

  const { config, repoRoot } = loadConfig(process.cwd());
  const issuesConfig = resolveIssuesConfig(config);
  const assetsConfig = resolveAssetsConfig(issuesConfig, {
    assetsRepo: options.assetsRepo,
    assetsBranch: options.assetsBranch,
    assetsPrefix: options.assetsPrefix,
  });

  const sub = options.subcommand === "labels-sync" ? "labels:sync" : options.subcommand;

  try {
    if (sub === "create") {
      const repoInfo = resolveGitHubRepoSlug(repoRoot, config, options.repo);
      const result = createIssue({
        repoSlug: repoInfo.slug,
        repoName: repoInfo.name,
        type: options.type,
        scope: options.scope,
        title: options.title,
        body: options.body,
        bodyFile: options.bodyFile,
        priority: options.priority,
        agentReady: options.agentReady,
        labels: options.labels,
        attaches: options.attaches,
        imageUrls: options.imageUrls,
        assetsConfig,
        issuesConfig,
        validTypes: config.prefixes,
        dryRun: options.dryRun,
        cwd: repoRoot,
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (options.dryRun) {
        console.log(`[dry-run] Would create issue in ${result.repoSlug}:`);
        console.log(`  Title:  ${result.title}`);
        console.log(`  Labels: ${result.labels.join(", ") || "(none)"}`);
        if (result.uploadedAttachments.length > 0) {
          console.log(`  Images: ${result.uploadedAttachments.map((u) => u.url).join(", ")}`);
        }
        return;
      }
      console.log(`Created ${result.ref ?? result.repoSlug}: ${result.url}`);
      if (result.uploadedAttachments.length > 0 && assetsConfig.repo) {
        console.log(`Uploaded ${result.uploadedAttachments.length} screenshot(s) to ${assetsConfig.repo}`);
      }
      return;
    }

    if (sub === "list") {
      const repoInfo = resolveGitHubRepoSlug(repoRoot, config, options.repo);
      const issues = listIssues({
        repoSlug: repoInfo.slug,
        repoName: repoInfo.name,
        state: options.state,
        limit: options.limit,
        labels: options.labels,
        mine: options.mine,
        unassigned: options.unassigned,
        issuesConfig,
        cwd: repoRoot,
      });

      if (options.json) {
        console.log(JSON.stringify({ count: issues.length, repo: repoInfo.name, repoSlug: repoInfo.slug, issues }, null, 2));
        return;
      }
      if (issues.length === 0) {
        console.log("No matching GitHub Issues found.");
        return;
      }
      console.log(`GitHub Issues (${issues.length}):`);
      for (const item of issues) {
        const claimTag = item.claimed ? `[claimed:${item.assignees.join(",") || "in-progress"}]` : "[open]";
        const labelsTag = item.labels.length > 0 ? ` (${item.labels.join(", ")})` : "";
        console.log(`  - ${item.ref.padEnd(22)} ${claimTag} ${item.title}${labelsTag}`);
      }
      return;
    }

    if (sub === "view") {
      const rawRef = options.positionals[0];
      const defaultSlug =
        rawRef && (/^https?:\/\//i.test(rawRef) || rawRef.includes("/"))
          ? ""
          : resolveGitHubRepoSlug(repoRoot, config, options.repo).slug;
      const target = parseIssueRef(rawRef, defaultSlug);
      const developer =
        config.mode === "developer-branch" ? gitConfigGet(config.developerBranchConfigKey, repoRoot) : "";

      const payload = viewIssue({
        repoSlug: target.repoSlug,
        repoName: target.repoName,
        number: target.number,
        ref: target.ref,
        assetsConfig,
        downloadImages: options.downloadImages,
        outDir: options.outDir,
        issuesConfig,
        branchMode: config.mode,
        developer,
        cwd: repoRoot,
      });

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`${payload.ref}: ${payload.title}`);
      console.log(`URL: ${payload.url}`);
      console.log(
        `State: ${payload.state} | Labels: ${payload.labels.join(", ") || "(none)"} | Assignees: ${payload.assignees.join(", ") || "(unassigned)"}`,
      );
      console.log(`Suggested branch: ${payload.suggestedBranch}`);
      console.log("");
      console.log(payload.body);
      if (payload.downloadedImages.length > 0) {
        console.log("");
        console.log("Downloaded original screenshots:");
        for (const img of payload.downloadedImages) {
          console.log(`  - ${img.localPath}`);
        }
      }
      return;
    }

    if (sub === "claim") {
      const rawRef = options.positionals[0];
      const defaultSlug =
        rawRef && (/^https?:\/\//i.test(rawRef) || rawRef.includes("/"))
          ? ""
          : resolveGitHubRepoSlug(repoRoot, config, options.repo).slug;
      const target = parseIssueRef(rawRef, defaultSlug);

      const payload = claimIssue({
        repoRoot,
        config,
        repoSlug: target.repoSlug,
        repoName: target.repoName,
        number: target.number,
        ref: target.ref,
        branch: options.branch,
        worktreePath: options.worktreePath,
        base: options.base,
        noWorktree: options.noWorktree,
        skipPostCreate: options.skipPostCreate,
        force: options.force,
        dryRun: options.dryRun,
        captureOutput: options.json,
      });

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(
        `${options.dryRun ? "[dry-run] Would claim" : "Claimed"} ${payload.ref} as @${payload.claimedBy} (${issuesConfig.inProgressLabel}).`,
      );
      if (payload.worktree) {
        console.log(`  - [${payload.worktree.branch}] -> ${payload.worktree.worktreePath}`);
      }
      return;
    }

    if (sub === "review") {
      const rawRef = options.positionals[0];
      const defaultSlug =
        rawRef && (/^https?:\/\//i.test(rawRef) || rawRef.includes("/"))
          ? ""
          : resolveGitHubRepoSlug(repoRoot, config, options.repo).slug;
      const target = parseIssueRef(rawRef, defaultSlug);

      const payload = reviewIssue({
        repoSlug: target.repoSlug,
        repoName: target.repoName,
        number: target.number,
        ref: target.ref,
        summary: options.summary,
        commit: options.commit,
        pr: options.pr,
        checks: options.checks,
        risks: options.risks,
        integrationBranch: config.integrationBranch || config.baseBranch || "main",
        issuesConfig,
        dryRun: options.dryRun,
        cwd: repoRoot,
      });

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Moved ${payload.ref} to ${payload.status} (issue left open for PR/manual acceptance).`);
      return;
    }

    if (sub === "release") {
      const rawRef = options.positionals[0];
      const defaultSlug =
        rawRef && (/^https?:\/\//i.test(rawRef) || rawRef.includes("/"))
          ? ""
          : resolveGitHubRepoSlug(repoRoot, config, options.repo).slug;
      const target = parseIssueRef(rawRef, defaultSlug);

      const payload = releaseIssue({
        repoSlug: target.repoSlug,
        repoName: target.repoName,
        number: target.number,
        ref: target.ref,
        blocked: options.blocked,
        reason: options.reason,
        issuesConfig,
        dryRun: options.dryRun,
        cwd: repoRoot,
      });

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Released ${payload.ref}${payload.blocked ? ` (marked ${issuesConfig.blockedLabel})` : ""}.`);
      return;
    }

    if (sub === "labels:sync") {
      const repoInfo = resolveGitHubRepoSlug(repoRoot, config, options.repo);
      const entry = syncIssueLabels({
        repoSlug: repoInfo.slug,
        repoName: repoInfo.name,
        issuesConfig,
        dryRun: options.dryRun,
        cwd: repoRoot,
      });

      if (options.json) {
        console.log(JSON.stringify({ dryRun: options.dryRun, ...entry }, null, 2));
        return;
      }
      console.log(`${options.dryRun ? "[dry-run] " : ""}Synced ${entry.labels.length} workflow labels on ${entry.repoSlug}`);
      return;
    }

    fail(`Unknown issue subcommand "${options.subcommand}".`, usage);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
