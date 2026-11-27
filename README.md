# featflow

**AI-native feature workflow: Skill + CLI + Git & Agent Hooks.**

[中文文档](./README.zh-CN.md)

`featflow` gives human developers and AI coding agents (Codex, Claude Code, Cursor, Antigravity, and any Agent Skills-compatible client) a disciplined, resumable engineering loop:

1. **Read-only Discovery** before touching files or branches.
2. **Concrete Plan & Explicit Approval** before implementation.
3. **Isolated Git Worktrees** per task branch so parallel sessions never collide.
4. **Canonical Feature & Program Records** under `features/` so long-running tasks survive context compaction, session handoffs, and multi-phase initiatives.
5. **Programmatic Guardrails** via Git hooks and optional Coding Agent `PreToolUse` / `UserPromptSubmit` / `Stop` hooks that actually enforce branch protection and plan completeness.

Zero runtime dependencies. Pure Node.js ESM (`>=20`). Cross-platform (macOS, Linux, Windows).

---

## Flexible Adoption (Global-First or Repo-Embedded)

Install `featflow` **once globally** and adapt its footprint per repository — no need to add dependencies or boilerplate to every project:

| Mode | Footprint in target repo | Best for |
| --- | --- | --- |
| **1. Zero-Footprint Global (Recommended)** | **0 files** (uses built-in templates via `featflow new --local` and `.git/hooks/` via `featflow hooks install --local`) | Personal repos, Python/Go/Rust repos, contributing to external OSS repos without touching tracked files |
| **2. Lightweight Global + Config** | **1 file** (`.featflow.json` only — no `package.json`, lockfile, or CI changes) | Multi-repo developers and teams who install `featflow` once on dev machines (like `gh` or `codegraph`) |
| **3. Team Embedded (`devDependency`)** | `package.json` + `.featflow.json` + synced Skill/templates/`.githooks/` + CI `featflow sync --check` | Large JS/TS teams requiring identical locked versions across all contributors and CI |

---

## Quick Start

### Option A — Global Install (Recommended, works across all repos & languages)

```bash
# 1. Install the CLI globally once
npm install -g github:daniel-style/featflow#v0.2.0

# 2. Install the Agent Skill globally once (Codex, Claude Code, Cursor, Antigravity)
npx skills add https://github.com/daniel-style/featflow --skill featflow -g
```

Use immediately inside **any** Git repository (zero repo files modified):

```bash
# Optional: enable local branch-protection & auto-cleanup hooks in .git/hooks/ (0 tracked files)
featflow hooks install --local

# Create a task branch in a dedicated worktree
featflow worktree feat/oauth-pkce

# Draft a feature plan (stored locally in .featflow/features/ via .git/info/exclude)
cd ../my-repo-worktrees/feat-oauth-pkce
featflow new oauth-pkce --local

# After verifying & committing, merge back and clean up automatically
featflow finish feat/oauth-pkce
```

Want custom branch rules (`developer-branch` mode, `postWorktreeCreate` hooks, etc.) without touching `package.json`? Add just a `.featflow.json` in the repository root.

### Option B — Embed in a Team JS/TS Repository

```bash
npm install -D github:daniel-style/featflow#v0.2.0

# Initialize (default: trunk mode; or --mode developer-branch)
npx featflow init --with-githooks

# Optional: add Codex or Claude Code agent hook configs
npx featflow init --with-codex-hooks --with-claude-hooks
```

Then copy the short rules snippet from [`templates/snippets/AGENTS-workflow.md`](./templates/snippets/AGENTS-workflow.md) into your repository's `AGENTS.md` or `CLAUDE.md`.

---

## Supported Branch Topologies

### 1. `trunk` Mode (Default — Solo, Small Teams, OSS)

```text
main (protected)
  ├── feat/oauth-pkce          (dedicated worktree)
  └── fix/retry-timeout        (dedicated worktree)
```

- `featflow worktree feat/oauth-pkce` creates `../<repo>-worktrees/feat-oauth-pkce` from `main`.
- With `"finishTarget": "merge"` (default): `featflow finish feat/oauth-pkce` merges into `main`, pushes if a remote exists (skip with `--no-push`), and removes the clean worktree and local task branch.
- With `"finishTarget": "pr"` (or `--pr`): `featflow finish feat/oauth-pkce --pr` pushes the branch for a pull request; after GitHub merges it, run `featflow pr-cleanup <pr-number>`.

### 2. `developer-branch` Mode (Multi-Developer High-Velocity Teams)

```text
main (release, protected)
  └── dev (team integration, protected)
        ├── alice (personal developer branch)
        │     ├── feat/alice-oauth-pkce     (task worktree)
        │     └── fix/alice-retry-timeout   (task worktree)
        └── bob (personal developer branch)
```

- Run once per checkout: `featflow setup alice` (creates/tracks `alice` from `origin/dev`, saves `git config featflow.developerBranch alice`, enables hooks).
- Daily tasks branch from `alice` as `<prefix>/alice-<task>` (never `alice/...`, because Git cannot store both `alice` and `alice/...` refs simultaneously).
- `featflow finish feat/alice-oauth-pkce` merges into `alice`, pushes `alice`, removes the clean task worktree and local branch, and never merges directly into `dev` or `main`.
- Team integration (`alice -> dev`) and release promotion (`dev -> main`) happen via explicit pull requests.

---

## CLI Reference

| Command | Description |
| --- | --- |
| `featflow new <slug> [options]` | Create a feature (or `--program`) record from the repo template or `featflow`'s built-in template, auto-filling timestamps, `owner`, and branch. Pass `--local` to store under `.featflow/features/` (excluded via `.git/info/exclude`, zero tracked files). |
| `featflow hooks <install\|uninstall\|status>` | Manage Git hooks: `--local` (default) adds/removes fenced blocks inside `.git/hooks/` without modifying repo files or overwriting custom hooks; `--repo` installs tracked `.githooks/`. |
| `featflow init [options]` | Scaffold `.featflow.json`, `features/` templates, `.agents/skills/featflow/SKILL.md`, optional `.githooks/`, and optional Codex / Claude Code hooks. |
| `featflow sync [options]` | Sync managed Skill, feature templates, and `.githooks/` from the installed `featflow` version without modifying `.featflow.json` or feature records. Pass `--check` in CI to fail on drift, or `--only skill,templates,githooks`. |
| `featflow setup [dev-branch]` | Configure personal developer branch (in `developer-branch` mode) and safely enable Git hooks without clobbering Husky/Lefthook. |
| `featflow status` | Inspect workflow mode, branch/remote status, all worktrees, active/paused feature records, and next recommended step. |
| `featflow worktree <branch> [path] [base]` | Create a typed task branch in a dedicated sibling worktree and run configured `postWorktreeCreate` commands. |
| `featflow finish <branch>` | Merge/push a verified task branch, safely exit the task worktree, delete the clean worktree & local branch, and prune other merged task branches. Supports `--no-push`, `--pr`, `--dry-run`, `--keep-worktree`, `--keep-branch`. |
| `featflow cleanup` | Clean local task branches and clean worktrees already merged into the base/developer branch. Also runs on `post-merge` via `--post-merge`. |
| `featflow pr-cleanup <pr>` | After a GitHub PR merges (via `gh`), sync the local base branch, remove the clean PR worktree, delete local/remote branch, and prune refs. |
| `featflow plan-check [path]` | Validate required `Plan Details` headings, placeholder resolution (ignoring code spans/fences), and recorded pre-implementation approval. |
| `featflow policy <pre-commit\|pre-push>` | Git hook guard blocking direct commits/pushes to protected branches (bypass one-off bootstrap with `FEATFLOW_BOOTSTRAP=1`). |
| `featflow hook <codex\|claude-code> <event>` | Coding-agent hook adapter for `pre-tool-use`, `user-prompt`, and `stop`. |
| `featflow doctor` | Run repository health checks across Git, config, templates, Skill, hooks, and active feature plan. |

---

## Configuration (`.featflow.json`)

```json
{
  "mode": "trunk",
  "remote": "origin",
  "requireRemote": false,
  "baseBranch": "main",
  "integrationBranch": "dev",
  "releaseBranch": "main",
  "protectedBranches": ["main"],
  "finishTarget": "merge",
  "developerBranchConfigKey": "featflow.developerBranch",
  "worktreeParent": null,
  "featuresDir": "features",
  "trackFeaturesInGit": true,
  "trackCurrentFeaturePointer": false,
  "prefixes": ["feat", "fix", "chore", "docs", "test", "refactor", "perf", "security"],
  "productPaths": ["src/", "apps/", "services/", "packages/", "lib/"],
  "postWorktreeCreate": [],
  "verifyCommands": {
    "src/": "npm test"
  },
  "dangerousCommands": {
    "blockDestructiveGit": true,
    "blockForcePush": true,
    "blockEnvWrite": true,
    "blockedPackageManagers": []
  }
}
```

### Notable Design Choices

- **No Husky / Lefthook clobbering**: If `git config core.hooksPath` is already set to another manager (e.g., `.husky`), `featflow init --with-githooks` and `featflow setup` refuse to overwrite it and print the exact one-liners to append to your existing hook files.
- **No `current-feature.md` merge conflicts**: By default, `trackCurrentFeaturePointer` is `false` (added to `.gitignore`), while `features/active/` serves as the canonical multi-worktree active list.
- **Tracked vs. Local-only `features/`**: Prefer keeping AI planning records out of Git history? Pass `featflow init --local-features` to ignore `features/` while keeping the full Skill, CLI, and plan-gate workflow locally.
- **Smart `PreToolUse` plan gating**: Unlike naive keyword regexes, `featflow hook` distinguishes read-only shell commands (`rg`, `cat`, `git diff`) from mutating writes, strips Markdown code spans/fences before checking template placeholders, and checks that `Pre-Implementation Approval` is no longer `pending`.
- **Optional post-worktree hooks**: Need automatic dependency install (`pnpm install --frozen-lockfile --offline`) or local index bootstrap (`codegraph init`) when creating a worktree? Add them to `postWorktreeCreate` in `.featflow.json`.
- **Multi-repository sync without drift**: Upgrade `featflow` in any project and run `featflow sync` to refresh the managed Skill, templates, and `.githooks/` while keeping `.featflow.json` and active/done records untouched. Add `featflow sync --check` to CI so repositories stay aligned with their pinned `featflow` version.

---

## Development & Testing

```bash
npm run smoke
npm test
```

All tests run with Node's built-in test runner (`node:test`) against isolated temporary Git repositories.

## License

[MIT](./LICENSE)
