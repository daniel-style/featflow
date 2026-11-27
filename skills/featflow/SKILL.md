---
name: featflow
description: Structured AI-native feature planning, execution records, multi-phase program roadmaps, and isolated Git worktree workflow. Use whenever starting, planning, implementing, resuming, pausing, or completing a substantial feature, cross-module change, bug fix, or multi-phase initiative. Enforces read-only discovery, concrete pre-implementation planning, explicit user approval, dedicated worktrees, and clean branch lifecycle handoffs.
---

# Featflow — Feature Workflow

Use this skill from the active repository checkout or task worktree root. It keeps substantial engineering work predictable and resumable by pairing **discovery-first planning**, **explicit pre-implementation approval**, **canonical Markdown feature records**, and **isolated Git worktrees**.

## Core Files

`featflow` works in **three flexible modes** — from zero-footprint global usage (0 tracked repo files) to full repo-tracked team workflows:

- `.featflow.json` (optional): repository configuration (branch mode, protected branches, worktree parent, product paths, post-create hooks, verification hints). When absent, `featflow` defaults to `trunk` mode (`main`).
- `features/` (repo-tracked) **or** `.featflow/features/` (local zero-footprint via `featflow new --local`, excluded in `.git/info/exclude`):
  - `active/`: feature records currently being implemented.
  - `done/`: completed feature records.
  - `paused/`: parked feature records ready to resume later.
  - `programs/`: long-running program records linking multiple feature phases.
  - `_template.md` / `_program_template.md` (optional in repo): `featflow new` automatically uses the repo template when present and falls back to its built-in template otherwise.
- `features/current-feature.md` (optional local pointer): short summary of the active worktree's current feature. In parallel worktree setups, treat `active/` as the canonical list rather than a single shared pointer file.

## Core Principles

1. **Discovery precedes planning.** Perform read-only research into relevant modules, entry points, contracts, and tests before creating a worktree, drafting `Plan Details`, or naming affected files.
2. **User approval precedes implementation.** For any write-oriented work, present a concrete plan after discovery and wait for explicit approval before creating/switching an implementation worktree, editing tracked files, running generators, applying migrations, committing, pushing, or opening PRs.
   - If the user explicitly opts out of confirmation (e.g., "implement directly", "no confirmation needed"), record that instruction in `Pre-Implementation Approval` or `Handoff`.
3. **AI owns the records.** The AI drafts and maintains feature and program records from repository context and user constraints. Do not ask the user to manually fill templates.
4. **Complete `Plan Details` before product code.** Never edit product source files while an active feature record still has empty headings, template placeholders, or `Approval status: pending`. Run `featflow plan-check` when available.
5. **Re-plan on material drift.** If implementation uncovers a materially different root cause, scope, security boundary, migration need, or risk profile, pause and present an updated plan for approval before continuing.
6. **Isolated branches & worktrees.** Do not edit tracked files directly on protected branches (`main`, `dev`) or a long-lived developer branch unless the user explicitly approves that exception.
7. **Useful continuity over verbose diaries.** Record decisions, changed files, verification commands (including skipped checks and reasons), and residual risks.
8. **Zero secrets in records.** Never write API keys, credentials, private tokens, local-only `.env` values, or sensitive user data into `features/`.
9. **Absolute timestamps.** Use local 24-hour `YYYY-MM-DD-HHMM-short-kebab-title` for feature IDs and ISO 8601 timestamps with timezone offset (e.g., `2026-06-15T14:30:00Z` or local offset) in frontmatter.
10. **Standard statuses.** Use `planned`, `in_progress`, `review`, `blocked`, `paused`, `done`, `cancelled`.

## Branch Modes

Inspect `.featflow.json` (or run `featflow status`) to determine the repository's branch mode:

- **`trunk` mode (default)**:
  - Base branch: `baseBranch` (typically `main`).
  - Task branch format: `<prefix>/<short-kebab-title>` (e.g., `feat/oauth-pkce`, `fix/retry-backoff`).
  - Finish: `featflow finish <branch>` merges into `baseBranch` (when `finishTarget: "merge"`) or pushes the task branch for a pull request (when `finishTarget: "pr"` or `--pr`, followed by `featflow pr-cleanup <pr>` after merge).
- **`developer-branch` mode (team workflow)**:
  - Protected branches: `main` (release) and `dev` (team integration).
  - Personal developer branch: stored in `git config featflow.developerBranch` (configured once via `featflow setup <name>`).
  - Task branch format: `<prefix>/<developer>-<short-kebab-title>` (e.g., `feat/alice-oauth-pkce`). Never use `<developer>/...` because Git cannot store both `<developer>` and `<developer>/...` refs simultaneously.
  - Finish: `featflow finish <branch>` merges into the personal developer branch, pushes it (unless `--no-push`), and removes the clean worktree and local task branch. Open `<developer> -> dev` or `dev -> main` PRs only when the user explicitly requests team integration or release promotion.

## Branch Prefix Policy

Select the prefix based on the primary user need after read-only discovery:

- User explicitly specified a branch name or prefix: use it unless it violates branch safety rules.
- Bug fixes, regressions, broken behavior: `fix/`
- New capabilities or substantial enhancements: `feat/`
- Documentation-only changes: `docs/`
- Test-only additions or hardening: `test/`
- Behavior-preserving restructuring: `refactor/`
- Maintenance, dependencies, tooling, config, workflow updates: `chore/`
- Performance improvements: `perf/`
- Security hardening or vulnerability fixes: `security/`

## Program Workflow (Multi-Phase Initiatives)

Use a program record (`features/programs/YYYY-MM-DD-short-kebab-program.md` from `features/_program_template.md`) **only** when work naturally spans multiple feature records, branches, pull requests, repositories, or releases. Do not create a program record for normal single-branch features.

- A program record is the cross-phase roadmap, phase index, decision log, risk register, and resume point.
- A program record alone does **not** authorize coding. Each implementation phase still requires its own feature record, typed branch/worktree, approved `Plan Details`, verification, and cleanup.
- Before starting or resuming a phase, read the program record and the latest linked phase feature record.
- Update the program's phase index and `Resume Notes` whenever a phase starts, blocks, pauses, reaches review, or completes.

## Start A Feature

1. **Check Git state**: inspect `git status --short` and current branch. Never discard or relocate unrelated uncommitted changes without asking.
2. **Read-only discovery**: inspect the relevant files, architecture boundaries, contracts, and closest existing tests.
3. **Present plan & wait for approval**: share the concrete plan in conversation — intended change, affected files/surfaces, technical approach, verification plan, risks, and open questions. Stop and wait unless the user already gave explicit approval or opted out.
4. **Verify workflow setup**:
   - In `developer-branch` mode, verify the configured developer branch (`featflow status`). If unset, stop and ask the user to run `featflow setup <your-branch>`.
5. **Choose feature ID & branch**:
   - Feature ID: `YYYY-MM-DD-HHMM-short-kebab-title` (local 24-hour time).
   - Typed branch according to Branch Modes & Branch Prefix Policy.
6. **Create dedicated worktree**:
   - Check `git worktree list --porcelain` to avoid collisions.
   - Run `featflow worktree <branch> ../<repo>-worktrees/<feature-id>` (or `git worktree add -b <branch> ...` if CLI is not installed).
   - If the task is a tiny tracked doc/config change and using a worktree adds unnecessary friction, record the no-worktree exception in `Branch Plan`.
7. **Draft the canonical feature record inside the task worktree**:
   - Prefer `featflow new <short-kebab-title>` (automatically resolves `owner` from `git config user.name`, local ISO 8601 timestamp, branch, and built-in or repo template).
   - If the repository does not track `features/` in Git (zero-footprint / external OSS repo), use `featflow new <short-kebab-title> --local` to store the record under `.featflow/features/active/` (excluded via `.git/info/exclude` with zero `git status` noise).
   - If the CLI is unavailable, copy `features/_template.md` into `features/active/<feature-id>.md` and resolve `owner` via `git config --get user.name` (fallback: `Unknown`).
   - Fill every `Feature Brief` and `Plan Details` subsection concretely, including `Pre-Implementation Approval`. Use `None - <reason>` for non-applicable subsections and `Unknown - <discovery plan>` for non-blocking unknowns.
   - Run `featflow plan-check` to confirm completeness.
8. **Implement inside the task worktree**.

## Execute A Feature

- Keep edits, tests, and commits inside the task worktree.
- Update `Implementation Plan` checkboxes, `Execution Log`, `Decisions`, and `Changed Files` at meaningful milestones.
- Run focused tests while iterating; run broader verification gates before completion.
- For bug fixes or regressions, include a durable regression test or executable guard unless clearly impractical (and document why).
- If interrupted or resumed in a new session, locate the worktree via `git worktree list --porcelain` and read its active feature record before making edits.

## Pause Or Block

- Use `blocked` when external input or state is required.
- Use `paused` when intentionally parking work: set `status: paused`, update `Handoff` with exact resume instructions, and move the record from `features/active/` to `features/paused/`.
- Keep the worktree intact unless the user explicitly asks to remove it. Never remove a dirty worktree without explicit consent.

## Complete A Feature

1. Run required verification checks in the task worktree.
2. Update `Verification` (commands run, skipped checks with reasons), `Changed Files`, and `Handoff` (residual risks and follow-ups).
3. Set `status: done`, refresh `updated`, and move the record from `features/active/` to `features/done/`.
4. If linked to a program, update the program's phase index row to `done` and refresh `Resume Notes`.
5. If the repository tracks `features/current-feature.md`, clear `active_feature:`, set `status: none`, and update `last_completed`.
6. Commit all changes (including the `done` record) on the task branch with a focused Conventional Commit message.
7. Run `featflow finish <branch>` (or pass `--no-push` for local-only, or `--pr` if opening a pull request):
   - In merge workflows (`developer-branch` or `trunk` with `finishTarget: "merge"`), this merges the verified branch into the target base, pushes if configured, and cleans up the clean worktree and local task branch.
   - In PR workflows (`--pr` or `finishTarget: "pr"`), open the pull request as requested, and after merge run `featflow pr-cleanup <pr-number>` from the main checkout to sync the base branch and clean up the worktree and branch.

## Lightweight Changes (No Feature Record Required)

Tiny one-off edits (typo fixes, narrow config tweaks, small doc updates) do not need a `features/` record unless requested. They still follow:
1. Read-only discovery + concise pre-implementation plan + explicit approval.
2. Dedicated typed-branch worktree (no direct edits on protected branches).
3. Focused verification, commit, and `featflow finish <branch>`.
