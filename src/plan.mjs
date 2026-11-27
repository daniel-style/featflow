import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const REQUIRED_PLAN_HEADINGS = [
  "## Branch Plan",
  "## Pre-Implementation Approval",
  "## Requirements",
  "## Acceptance Criteria",
  "## Technical Approach",
  "## Implementation Plan",
  "## Affected Files / Modules",
  "## Test Plan",
  "## Risks",
  "## Open Questions",
];

const PLACEHOLDER_PATTERNS = [
  { label: "template placeholder (`Replace with ...`)", regex: /\bReplace with\b/ },
  { label: "template placeholder (`AI-drafted...`)", regex: /\bAI-drafted\b/ },
  { label: "template path placeholder (`path/to/expected...`)", regex: /path\/to\/expected/ },
  { label: "unresolved owner placeholder (`GIT_USER_NAME`)", regex: /\bGIT_USER_NAME\b/ },
  { label: "unresolved feature id placeholder", regex: /YYYY-MM-DD-HHMM-short-kebab-title/ },
  { label: "unresolved timestamp placeholder", regex: /YYYY-MM-DDTHH:MM:SS/ },
  { label: "unresolved template title (`Short Feature Title`)", regex: /^title:\s*Short Feature Title\s*$/m },
  {
    label: "unresolved approval enum (`pending | approved | skipped-by-user`)",
    regex: /pending\s*\|\s*approved\s*\|\s*skipped-by-user/,
  },
];

/**
 * Strip fenced code blocks and inline code spans so literal examples in
 * documentation or date-formatting specs do not cause false positives.
 */
export function stripCodeSpans(markdown) {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
  return withoutFences.replace(/`[^`\n]+`/g, "");
}

export function extractFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return {};
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) {
      fields[key] = value;
    }
  }
  return fields;
}

export function extractSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startMatch = markdown.match(new RegExp(`^${escaped}\\s*$`, "m"));
  if (!startMatch || startMatch.index === undefined) {
    return "";
  }
  const rest = markdown.slice(startMatch.index + startMatch[0].length);
  const nextHeading = rest.match(/^#{1,2}\s+/m);
  return (nextHeading && nextHeading.index !== undefined ? rest.slice(0, nextHeading.index) : rest).trim();
}

export function listFeatureFiles(repoRoot, featuresDir = "features", subdir = "active") {
  const dir = path.resolve(repoRoot, featuresDir, subdir);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
    .sort()
    .map((name) => path.join(featuresDir, subdir, name));
}

export function resolveActiveFeaturePath(repoRoot, featuresDir = "features") {
  const pointerPath = path.resolve(repoRoot, featuresDir, "current-feature.md");
  if (existsSync(pointerPath)) {
    const pointer = readFileSync(pointerPath, "utf8");
    const match = pointer.match(/^active_feature:[ \t]*([^\r\n]*)$/m);
    const rawValue = match ? match[1].trim() : "";
    if (rawValue) {
      return rawValue.startsWith(`${featuresDir}/`) ? rawValue : `${featuresDir}/${rawValue}`;
    }
  }

  const activeFiles = listFeatureFiles(repoRoot, featuresDir, "active");
  if (activeFiles.length === 1) {
    return activeFiles[0];
  }
  return null;
}

export function validateFeaturePlanContent(markdown, options = {}) {
  const requireApproved = options.requireApproved ?? true;
  const frontmatter = extractFrontmatter(markdown);
  const prose = stripCodeSpans(markdown);

  const missingHeadings = REQUIRED_PLAN_HEADINGS.filter((heading) => !markdown.includes(heading));

  const placeholders = [];
  for (const rule of PLACEHOLDER_PATTERNS) {
    if (rule.regex.test(prose)) {
      placeholders.push(rule.label);
    }
  }
  if (frontmatter.owner === "GIT_USER_NAME" || frontmatter.owner === "") {
    placeholders.push("frontmatter `owner` is unresolved");
  }
  if (frontmatter.id && frontmatter.id.includes("YYYY-MM-DD")) {
    placeholders.push("frontmatter `id` is unresolved");
  }

  let approvalPending = false;
  if (requireApproved) {
    const approvalSection = extractSection(markdown, "## Pre-Implementation Approval");
    const statusMatch = approvalSection.match(/Approval status:\s*`?([a-z-]+)`?/i);
    const status = statusMatch ? statusMatch[1].trim().toLowerCase() : "";
    if (!status || status === "pending") {
      approvalPending = true;
    }
  }

  const emptySections = [];
  for (const heading of REQUIRED_PLAN_HEADINGS) {
    if (missingHeadings.includes(heading)) {
      continue;
    }
    const body = extractSection(markdown, heading);
    if (!body) {
      emptySections.push(heading);
    }
  }

  const errors = [];
  if (missingHeadings.length > 0) {
    errors.push(`Missing required Plan Details headings: ${missingHeadings.join(", ")}`);
  }
  if (emptySections.length > 0) {
    errors.push(`Empty Plan Details sections: ${emptySections.join(", ")}`);
  }
  if (placeholders.length > 0) {
    errors.push(`Unresolved template placeholders: ${[...new Set(placeholders)].join("; ")}`);
  }
  if (approvalPending) {
    errors.push("Pre-Implementation Approval status must be `approved` or `skipped-by-user` before implementation.");
  }

  return {
    ok: errors.length === 0,
    frontmatter,
    missingHeadings,
    emptySections,
    placeholders: [...new Set(placeholders)],
    approvalPending,
    errors,
  };
}

export function validateActiveFeaturePlan(repoRoot, options = {}) {
  const featuresDir = options.featuresDir ?? "features";
  const targetRelPath = options.filePath ?? resolveActiveFeaturePath(repoRoot, featuresDir);

  if (!targetRelPath) {
    return {
      ok: true,
      skipped: true,
      reason: "No active feature record found (lightweight change or idle checkout).",
      activeFeature: null,
      errors: [],
    };
  }

  const absPath = path.resolve(repoRoot, targetRelPath);
  if (!existsSync(absPath)) {
    return {
      ok: false,
      skipped: false,
      activeFeature: targetRelPath,
      errors: [`Active feature record does not exist: ${targetRelPath}`],
    };
  }

  const content = readFileSync(absPath, "utf8");
  const result = validateFeaturePlanContent(content, options);
  return {
    ...result,
    skipped: false,
    activeFeature: targetRelPath,
  };
}
