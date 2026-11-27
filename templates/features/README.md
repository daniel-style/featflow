# Feature Records

This directory tracks substantial project-level engineering work from discovery and planning through execution, verification, and handoff.

## Structure

```text
features/
  README.md
  _template.md
  _program_template.md
  active/       # Features currently being implemented
  done/         # Completed feature records
  paused/       # Parked work ready to resume later
  programs/     # Multi-phase roadmaps linking multiple feature records
```

> **Note on `current-feature.md`:** By default, `features/current-feature.md` is ignored by Git to avoid merge conflicts across parallel worktrees and developers. `features/active/` is the canonical active list, and `featflow status` summarizes all active and paused records automatically.

## Workflow Summary

1. **Discover** (read-only) relevant files, contracts, and tests.
2. **Plan & Get Approval** before creating an implementation worktree or editing tracked files.
3. **Isolate** work in a typed-branch worktree: `featflow worktree <prefix>/<task-name>`.
4. **Document** the concrete `Feature Brief` and `Plan Details` in `features/active/YYYY-MM-DD-HHMM-short-kebab-title.md` (drafted and maintained by the AI, verified with `featflow plan-check`).
5. **Implement & Verify**, updating `Execution Log`, `Decisions`, `Changed Files`, and `Verification`.
6. **Complete**: move the record to `features/done/`, commit on the task branch, and run `featflow finish <branch>`.

## Branch Prefixes

- `feat/` — new user-facing capability or substantial enhancement
- `fix/` — bug fix, regression, or incident repair
- `chore/` — tooling, dependencies, config, or workflow maintenance
- `docs/` — documentation-only change
- `test/` — test-only additions or hardening
- `refactor/` — behavior-preserving restructuring
- `perf/` — performance improvement
- `security/` — security hardening or vulnerability fix

## Status Values

- `planned` — scoped, awaiting implementation
- `in_progress` — actively being implemented
- `review` — ready for or awaiting pull request review
- `blocked` — waiting on user decision or external dependency
- `paused` — intentionally parked for later resumption
- `done` — verified, merged/handed off, and archived in `features/done/`
- `cancelled` — stopped without completion

## Naming Convention

Use local 24-hour time in `YYYY-MM-DD-HHMM-short-kebab-title.md` so multiple same-day features never collide:

```text
features/active/2026-06-15-1430-oauth-pkce-login.md
```
