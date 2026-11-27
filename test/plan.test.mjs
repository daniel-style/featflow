import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../src/config.mjs";
import { validateActiveFeaturePlan, validateFeaturePlanContent } from "../src/plan.mjs";

const COMPLETE_PLAN = `---
id: 2026-06-15-1430-date-formatter
title: ISO Date Formatter
status: in_progress
surfaces: [core]
branch: feat/date-formatter
created: 2026-06-15T14:30:00Z
updated: 2026-06-15T14:35:00Z
owner: Alice
---

# Feature Brief

## Intent

Normalize timestamp formatting across exports using \`YYYY-MM-DD\` inside code examples.

## Scope

- Add formatter helper in \`src/date.mjs\`.

## Non-goals

- None - focused helper change.

# Plan Details

## Branch Plan

- Workflow mode: trunk
- Base branch: main
- Tracked branch: feat/date-formatter

## Pre-Implementation Approval

- Approval status: approved
- Approval source: User replied "approved, go ahead".
- Approved constraints: Keep zero runtime dependencies.

## Requirements

- Format dates in \`YYYY-MM-DDTHH:MM:SSZ\` format.
- Example block should not trigger placeholder detection:

\`\`\`text
Replace with anything inside a code fence: YYYY-MM-DD-HHMM-short-kebab-title
\`\`\`

## Acceptance Criteria

- Unit tests verify UTC and offset formatting.

## Technical Approach

- Implement pure Intl/Date helper in \`src/date.mjs\`.

## Implementation Plan

- [x] Discovery complete
- [ ] Add formatter and unit tests

## Affected Files / Modules

- \`src/date.mjs\`

## Data / API / Contract Changes

- None - internal utility only.

## UX / Behavior Changes

- None - internal utility only.

## Test Plan

- [ ] Run \`npm test\`.

## Risks

- Timezone edge cases near midnight.

## Open Questions

- None.
`;

describe("feature plan validator", () => {
  it("rejects the raw template file", () => {
    const rawTemplate = readFileSync(path.join(packageRoot, "templates", "features", "_template.md"), "utf8");
    const result = validateFeaturePlanContent(rawTemplate);
    assert.equal(result.ok, false);
    assert.equal(result.approvalPending, true);
    assert.ok(result.placeholders.length > 0);
  });

  it("accepts a complete approved plan even when code spans/fences mention date format strings", () => {
    const result = validateFeaturePlanContent(COMPLETE_PLAN);
    assert.equal(result.ok, true, `Unexpected errors: ${result.errors.join("; ")}`);
    assert.equal(result.approvalPending, false);
    assert.deepEqual(result.missingHeadings, []);
    assert.deepEqual(result.placeholders, []);
  });

  it("rejects a plan whose Pre-Implementation Approval is still pending", () => {
    const pendingPlan = COMPLETE_PLAN.replace("Approval status: approved", "Approval status: pending");
    const result = validateFeaturePlanContent(pendingPlan);
    assert.equal(result.ok, false);
    assert.equal(result.approvalPending, true);

    const allowed = validateFeaturePlanContent(pendingPlan, { requireApproved: false });
    assert.equal(allowed.ok, true);
  });

  it("resolves active feature record from features/active when current-feature.md is absent", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "featflow-plan-"));
    try {
      mkdirSync(path.join(repo, "features", "active"), { recursive: true });
      writeFileSync(path.join(repo, "features", "active", "2026-06-15-1430-date-formatter.md"), COMPLETE_PLAN);

      const res = validateActiveFeaturePlan(repo);
      assert.equal(res.ok, true);
      assert.equal(res.skipped, false);
      assert.equal(res.activeFeature, path.join("features", "active", "2026-06-15-1430-date-formatter.md"));
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });
});
