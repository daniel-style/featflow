import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { packageRoot } from "../config.mjs";
import { fail, findGitCommonDir, findRepoRoot, gitConfigGet } from "../git.mjs";
import { configureGitHooksSafely } from "./init.mjs";

const BLOCK_START = "# >>> featflow managed hook >>>";
const BLOCK_END = "# <<< featflow managed hook <<<";

const HOOK_SNIPPETS = {
  "pre-commit": [
    BLOCK_START,
    'if [ -x "./node_modules/.bin/featflow" ]; then',
    "  ./node_modules/.bin/featflow policy pre-commit || exit $?",
    "elif command -v featflow >/dev/null 2>&1; then",
    "  featflow policy pre-commit || exit $?",
    "fi",
    BLOCK_END,
  ].join("\n"),
  "pre-push": [
    BLOCK_START,
    'if [ -x "./node_modules/.bin/featflow" ]; then',
    "  ./node_modules/.bin/featflow policy pre-push || exit $?",
    "elif command -v featflow >/dev/null 2>&1; then",
    "  featflow policy pre-push || exit $?",
    "fi",
    BLOCK_END,
  ].join("\n"),
  "post-merge": [
    BLOCK_START,
    'if [ -x "./node_modules/.bin/featflow" ]; then',
    "  ./node_modules/.bin/featflow cleanup --post-merge || true",
    "elif command -v featflow >/dev/null 2>&1; then",
    "  featflow cleanup --post-merge || true",
    "fi",
    BLOCK_END,
  ].join("\n"),
};

const usage = `
Usage:
  featflow hooks install [--local|--repo]
  featflow hooks uninstall [--local]
  featflow hooks status

Manages Git hooks for featflow without polluting the target repository.

Modes:
  --local (default)   Install/remove managed blocks inside .git/hooks/ (zero tracked
                      files, preserves existing local hooks, works across worktrees).
  --repo              Copy tracked hooks to .githooks/ and safely configure core.hooksPath.
`.trim();

function stripManagedBlock(content) {
  const regex = new RegExp(`(?:\\r?\\n)*${escapeRegex(BLOCK_START)}[\\s\\S]*?${escapeRegex(BLOCK_END)}(?:\\r?\\n)?`, "g");
  return content.replace(regex, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasManagedBlock(filePath) {
  if (!existsSync(filePath)) {
    return false;
  }
  return readFileSync(filePath, "utf8").includes(BLOCK_START);
}

function installLocalHooks(repoRoot) {
  const commonDir = findGitCommonDir(repoRoot);
  if (!commonDir) {
    fail("Could not resolve .git directory.");
  }

  const hooksPath = gitConfigGet("core.hooksPath", repoRoot);
  if (hooksPath) {
    console.warn(`Warning: core.hooksPath is set to "${hooksPath}", so Git ignores .git/hooks/.`);
    console.warn("Add these calls to your existing hook manager instead:");
    console.warn("  pre-commit: featflow policy pre-commit");
    console.warn("  pre-push:   featflow policy pre-push");
    console.warn("  post-merge: featflow cleanup --post-merge || true");
    return;
  }

  const hooksDir = path.join(commonDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const installed = [];
  for (const [hookName, snippet] of Object.entries(HOOK_SNIPPETS)) {
    const hookFile = path.join(hooksDir, hookName);
    let nextContent;
    if (existsSync(hookFile)) {
      const existing = readFileSync(hookFile, "utf8");
      const cleaned = stripManagedBlock(existing);
      const base = cleaned.length > 0 ? cleaned : "#!/usr/bin/env sh";
      nextContent = `${base}\n\n${snippet}\n`;
    } else {
      nextContent = `#!/usr/bin/env sh\n\n${snippet}\n`;
    }
    writeFileSync(hookFile, nextContent, "utf8");
    chmodSync(hookFile, 0o755);
    installed.push(hookName);
  }

  console.log(`Installed local featflow Git hooks in ${hooksDir}: ${installed.join(", ")}`);
  console.log("Zero repository files were modified (existing custom hooks were preserved).");
}

function uninstallLocalHooks(repoRoot) {
  const commonDir = findGitCommonDir(repoRoot);
  if (!commonDir) {
    fail("Could not resolve .git directory.");
  }

  const hooksDir = path.join(commonDir, "hooks");
  const removed = [];
  const preserved = [];

  for (const hookName of Object.keys(HOOK_SNIPPETS)) {
    const hookFile = path.join(hooksDir, hookName);
    if (!hasManagedBlock(hookFile)) {
      continue;
    }
    const existing = readFileSync(hookFile, "utf8");
    const cleaned = stripManagedBlock(existing).trim();
    const isOnlyShebang = !cleaned || /^#!\/[^\r\n]+$/.test(cleaned);
    if (isOnlyShebang) {
      unlinkSync(hookFile);
      removed.push(hookName);
    } else {
      writeFileSync(hookFile, `${cleaned}\n`, "utf8");
      preserved.push(hookName);
    }
  }

  if (removed.length === 0 && preserved.length === 0) {
    console.log("No local featflow Git hooks found in .git/hooks/.");
    return;
  }
  if (removed.length > 0) {
    console.log(`Removed featflow-only local hooks: ${removed.join(", ")}`);
  }
  if (preserved.length > 0) {
    console.log(`Removed featflow block while preserving custom hooks: ${preserved.join(", ")}`);
  }
}

function installRepoHooks(repoRoot) {
  const srcDir = path.join(packageRoot, "templates", "githooks");
  const destDir = path.join(repoRoot, ".githooks");
  mkdirSync(destDir, { recursive: true });
  for (const hookName of Object.keys(HOOK_SNIPPETS)) {
    const dest = path.join(destDir, hookName);
    copyFileSync(path.join(srcDir, hookName), dest);
    chmodSync(dest, 0o755);
  }

  const result = configureGitHooksSafely(repoRoot);
  if (result.configured) {
    console.log("Installed tracked hooks in .githooks/ and set core.hooksPath=.githooks.");
  } else {
    console.log(`Copied hooks to .githooks/, but kept existing core.hooksPath=${result.existingHooksPath}.`);
  }
}

function showHookStatus(repoRoot) {
  const commonDir = findGitCommonDir(repoRoot);
  const hooksPath = gitConfigGet("core.hooksPath", repoRoot);
  const localHooksDir = commonDir ? path.join(commonDir, "hooks") : "";
  const localActive = localHooksDir
    ? Object.keys(HOOK_SNIPPETS).filter((name) => hasManagedBlock(path.join(localHooksDir, name)))
    : [];
  const repoHooksExist = existsSync(path.join(repoRoot, ".githooks", "pre-commit"));

  console.log("featflow hooks status");
  console.log(`core.hooksPath: ${hooksPath || "(default .git/hooks)"}`);
  console.log(`Local .git/hooks managed blocks: ${localActive.length > 0 ? localActive.join(", ") : "(none)"}`);
  console.log(`Tracked .githooks/ present: ${repoHooksExist ? "yes" : "no"}`);
}

export async function runHooks(argv) {
  const action = argv[0] ?? "";
  if (!action || action === "-h" || action === "--help") {
    console.log(usage);
    return;
  }

  const rest = argv.slice(1);
  if (rest.includes("-h") || rest.includes("--help")) {
    console.log(usage);
    return;
  }

  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    fail("Not inside a Git repository.");
  }

  const useRepo = rest.includes("--repo");

  if (action === "install") {
    if (useRepo) {
      installRepoHooks(repoRoot);
    } else {
      installLocalHooks(repoRoot);
    }
    return;
  }

  if (action === "uninstall") {
    uninstallLocalHooks(repoRoot);
    return;
  }

  if (action === "status") {
    showHookStatus(repoRoot);
    return;
  }

  fail(`Unknown hooks subcommand "${action}". Expected "install", "uninstall", or "status".`, usage);
}
