## Development Workflow (featflow)

### Universal Pre-Implementation Gate

- For any write-oriented work (`feat/`, `fix/`, `chore/`, `docs/`, `test/`, `refactor/`, `perf/`, `security/`), complete **read-only discovery** first, present a concrete implementation plan, and **wait for explicit user approval** before creating a worktree, editing tracked files, committing, pushing, or opening PRs.
- The user can opt out with explicit language (e.g., "implement directly", "no confirmation needed"); record that exception in the feature record or handoff.
- Purely read-only questions, code reviews, status checks, and plan-only requests do not require approval.
- If implementation uncovers a materially different root cause, scope, security boundary, or risk profile, pause and request approval for an updated plan before continuing.

### Branch & Worktree Isolation

- Do not edit tracked files directly on protected branches (`main`, `dev`, or your configured developer branch) unless explicitly requested.
- Check workflow status with `featflow status` (in `developer-branch` mode, run `featflow setup <branch>` once per checkout).
- Create a dedicated worktree per task with `featflow worktree <prefix>/<task-name>` and finish with `featflow finish <branch>`.

### Feature Planning Workflow

- For substantial features, cross-module changes, long-running tasks, or multi-phase initiatives, read and follow the `featflow` skill (`.agents/skills/featflow/SKILL.md` or your globally installed skill).
- Draft complete `Feature Brief` and `Plan Details` (including `Pre-Implementation Approval`) via `featflow new <short-kebab-title>` (or `featflow new <short-kebab-title> --local` when feature records are not tracked in Git) before editing product code, and verify with `featflow plan-check`.
- Move completed records to `done/` before committing and running `featflow finish <branch>`.
- Tiny one-off edits do not require a feature record, but still follow the Universal Pre-Implementation Gate and dedicated task worktree flow.
