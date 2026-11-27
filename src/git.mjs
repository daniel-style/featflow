import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function quoteArg(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);
}

export function formatCommand(command, args) {
  return [command, ...args].map(quoteArg).join(" ");
}

export function fail(message, usageText = "") {
  console.error(`error: ${message}`);
  if (usageText) {
    console.error("");
    console.error(usageText);
  }
  process.exit(1);
}

export function runRead(command, args, cwd = process.cwd(), extra = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: extra.env ? { ...process.env, ...extra.env } : process.env,
  });
  if (result.error) {
    throw new Error(`${formatCommand(command, args)} failed:\n${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim() || `exit code ${String(result.status)}`;
    throw new Error(`${formatCommand(command, args)} failed:\n${detail}`);
  }
  return (result.stdout ?? "").trim();
}

export function runReadSoft(command, args, cwd = process.cwd(), extra = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: extra.env ? { ...process.env, ...extra.env } : process.env,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error ?? null,
  };
}

export function runStatus(command, args, cwd = process.cwd(), extra = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "ignore",
    env: extra.env ? { ...process.env, ...extra.env } : process.env,
  });
  return result.error ? -1 : (result.status ?? -1);
}

export function runWrite(command, args, cwd, options = {}) {
  const printable = cwd ? `(cd ${quoteArg(cwd)} && ${formatCommand(command, args)})` : formatCommand(command, args);
  if (options.dryRun) {
    console.log(`[dry-run] ${printable}`);
    return;
  }

  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: options.shell ?? false,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  if (result.error) {
    throw new Error(`${formatCommand(command, args)} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${formatCommand(command, args)} failed with exit code ${String(result.status)}.`);
  }
}

export function commandExists(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

export function canonicalPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const nativeRealpath = realpathSync.native ?? realpathSync;
  if (existsSync(resolved)) {
    try {
      return nativeRealpath(resolved);
    } catch {
      return resolved;
    }
  }
  const tail = [];
  let cursor = resolved;
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return resolved;
    }
    tail.unshift(path.basename(cursor));
    cursor = parent;
    if (existsSync(cursor)) {
      try {
        return path.join(nativeRealpath(cursor), ...tail);
      } catch {
        return resolved;
      }
    }
  }
}

export function samePath(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isInsidePath(child, parent) {
  const resolvedChild = canonicalPath(child);
  const resolvedParent = canonicalPath(parent);
  const relative = path.relative(
    process.platform === "win32" ? resolvedParent.toLowerCase() : resolvedParent,
    process.platform === "win32" ? resolvedChild.toLowerCase() : resolvedChild,
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function findRepoRoot(startCwd = process.cwd()) {
  const result = runReadSoft("git", ["rev-parse", "--show-toplevel"], startCwd);
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  return canonicalPath(result.stdout);
}

export function findGitCommonDir(startCwd = process.cwd()) {
  const commonDirResult = runReadSoft("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], startCwd);
  if (commonDirResult.status === 0 && commonDirResult.stdout) {
    return canonicalPath(commonDirResult.stdout);
  }
  const fallback = runReadSoft("git", ["rev-parse", "--git-common-dir"], startCwd);
  if (fallback.status === 0 && fallback.stdout) {
    return canonicalPath(path.resolve(startCwd, fallback.stdout));
  }
  return null;
}

export function findMainRepoRoot(startCwd = process.cwd()) {
  const commonDir = findGitCommonDir(startCwd);
  if (commonDir && path.basename(commonDir) === ".git") {
    return path.dirname(commonDir);
  }
  return findRepoRoot(startCwd);
}

export function gitConfigGet(key, cwd) {
  const result = runReadSoft("git", ["config", "--get", key], cwd);
  return result.status === 0 ? result.stdout : "";
}

export function gitConfigSet(key, value, cwd, options = {}) {
  runWrite("git", ["config", key, value], cwd, options);
}

export function currentBranch(cwd) {
  const result = runReadSoft("git", ["branch", "--show-current"], cwd);
  return result.status === 0 ? result.stdout : "";
}

export function localBranchExists(branchName, cwd) {
  return runStatus("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], cwd) === 0;
}

export function remoteExists(remoteName, cwd) {
  return runStatus("git", ["remote", "get-url", remoteName], cwd) === 0;
}

export function remoteTrackingBranchExists(remote, branchName, cwd) {
  return runStatus("git", ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branchName}`], cwd) === 0;
}

export function remoteBranchExists(remote, branchName, cwd) {
  if (!remoteExists(remote, cwd)) {
    return false;
  }
  return runStatus("git", ["ls-remote", "--exit-code", "--heads", remote, branchName], cwd) === 0;
}

export function localBranches(cwd) {
  const output = runRead("git", ["for-each-ref", "refs/heads", "--format=%(refname:short)"], cwd);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

export function parseWorktrees(output) {
  const worktrees = [];
  let current = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current);
      }
      current = { path: canonicalPath(line.slice("worktree ".length)) };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }

  if (current) {
    worktrees.push(current);
  }

  return worktrees;
}

export function gitWorktrees(cwd) {
  return parseWorktrees(runRead("git", ["worktree", "list", "--porcelain"], cwd));
}

export function findWorktreeForBranch(worktrees, branchName) {
  return worktrees.find((worktree) => worktree.branch === `refs/heads/${branchName}`) ?? null;
}

export function findWorktreeForPath(worktrees, worktreePath) {
  return worktrees.find((worktree) => samePath(worktree.path, worktreePath)) ?? null;
}

export function statusShort(cwd) {
  return runRead("git", ["status", "--short"], cwd);
}

export function ensureCleanWorktree(cwd, label) {
  const status = statusShort(cwd);
  if (status) {
    throw new Error(`Refusing to modify dirty ${label} worktree ${cwd}:\n${status}`);
  }
}

export function validateGitBranchName(branchName, cwd, options = {}) {
  const label = options.label ?? "branch";
  if (!branchName) {
    throw new Error(`Missing ${label} name.`);
  }
  if (!options.allowSlash && branchName.includes("/")) {
    throw new Error(`${label} "${branchName}" must be a simple branch name without "/".`);
  }
  if (/\s/.test(branchName)) {
    throw new Error(`${label} "${branchName}" must not contain whitespace.`);
  }
  if (runStatus("git", ["check-ref-format", "--branch", branchName], cwd) !== 0) {
    throw new Error(`${label} "${branchName}" is not a valid Git branch name.`);
  }
}

export function validateDeveloperBranchName(branchName, cwd, protectedBranches) {
  validateGitBranchName(branchName, cwd, { allowSlash: false, label: "developer branch" });
  if (protectedBranches.has(branchName)) {
    throw new Error(`Developer branch cannot be protected branch "${branchName}".`);
  }
}

export function validateTaskBranchName(branchName, cwd, protectedBranches) {
  validateGitBranchName(branchName, cwd, { allowSlash: true, label: "task branch" });
  if (protectedBranches.has(branchName)) {
    throw new Error(`Task branch cannot be protected branch "${branchName}".`);
  }
}

export function isAncestor(ancestorRef, descendantRef, cwd) {
  return runStatus("git", ["merge-base", "--is-ancestor", ancestorRef, descendantRef], cwd) === 0;
}

export function isTaskBranch(branchName, config, developerBranch = "") {
  const slashIndex = branchName.indexOf("/");
  if (slashIndex === -1) {
    return false;
  }
  const prefix = branchName.slice(0, slashIndex);
  const rest = branchName.slice(slashIndex + 1);
  if (!config.prefixes.includes(prefix) || !rest) {
    return false;
  }
  if (config.mode === "developer-branch") {
    return Boolean(developerBranch) && rest.startsWith(`${developerBranch}-`);
  }
  return true;
}

export function sanitizeBranchForDir(branchName) {
  return branchName.replaceAll("/", "-").replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function gitChangedFiles(cwd) {
  if (process.env.FEATFLOW_TEST_CHANGED_FILES) {
    return process.env.FEATFLOW_TEST_CHANGED_FILES.split(/\r?\n|,/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const result = runReadSoft("git", ["status", "--porcelain"], cwd);
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").pop()?.trim() ?? "")
    .filter(Boolean);
}
