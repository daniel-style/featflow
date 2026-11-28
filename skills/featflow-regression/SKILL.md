---
name: featflow-regression
description: Optional Regression Guardian workflow built on featflow (`featflow regression`). Use whenever fixing a bug, regression, failing test, or GitHub Issue bug in a repository with a regression memory ledger so fixes become durable executable guards and future edits check impacted invariants before changing files.
---

# Regression Guardian Workflow (`featflow-regression`)

Turn hard-won bug fixes into durable, discoverable executable guards backed by a repository regression ledger (configured via `regression.ledgerFile` in `.featflow.json`, e.g., `context/regression-ledger.yml`).

## Principles

- **Prefer executable guards over memory**: if a bug matters enough to fix, convert it into the smallest reliable runnable check (unit test, integration test, E2E spec, fixture, or static rule).
- **Store the invariant, not only the test command**: future agents need to understand *what must stay true* before modifying related files.
- **Honor the Universal Pre-Implementation Gate**: inspect impacted ledger entries read-only, present root cause + repair plan + regression guard + verification commands, and wait for explicit user approval before editing files.

## Operating Loop

### 1. Check Impacted Regressions During Discovery

Before editing files (or after drafting a candidate file list), run:

```bash
featflow regression impact --files path/to/file1 path/to/file2 --json
# Or check all files already changed on the current task branch:
featflow regression impact --json
```

Read the `invariant`, `guards`, and `ownerNotes` for every impacted entry so your change does not reintroduce a previously solved bug.

### 2. Record New or Updated Bug Fixes in the Ledger

When fixing a bug or regression, add or update an entry in `regression.ledgerFile`:

```yaml
- id: short-stable-slug
  title: Concise statement of the invariant
  status: guarded
  surfaces: [core]
  symptom: Observed failure mode.
  root_cause: Why it occurred.
  invariant: What must remain true across future edits.
  files:
    - src/path/to/affected-file.ts
  guards:
    - tests/path/to/regression.test.ts
  commands:
    - npm test -- tests/path/to/regression.test.ts
  owner_notes: Brief context for future maintainers.
```

Allowed `status` values:
- `guarded`: executable guard exists and passes
- `needs_guard`: known risk without an automated guard yet (justify why)
- `retired`: code path removed or invariant superseded

### 3. Validate Ledger & Run Impacted Guards Before Finish

```bash
featflow regression validate
featflow regression check   # shorthand for: featflow regression impact --run
```

Include impacted regression IDs and executed guard commands in your feature record `Verification` section or final handoff.
