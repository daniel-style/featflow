import {
  currentBranch,
  gitConfigGet,
  remoteExists,
  remoteTrackingBranchExists,
  runReadSoft,
} from "./git.mjs";
import { evaluateFileSizeBudget } from "./size-check.mjs";

export function setupInstructions(config) {
  if (config.mode === "developer-branch") {
    return [
      "No developer branch workflow is configured for this checkout.",
      "",
      "Run:",
      "  featflow setup <your-branch-name>",
      "",
      "Example:",
      "  featflow setup alice",
    ].join("\n");
  }
  return [
    "Featflow is not initialized in this repository yet.",
    "",
    "Run:",
    "  featflow init",
  ].join("\n");
}

export function isBootstrapAllowed(env = process.env) {
  return env.FEATFLOW_BOOTSTRAP === "1" || env.FEATFLOW_INTERNAL_FINISH === "1";
}

export function checkWorkflowReady(repoRoot, config, env = process.env) {
  if (isBootstrapAllowed(env)) {
    return { ok: true, developerBranch: gitConfigGet(config.developerBranchConfigKey, repoRoot) };
  }

  if (config.mode === "developer-branch") {
    const devBranch = gitConfigGet(config.developerBranchConfigKey, repoRoot);
    if (!devBranch) {
      return { ok: false, message: setupInstructions(config) };
    }
    const hasRemote = remoteExists(config.remote, repoRoot);
    if (config.requireRemote && hasRemote) {
      if (!remoteTrackingBranchExists(config.remote, config.integrationBranch, repoRoot)) {
        return {
          ok: false,
          message: `Missing ${config.remote}/${config.integrationBranch}. Fetch or bootstrap ${config.integrationBranch} before committing.`,
        };
      }
      if (!remoteTrackingBranchExists(config.remote, devBranch, repoRoot)) {
        return {
          ok: false,
          message: `Missing ${config.remote}/${devBranch}. Run: featflow setup ${devBranch}`,
        };
      }
    }
    return { ok: true, developerBranch: devBranch };
  }

  return { ok: true, developerBranch: "" };
}

export function evaluatePreCommit(repoRoot, config, env = process.env) {
  const ready = checkWorkflowReady(repoRoot, config, env);
  if (!ready.ok) {
    return ready;
  }
  if (isBootstrapAllowed(env)) {
    return { ok: true };
  }

  const branch = currentBranch(repoRoot);
  const protectedSet = new Set(config.protectedBranches);
  if (protectedSet.has(branch)) {
    const baseHint =
      config.mode === "developer-branch" && ready.developerBranch
        ? `your developer branch (${ready.developerBranch})`
        : config.baseBranch;
    return {
      ok: false,
      message: `Refusing to commit directly on protected branch "${branch}". Create a task worktree from ${baseHint} using: featflow worktree <prefix>/<task>`,
    };
  }

  if (config.fileSizeBudget?.enforceInPreCommit && env.FEATFLOW_SKIP_SIZE_CHECK !== "1") {
    const stagedRes = runReadSoft(
      "git",
      ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
      repoRoot,
    );
    const stagedFiles =
      stagedRes.status === 0
        ? stagedRes.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
    if (stagedFiles.length > 0) {
      const sizeRes = evaluateFileSizeBudget(repoRoot, config, { files: stagedFiles });
      if (!sizeRes.ok) {
        return {
          ok: false,
          message: [
            "Refusing to commit because staged file(s) exceed configured fileSizeBudget:",
            ...sizeRes.failures.map((f) => `  - ${f.path}: ${f.lines} lines exceeds ${f.label}`),
            "Split oversized files into smaller focused modules (or bypass once with FEATFLOW_SKIP_SIZE_CHECK=1).",
          ].join("\n"),
        };
      }
    }
  }

  return { ok: true };
}

export function evaluatePrePush(repoRoot, config, stdinText, env = process.env) {
  const ready = checkWorkflowReady(repoRoot, config, env);
  if (!ready.ok) {
    return ready;
  }
  if (isBootstrapAllowed(env)) {
    return { ok: true };
  }

  const protectedSet = new Set(config.protectedBranches);
  for (const line of String(stdinText ?? "").split(/\r?\n/).filter(Boolean)) {
    const parts = line.trim().split(/\s+/);
    const remoteRef = parts[2] ?? "";
    const remoteBranch = remoteRef.startsWith("refs/heads/")
      ? remoteRef.slice("refs/heads/".length)
      : "";
    if (protectedSet.has(remoteBranch)) {
      return {
        ok: false,
        message: `Refusing to push directly to protected branch "${remoteBranch}". Open a pull request or run featflow finish.`,
      };
    }
  }

  return { ok: true };
}
