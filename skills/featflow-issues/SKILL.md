---
name: featflow-issues
description: Optional GitHub Issues closed-loop workflow built on featflow (`featflow issue`). Use whenever the user explicitly wants to file a new GitHub Issue (with standardized fix:/feat:/docs: prefixes and optional screenshot uploads), list or triage open GitHub Issues, claim an Issue with collision protection into an isolated featflow worktree, or move a verified fix to status:in-review.
---

# GitHub Issue Closed-Loop Workflow (`featflow-issues`)

Manage the full lifecycle of GitHub Issues directly inside a `featflow`-managed repository using `featflow issue` (powered by GitHub CLI `gh`) — from filing prefixed Issues with optional original screenshots to collision-safe claiming into isolated `featflow` worktrees, verifying, and moving to `status:in-review`.

## Intent Routing (Direct Fix vs. File Issue vs. Claim)

Distinguish user intent clearly — never create an unwanted GitHub Issue when the user just wants a direct fix, and never start editing code when the user only asked to file an Issue:

- **Direct fix / build (default)**: Prompts like "帮我修一下这个 bug", "fix this error", or "adjust this button" -> go straight to normal `featflow` local development (`featflow worktree` / `featflow finish`). Do **not** create a GitHub Issue unless asked.
- **File an Issue (no code edits)**: Prompts with explicit filing intent — e.g., **"提单 / 提个单 / 提个 bug / 提个需求 / 记个单 / 提 issue / file an issue"** (or shorthand `提单 fix:` / `提单 feat:`) -> follow **Flow A** (`featflow issue create`).
- **Fetch / Claim / Fix Issues**: Prompts like **"拉单 / 看单 / 认领 / 看看未认领的 / fix #12 / claim #12"** -> follow **Flow B** (`featflow issue list | view --download-images | claim | review`).
- **Ambiguous screenshot or symptom only** (user shares a screenshot/symptom without saying whether to fix now or file an Issue): briefly summarize what you observe, then ask one crisp question: *"要直接排查修复，还是先帮你提一个 `fix(...)` GitHub Issue？"*

## Unified Prefix, Label & Branch Taxonomy

Use the same typed prefixes across Issue titles, `featflow` worktree branches, and Conventional Commits:

| Work Type | Issue Title Format | Default Label | Claimed Branch (`trunk` / `developer-branch`) |
| --- | --- | --- | --- |
| Bug / defect | `fix(<scope>): <summary>` | `bug` | `fix/issue-<num>-<slug>` / `fix/<dev>-issue-<num>-<slug>` |
| New feature | `feat(<scope>): <summary>` | `enhancement` | `feat/issue-<num>-<slug>` / `feat/<dev>-issue-<num>-<slug>` |
| Documentation | `docs(<scope>): <summary>` | `documentation` | `docs/issue-<num>-<slug>` / `docs/<dev>-issue-<num>-<slug>` |
| Refactor / Perf / Security / Chore / Test | `refactor:` / `perf:` / `security:` / `chore:` / `test:` | Optional `--label` | `<prefix>/issue-<num>-<slug>` / `<prefix>/<dev>-issue-<num>-<slug>` |

Workflow labels (idempotently synced via `featflow issue labels:sync`):
- State: `status:in-progress` (active lock), `status:in-review` (fix verified & pushed, awaiting PR/acceptance), `status:blocked`
- Priority: `priority:p0` (critical), `priority:p1` (high), `priority:p2` (normal)
- Pickup: `agent-ready` (scoped for AI coding agent pickup)

---

## Flow A: Filing a GitHub Issue (Text or Screenshots)

1. **Inspect visually & check duplicates (read-only)**:
   - Inspect any user-provided screenshots carefully (surface, error text, visual state).
   - Check open issues first (`featflow issue list --json`) to avoid duplicates.
   - Optionally run narrow read-only discovery to note suspected modules/files.
2. **Draft & confirm before creating** (unless the user explicitly opted out):
   - Prefixed title: `<type>(<scope>): <concise summary>`
   - Suggested labels (`bug` / `enhancement` / `documentation`, optional `priority:p0|p1|p2`, `agent-ready`)
   - Structured body: Observed Behavior / Context, Steps to Reproduce (for `fix`) or Goal (for `feat`), Expected Behavior / Acceptance Criteria, and Suspected Scope.
3. **Create the Issue**:
   ```bash
   featflow issue create \
     --type fix --scope auth \
     --title "login screen stays blank after OAuth callback" \
     --body-file /tmp/issue-body.md \
     --priority p1 --agent-ready --json
   ```
   - When `.featflow.json` configures `issues.assetsRepo` (or `--assets-repo <owner/repo>` is passed), pass `--attach /path/to/screenshot.png` (repeatable, <= 10 MB) to upload originals via `gh api` and embed them directly in the Issue body without bloating the code repository.
   - Report the created Issue reference (`<repo>#<num>`) and URL.

---

## Flow B: Fetching, Claiming, Fixing & Reviewing GitHub Issues

1. **Fetch & Triage (Read-Only)**:
   - List open issues:
     ```bash
     featflow issue list --unassigned --json
     ```
   - Inspect full details and download any attached original screenshots (when `issues.assetsRepo` is configured):
     ```bash
     featflow issue view <num> --download-images --json
     ```
   - Inspect every returned `downloadedImages[].localPath` before diagnosing UI or visual bugs.
   - Complete read-only root-cause discovery and check repository-specific rules in `AGENTS.md` and local specialist skills.

2. **Present Triage & Implementation Plan (Universal Pre-Implementation Gate)**:
   - Summarize target Issue(s), priority, root cause / implementation approach, affected files, whether a `features/active/` record is needed (substantial features -> yes; small isolated fixes -> Lightweight Change Workflow), and verification commands.
   - Wait for explicit user approval before claiming issues, editing files, creating worktrees, or mutating GitHub state (unless explicitly waived).

3. **Atomic Claim + Isolated Worktree Creation**:
   ```bash
   featflow issue claim <num> --json
   ```
   - Preflights local worktree creation **before** mutating GitHub state so failed local setup never leaves a half-claimed Issue.
   - Checks for closed status, concurrent assignees, or `status:in-progress` collision lock; assigns `@me`, adds `status:in-progress`, posts a claim comment, and creates the matching typed `featflow` worktree (automatically adapting to `trunk` or `developer-branch` mode).

4. **Implement, Verify & Finish Inside the Worktree**:
   - Work strictly inside the created task worktree — never directly on protected branches (`main`, `dev`) or personal developer branches.
   - Honor all repository-specific quality gates, security invariants, regression guards, and tests declared in `AGENTS.md`.
   - Commit with a Conventional Commit message referencing the Issue without prematurely auto-closing on personal/feature branches:
     - `fix(auth): handle empty OAuth callback state (Refs #12)`
   - Finish cleanly via `featflow finish <branch>`.

5. **Move to `status:in-review` (Do Not Prematurely Close)**:
   ```bash
   featflow issue review <num> \
     --commit <short-sha> \
     --summary "Concise summary of fix and root cause" \
     --checks "Verification commands and pass counts" \
     --json
   ```
   - Leave the Issue open; close it automatically when the integration PR merges (include `Closes #<num>` in the PR body) or after manual acceptance, then clean up merged PR branches with `featflow pr-cleanup <pr>`.
   - If blocked, release instead of moving to review:
     ```bash
     featflow issue release <num> --blocked --reason "Why work is blocked"
     ```
