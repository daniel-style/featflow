---
id: YYYY-MM-DD-HHMM-short-kebab-title
title: Short Feature Title
status: planned
surfaces: []
branch: prefix/short-kebab-title
created: YYYY-MM-DDTHH:MM:SSZ
updated: YYYY-MM-DDTHH:MM:SSZ
owner: GIT_USER_NAME
---

# Feature Brief

## Intent

Replace with the problem this feature solves and the outcome users or maintainers should observe.

## Scope

- Replace with what will change.
- Which surfaces/modules are affected.
- What must be true before handoff.

## Non-goals

- Replace with what is intentionally out of scope.

# Plan Details

Replace every placeholder below before editing product code. Never leave empty headings or generic placeholder text in an active feature record. If a section does not apply, write `None - <reason>`. If a detail is unknown but non-blocking, write `Unknown - <how it will be discovered>` and track it in `Open Questions`.

## Branch Plan

- Workflow mode: `trunk | developer-branch`
- Base branch: Replace with configured base or developer branch
- Work type: `feature | fix | chore | docs | test | refactor | perf | security`
- Selected prefix: `prefix/`
- Tracked branch: `prefix/short-kebab-title`
- Worktree path: Replace with worktree path or explicit no-worktree exception
- Completion strategy: Replace with `featflow finish <branch>` (merge or PR + `featflow pr-cleanup`)

## Pre-Implementation Approval

- Approval status: `pending | approved | skipped-by-user`
- Approval source: Replace with the user message or explicit skip-confirmation instruction.
- Approved constraints: Replace with scope, behavior, verification, or non-goal constraints confirmed by the user.
- If implementation uncovers a materially different root cause, scope, security boundary, or risk profile, pause and request approval for an updated plan.

## Requirements

- Replace with user needs and functional requirements.
- Include compatibility, security, and edge-case constraints.

## Acceptance Criteria

- Replace with observable conditions that define done.

## Technical Approach

- Replace with implementation strategy grounded in inspected repository files.
- Call out architecture boundaries, existing patterns, and key tradeoffs.

## Implementation Plan

- [ ] Complete read-only discovery and present a concrete plan to the user.
- [ ] Record explicit user approval (or skip-confirmation instruction).
- [ ] Create or switch to the typed task branch worktree.
- [ ] Replace with concrete implementation step(s).
- [ ] Replace with concrete verification step(s).
- [ ] Update `Verification`, `Changed Files`, and `Handoff`, then move this record to `features/done/`.
- [ ] Commit all changes on the task branch and run `featflow finish <tracked-branch>`.

## Affected Files / Modules

- Replace with inspected files, packages, APIs, components, or docs expected to change.

## Data / API / Contract Changes

- Note schema, migration, API, CLI, event, or config contract changes.
- Write `None - <reason>` if no contracts change.

## UX / Behavior Changes

- Describe user-visible or operational behavior changes.
- Write `None - <reason>` if none apply.

## Test Plan

- [ ] Focused unit/integration tests for touched behavior.
- [ ] Regression test or guard (required for bug fixes unless documented why impractical).
- [ ] Repository lint / typecheck / build checks as appropriate.

## Risks

- Replace with implementation risks, potential regressions, migration hazards, or ambiguities.

## Open Questions

- Replace with unresolved questions, or write `None`.

# Execution Log

- YYYY-MM-DD HH:MM: Started planning.

# Decisions

- Decision: Explain key tradeoffs, contracts, or architecture choices.

# Changed Files

- `path/to/file`

# Verification

- [ ] Command or manual check run.
- [ ] Skipped check with reason.

# Handoff

Summarize completion state, skipped checks, residual risks, and useful follow-up context.
