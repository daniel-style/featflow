import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { changedFileSelection, matchesPattern, normalizeRelPath } from "./changed-files.mjs";
import { resolveRegressionConfig } from "./config.mjs";

export const VALID_REGRESSION_STATUSES = new Set(["guarded", "needs_guard", "retired", "superseded"]);
const INACTIVE_REGRESSION_STATUSES = new Set(["retired", "superseded"]);

function unquoteYamlScalar(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function parseFlowList(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) {
    return [];
  }
  const items = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === quote && inner[i - 1] !== "\\") {
        quote = "";
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      const val = unquoteYamlScalar(current);
      if (val) items.push(val);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = unquoteYamlScalar(current);
  if (tail) items.push(tail);
  return items;
}

function foldBlockLines(lines, style) {
  const isLiteral = style.startsWith("|");
  const stripTrailing = style.endsWith("-");
  if (isLiteral) {
    const joined = lines.join("\n");
    return stripTrailing ? joined.replace(/\n+$/, "") : joined;
  }
  const out = [];
  let paragraph = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (paragraph.length > 0) {
        out.push(paragraph.join(" "));
        paragraph = [];
      }
      out.push("");
    } else {
      paragraph.push(line.trim());
    }
  }
  if (paragraph.length > 0) {
    out.push(paragraph.join(" "));
  }
  const joined = out.join("\n");
  return stripTrailing ? joined.replace(/\n+$/, "") : joined.trim();
}

export function parseRegressionLedgerYaml(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  const entries = [];
  let current = null;

  const isTopEntryStart = (line) => /^- [a-zA-Z0-9_-]+:\s*/.test(line);
  const isFieldStart = (line) => /^  [a-zA-Z0-9_-]+:\s*/.test(line);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }

    let key = "";
    let rawValue = "";

    const topMatch = line.match(/^- ([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (topMatch) {
      current = {};
      entries.push(current);
      key = topMatch[1];
      rawValue = topMatch[2];
    } else {
      const fieldMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (!fieldMatch || !current) {
        i += 1;
        continue;
      }
      key = fieldMatch[1];
      rawValue = fieldMatch[2];
    }

    i += 1;
    const valTrim = rawValue.trim();

    if (/^[|>][+-]?$/.test(valTrim)) {
      const blockLines = [];
      let blockIndent = null;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() === "") {
          blockLines.push("");
          i += 1;
          continue;
        }
        const indentMatch = next.match(/^(\s+)/);
        const indent = indentMatch ? indentMatch[1].length : 0;
        if (indent < 4) {
          break;
        }
        if (blockIndent === null) {
          blockIndent = indent;
        }
        blockLines.push(next.slice(Math.min(indent, blockIndent)));
        i += 1;
      }
      current[key] = foldBlockLines(blockLines, valTrim);
      continue;
    }

    if (valTrim.startsWith("[") && valTrim.endsWith("]")) {
      current[key] = parseFlowList(valTrim);
      continue;
    }

    if (valTrim === "") {
      const listItems = [];
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim() || next.trim().startsWith("#")) {
          i += 1;
          continue;
        }
        if (isTopEntryStart(next) || isFieldStart(next)) {
          break;
        }
        const itemMatch = next.match(/^(\s+)-\s+(.*)$/);
        if (itemMatch) {
          const itemIndent = itemMatch[1].length;
          let itemText = unquoteYamlScalar(itemMatch[2]);
          i += 1;
          while (i < lines.length) {
            const cont = lines[i];
            if (!cont.trim() || isTopEntryStart(cont) || isFieldStart(cont)) break;
            const contIndent = (cont.match(/^(\s+)/)?.[1].length ?? 0);
            if (contIndent <= itemIndent || /^\s+-\s+/.test(cont)) break;
            itemText = `${itemText} ${cont.trim()}`;
            i += 1;
          }
          listItems.push(itemText);
          continue;
        }
        break;
      }
      current[key] = listItems;
      continue;
    }

    let scalar = unquoteYamlScalar(valTrim);
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim() || next.trim().startsWith("#") || isTopEntryStart(next) || isFieldStart(next)) {
        break;
      }
      const indent = next.match(/^(\s+)/)?.[1].length ?? 0;
      if (indent < 4) {
        break;
      }
      scalar = `${scalar} ${next.trim()}`;
      i += 1;
    }
    current[key] = scalar;
  }

  return entries;
}

export function loadRegressionLedger(repoRoot, config, explicitLedgerPath = "") {
  const regConfig = resolveRegressionConfig(config);
  const ledgerRel = explicitLedgerPath || regConfig.ledgerFile;
  const absPath = path.resolve(repoRoot, ledgerRel);
  if (!existsSync(absPath)) {
    throw new Error(`Regression ledger not found: ${absPath}`);
  }
  const content = readFileSync(absPath, "utf8");
  let entries;
  if (absPath.endsWith(".json") || /^\s*[[{]/.test(content)) {
    const parsed = JSON.parse(content);
    entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : null;
    if (!entries) {
      throw new Error(`Invalid JSON regression ledger at ${absPath}: expected an array or { "entries": [...] }.`);
    }
  } else {
    entries = parseRegressionLedgerYaml(content);
  }
  return { ledgerFile: normalizeRelPath(path.relative(repoRoot, absPath)), absPath, entries };
}

function isConcreteGuardFile(guardValue) {
  const trimmed = String(guardValue ?? "").trim();
  if (!trimmed || /\s/.test(trimmed) || /[*?]/.test(trimmed)) {
    return false;
  }
  return trimmed.includes("/") || /\.[a-z0-9]+$/i.test(trimmed);
}

export function validateRegressionLedger(repoRoot, config, options = {}) {
  const { ledgerFile, entries } = loadRegressionLedger(repoRoot, config, options.ledgerFile);
  const errors = [];
  const warnings = [];
  const seenIds = new Set();

  for (let idx = 0; idx < entries.length; idx += 1) {
    const entry = entries[idx];
    const label = entry?.id ? `entry "${entry.id}"` : `entry #${idx + 1}`;
    if (!entry?.id || typeof entry.id !== "string") {
      errors.push(`${label}: missing required field "id".`);
    } else if (seenIds.has(entry.id)) {
      errors.push(`${label}: duplicate regression id "${entry.id}".`);
    } else {
      seenIds.add(entry.id);
    }

    if (!entry?.title) errors.push(`${label}: missing required field "title".`);
    if (!VALID_REGRESSION_STATUSES.has(entry?.status)) {
      errors.push(`${label}: invalid status "${entry?.status}" (expected guarded | needs_guard | retired | superseded).`);
    }
    if (!entry?.invariant) errors.push(`${label}: missing required field "invariant".`);

    const files = Array.isArray(entry?.files) ? entry.files : [];
    const guards = Array.isArray(entry?.guards) ? entry.guards : [];

    if (!INACTIVE_REGRESSION_STATUSES.has(entry?.status) && files.length === 0) {
      errors.push(`${label}: active entry must list at least one path in "files".`);
    }
    if (entry?.status === "guarded") {
      if (guards.length === 0) {
        errors.push(`${label}: status is "guarded" but "guards" is empty.`);
      } else {
        for (const guard of guards) {
          if (isConcreteGuardFile(guard) && !existsSync(path.resolve(repoRoot, guard))) {
            warnings.push(`${label}: guard path not found on disk: ${guard}`);
          }
        }
      }
    }
  }

  const strictFail = Boolean(options.strict) && warnings.length > 0;
  return {
    ok: errors.length === 0 && !strictFail,
    ledgerFile,
    entryCount: entries.length,
    errors,
    warnings,
  };
}

export function analyzeRegressionImpact(repoRoot, config, options = {}) {
  const { ledgerFile, entries } = loadRegressionLedger(repoRoot, config, options.ledgerFile);
  const selection = changedFileSelection(repoRoot, config, {
    base: options.base,
    head: options.head,
    files: options.files,
  });

  const impacted = [];
  const commandSet = new Set();

  for (const entry of entries) {
    if (!entry || INACTIVE_REGRESSION_STATUSES.has(entry.status)) continue;
    const entryFiles = Array.isArray(entry.files) ? entry.files : [];
    const matchedFiles = selection.files.filter((rel) => entryFiles.some((pat) => matchesPattern(rel, pat)));
    if (matchedFiles.length === 0) continue;

    const guards = Array.isArray(entry.guards) ? entry.guards : [];
    const commands = Array.isArray(entry.commands) ? entry.commands : [];
    const missingGuards = guards.filter((g) => isConcreteGuardFile(g) && !existsSync(path.resolve(repoRoot, g)));

    for (const cmd of commands) {
      if (cmd) commandSet.add(cmd);
    }

    impacted.push({
      id: entry.id,
      title: entry.title ?? "",
      status: entry.status ?? "unknown",
      invariant: entry.invariant ?? "",
      matchedFiles,
      guards,
      missingGuards,
      commands,
      ownerNotes: entry.owner_notes ?? "",
    });
  }

  const missingGuardEntries = impacted.filter((item) => item.status === "needs_guard" || item.missingGuards.length > 0);
  return {
    ok: missingGuardEntries.length === 0,
    ledgerFile,
    entryCount: entries.length,
    selection,
    changedFiles: selection.files,
    impacted,
    uniqueCommands: [...commandSet],
    missingGuardEntries,
  };
}
