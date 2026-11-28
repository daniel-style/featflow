import { createPromptReader } from "./commands/setup.mjs";

export function isRawTtySupported() {
  return Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      typeof process.stdin.setRawMode === "function" &&
      process.env.FEATFLOW_FORCE_TTY !== "1",
  );
}

export function createSmartPrompter() {
  let rl = null;
  const rawTty = isRawTtySupported();

  function ensureRl() {
    if (!rl) {
      rl = createPromptReader();
    }
    return rl;
  }

  function releaseRl() {
    if (rl) {
      rl.close();
      rl = null;
    }
  }

  return {
    isRawTty: rawTty,
    async question(promptText) {
      return ensureRl().question(promptText);
    },
    releaseRl,
    close() {
      releaseRl();
      if (rawTty) {
        process.stdin.pause();
        if (typeof process.stdin.unref === "function") {
          process.stdin.unref();
        }
      }
    },
  };
}

function visualLineCount(lines) {
  const cols = Math.max(20, process.stdout.columns || 80);
  let total = 0;
  for (const line of lines) {
    total += Math.max(1, Math.ceil(line.length / cols));
  }
  return total;
}

function renderLines(lines, prevVisualRows) {
  if (prevVisualRows > 0) {
    process.stdout.write(`\x1b[${prevVisualRows}A\x1b[0J`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return visualLineCount(lines);
}

export function tokenizeRawKeys(text) {
  const keys = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\x1b") {
      if ((text[i + 1] === "[" || text[i + 1] === "O") && i + 2 < text.length) {
        keys.push(text.slice(i, i + 3));
        i += 2;
        continue;
      }
      keys.push("\x1b");
      continue;
    }
    keys.push(text[i]);
  }
  return keys;
}

function runRawSingleSelect(title, choices, defaultId) {
  return new Promise((resolve) => {
    const initialIdx = choices.findIndex((c) => c.id === defaultId);
    let cursor = initialIdx >= 0 ? initialIdx : 0;
    let renderedRows = 0;

    const buildLines = () => [
      `${title} (↑/↓ move, Enter confirm)`,
      ...choices.map((choice, idx) => {
        const pointer = idx === cursor ? ">" : " ";
        const radio = idx === cursor ? "(•)" : "( )";
        const detail = choice.detail ? ` — ${choice.detail}` : "";
        return ` ${pointer} ${radio} ${choice.label}${detail}`;
      }),
    ];

    const stdin = process.stdin;
    const prevRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1b[?25l");
    renderedRows = renderLines(buildLines(), 0);

    const cleanup = () => {
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(Boolean(prevRaw));
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    const onData = (chunk) => {
      let dirty = false;
      for (const key of tokenizeRawKeys(chunk.toString("utf8"))) {
        if (key === "\x03") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (key === "\r" || key === "\n") {
          cleanup();
          const chosen = choices[cursor];
          if (renderedRows > 0) {
            process.stdout.write(`\x1b[${renderedRows}A\x1b[0J`);
          }
          process.stdout.write(`${title}: ${chosen.label}\n`);
          resolve(chosen.id);
          return;
        }
        if (key === "\x1b[A" || key === "\x1bOA" || key === "k" || key === "K") {
          cursor = (cursor - 1 + choices.length) % choices.length;
          dirty = true;
        } else if (key === "\x1b[B" || key === "\x1bOB" || key === "j" || key === "J") {
          cursor = (cursor + 1) % choices.length;
          dirty = true;
        } else if (/^[1-9]$/.test(key)) {
          const idx = Number.parseInt(key, 10) - 1;
          if (idx >= 0 && idx < choices.length) {
            cursor = idx;
            dirty = true;
          }
        }
      }
      if (dirty) {
        renderedRows = renderLines(buildLines(), renderedRows);
      }
    };

    stdin.on("data", onData);
  });
}

function runRawMultiSelect(title, choices) {
  return new Promise((resolve) => {
    const selected = new Set(choices.filter((item) => item.checked).map((item) => item.id));
    let cursor = 0;
    let renderedRows = 0;

    const buildLines = () => [
      `${title} (↑/↓ move, Space toggle, a all/none, Enter confirm)`,
      ...choices.map((choice, idx) => {
        const pointer = idx === cursor ? ">" : " ";
        const box = selected.has(choice.id) ? "[x]" : "[ ]";
        const detail = choice.detail ? ` — ${choice.detail}` : "";
        return ` ${pointer} ${box} ${choice.label}${detail}`;
      }),
    ];

    const stdin = process.stdin;
    const prevRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1b[?25l");
    renderedRows = renderLines(buildLines(), 0);

    const cleanup = () => {
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(Boolean(prevRaw));
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    const toggleId = (id) => {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    };

    const onData = (chunk) => {
      let dirty = false;
      for (const key of tokenizeRawKeys(chunk.toString("utf8"))) {
        if (key === "\x03") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (key === "\r" || key === "\n") {
          cleanup();
          const chosenIds = choices.filter((c) => selected.has(c.id)).map((c) => c.id);
          const chosenLabels = choices.filter((c) => selected.has(c.id)).map((c) => c.label);
          if (renderedRows > 0) {
            process.stdout.write(`\x1b[${renderedRows}A\x1b[0J`);
          }
          process.stdout.write(`${title}: ${chosenLabels.length > 0 ? chosenLabels.join(", ") : "(none)"}\n`);
          resolve(chosenIds);
          return;
        }
        if (key === "\x1b[A" || key === "\x1bOA" || key === "k" || key === "K") {
          cursor = (cursor - 1 + choices.length) % choices.length;
          dirty = true;
        } else if (key === "\x1b[B" || key === "\x1bOB" || key === "j" || key === "J") {
          cursor = (cursor + 1) % choices.length;
          dirty = true;
        } else if (key === " ") {
          toggleId(choices[cursor].id);
          dirty = true;
        } else if (/^[1-9]$/.test(key)) {
          const idx = Number.parseInt(key, 10) - 1;
          if (idx >= 0 && idx < choices.length) {
            cursor = idx;
            toggleId(choices[idx].id);
            dirty = true;
          }
        } else if (key === "a" || key === "A") {
          if (selected.size === choices.length) {
            selected.clear();
          } else {
            for (const choice of choices) selected.add(choice.id);
          }
          dirty = true;
        }
      }
      if (dirty) {
        renderedRows = renderLines(buildLines(), renderedRows);
      }
    };

    stdin.on("data", onData);
  });
}

export function parseSingleSelectInput(answer, choices, defaultId) {
  const fallback = defaultId ?? choices[0]?.id ?? "";
  const trimmed = String(answer ?? "").trim().toLowerCase();
  if (!trimmed) {
    return fallback;
  }

  const num = Number.parseInt(trimmed, 10);
  if (Number.isInteger(num) && String(num) === trimmed && num >= 1 && num <= choices.length) {
    return choices[num - 1].id;
  }

  for (const choice of choices) {
    if (choice.id.toLowerCase() === trimmed) {
      return choice.id;
    }
    if (Array.isArray(choice.aliases) && choice.aliases.some((alias) => alias.toLowerCase() === trimmed)) {
      return choice.id;
    }
  }
  return fallback;
}

export async function promptSingleSelect(prompter, { title, choices, defaultId }) {
  if (!Array.isArray(choices) || choices.length === 0) {
    return defaultId ?? "";
  }
  const resolvedDefault = choices.some((c) => c.id === defaultId) ? defaultId : choices[0].id;

  if (prompter?.isRawTty) {
    prompter.releaseRl();
    return runRawSingleSelect(title, choices, resolvedDefault);
  }

  console.log(`${title}:`);
  choices.forEach((choice, idx) => {
    const marker = choice.id === resolvedDefault ? "(•)" : "( )";
    const detail = choice.detail ? ` — ${choice.detail}` : "";
    console.log(`  ${idx + 1}. ${marker} ${choice.label}${detail}`);
  });
  const answer = await prompter.question(`Choose [1-${choices.length}] (Enter for ${resolvedDefault}): `);
  return parseSingleSelectInput(answer, choices, resolvedDefault);
}

export function parseMultiSelectInput(answer, choices) {
  const trimmed = String(answer ?? "").trim().toLowerCase();
  if (!trimmed) {
    return choices.filter((c) => c.checked).map((c) => c.id);
  }
  if (trimmed === "all" || trimmed === "*") {
    return choices.map((c) => c.id);
  }
  if (trimmed === "none" || trimmed === "0" || trimmed === "n") {
    return [];
  }

  const picked = new Set();
  const byId = new Map(choices.map((c) => [c.id.toLowerCase(), c.id]));
  for (const token of trimmed.split(/[,\s]+/).filter(Boolean)) {
    const num = Number.parseInt(token, 10);
    if (Number.isInteger(num) && String(num) === token && num >= 1 && num <= choices.length) {
      picked.add(choices[num - 1].id);
      continue;
    }
    if (byId.has(token)) {
      picked.add(byId.get(token));
    }
  }
  return choices.filter((c) => picked.has(c.id)).map((c) => c.id);
}

export async function promptMultiSelect(prompter, { title, choices }) {
  if (!Array.isArray(choices) || choices.length === 0) {
    return [];
  }

  if (prompter?.isRawTty) {
    prompter.releaseRl();
    return runRawMultiSelect(title, choices);
  }

  console.log(`${title}:`);
  choices.forEach((choice, idx) => {
    const box = choice.checked ? "[x]" : "[ ]";
    const detail = choice.detail ? ` — ${choice.detail}` : "";
    console.log(`  ${idx + 1}. ${box} ${choice.label}${detail}`);
  });
  const answer = await prompter.question(
    'Select numbers (e.g. 1,3), "all", "none", or Enter to keep defaults: ',
  );
  return parseMultiSelectInput(answer, choices);
}
