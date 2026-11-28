import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { packageRoot } from "./config.mjs";
import { samePath } from "./git.mjs";

export const AGENT_BLOCK_START = "<!-- FEATFLOW_START -->";
export const AGENT_BLOCK_END = "<!-- FEATFLOW_END -->";
export const DEFAULT_AGENT_DOC_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];

function normalizeLineEndings(content) {
  return content.replace(/\r\n/g, "\n");
}

function toPosixRel(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

export function renderAgentWorkflowBlock() {
  const snippetPath = path.join(packageRoot, "templates", "snippets", "AGENTS-workflow.md");
  const snippet = normalizeLineEndings(readFileSync(snippetPath, "utf8")).trim();
  return `${AGENT_BLOCK_START}\n${snippet}\n${AGENT_BLOCK_END}`;
}

export function resolveAgentDocTargets(repoRoot, explicitTargets = null) {
  if (Array.isArray(explicitTargets) && explicitTargets.length > 0) {
    const resolved = [];
    for (const raw of explicitTargets) {
      const trimmed = String(raw).trim();
      if (!trimmed) {
        continue;
      }
      const abs = path.resolve(repoRoot, trimmed);
      if (!resolved.some((existing) => samePath(existing, abs))) {
        resolved.push(abs);
      }
    }
    return resolved.map((abs) => toPosixRel(repoRoot, abs));
  }

  const agentsPath = path.join(repoRoot, "AGENTS.md");
  const claudePath = path.join(repoRoot, "CLAUDE.md");
  const hasAgents = existsSync(agentsPath);
  const hasClaude = existsSync(claudePath);

  if (!hasClaude) {
    return ["AGENTS.md"];
  }

  if (hasAgents && samePath(agentsPath, claudePath)) {
    return ["AGENTS.md"];
  }

  const claudeContent = readFileSync(claudePath, "utf8");
  if (/^\s*@AGENTS\.md\b/m.test(claudeContent)) {
    return ["AGENTS.md"];
  }

  return ["AGENTS.md", "CLAUDE.md"];
}

export function findManagedAgentDocs(repoRoot) {
  const found = [];
  for (const rel of DEFAULT_AGENT_DOC_CANDIDATES) {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) {
      continue;
    }
    if (found.some((existing) => samePath(existing, abs))) {
      continue;
    }
    const content = readFileSync(abs, "utf8");
    if (content.includes(AGENT_BLOCK_START)) {
      found.push(abs);
    }
  }
  return found.map((abs) => toPosixRel(repoRoot, abs));
}

export function inspectAgentDocBlock(filePath, renderedBlock = renderAgentWorkflowBlock()) {
  if (!existsSync(filePath)) {
    return { status: "missing-file" };
  }

  const existing = normalizeLineEndings(readFileSync(filePath, "utf8"));
  const startIdx = existing.indexOf(AGENT_BLOCK_START);
  const endIdx = existing.indexOf(AGENT_BLOCK_END);

  if (startIdx === -1 && endIdx === -1) {
    return { status: "missing-block" };
  }
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { status: "drifted", reason: "malformed featflow markers" };
  }

  const actual = existing.slice(startIdx, endIdx + AGENT_BLOCK_END.length);
  if (actual === normalizeLineEndings(renderedBlock)) {
    return { status: "up-to-date" };
  }
  return { status: "drifted" };
}

export function upsertAgentDocBlock(filePath, renderedBlock = renderAgentWorkflowBlock(), options = {}) {
  const dryRun = Boolean(options.dryRun);
  const normalizedBlock = normalizeLineEndings(renderedBlock);

  if (!existsSync(filePath)) {
    if (!dryRun) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${normalizedBlock}\n`, "utf8");
    }
    return { action: "created", filePath };
  }

  const rawExisting = readFileSync(filePath, "utf8");
  const existing = normalizeLineEndings(rawExisting);
  const startIdx = existing.indexOf(AGENT_BLOCK_START);
  const endIdx = existing.indexOf(AGENT_BLOCK_END);

  if ((startIdx !== -1 && endIdx === -1) || (startIdx === -1 && endIdx !== -1) || (startIdx !== -1 && endIdx < startIdx)) {
    throw new Error(
      `Malformed featflow markers in ${filePath}. Ensure both ${AGENT_BLOCK_START} and ${AGENT_BLOCK_END} exist in order.`,
    );
  }

  let next;
  if (startIdx !== -1 && endIdx !== -1) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + AGENT_BLOCK_END.length);
    next = `${before}${normalizedBlock}${after}`;
    if (next === existing) {
      return { action: "unchanged", filePath };
    }
  } else {
    const trimmed = existing.replace(/\s+$/, "");
    next = trimmed.length > 0 ? `${trimmed}\n\n${normalizedBlock}\n` : `${normalizedBlock}\n`;
  }

  if (!dryRun) {
    writeFileSync(filePath, next, "utf8");
  }
  return { action: "updated", filePath };
}
