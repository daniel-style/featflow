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
    },
  };
}

function renderRawList(title, choices, cursor, selected, renderedLines) {
  if (renderedLines > 0) {
    process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
  }
  const lines = [
    `${title} (↑/↓ move, Space toggle, a all/none, Enter confirm)`,
    ...choices.map((choice, idx) => {
      const pointer = idx === cursor ? ">" : " ";
      const box = selected.has(choice.id) ? "[x]" : "[ ]";
      const detail = choice.detail ? ` — ${choice.detail}` : "";
      return ` ${pointer} ${box} ${choice.label}${detail}`;
    }),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return lines.length;
}

function runRawMultiSelect(title, choices) {
  return new Promise((resolve) => {
    const selected = new Set(choices.filter((item) => item.checked).map((item) => item.id));
    let cursor = 0;
    let renderedLines = 0;

    const stdin = process.stdin;
    const prevRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write("\x1b[?25l");
    renderedLines = renderRawList(title, choices, cursor, selected, 0);

    const cleanup = () => {
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(Boolean(prevRaw));
      }
      stdin.pause();
      process.stdout.write("\x1b[?25h");
    };

    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (text === "\x03") {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
      if (text === "\r" || text === "\n") {
        cleanup();
        const chosenIds = choices.filter((c) => selected.has(c.id)).map((c) => c.id);
        const chosenLabels = choices.filter((c) => selected.has(c.id)).map((c) => c.label);
        if (renderedLines > 0) {
          process.stdout.write(`\x1b[${renderedLines}A\x1b[0J`);
        }
        process.stdout.write(`${title}: ${chosenLabels.length > 0 ? chosenLabels.join(", ") : "(none)"}\n`);
        resolve(chosenIds);
        return;
      }
      if (text === "\x1b[A" || text === "k" || text === "K") {
        cursor = (cursor - 1 + choices.length) % choices.length;
      } else if (text === "\x1b[B" || text === "j" || text === "J") {
        cursor = (cursor + 1) % choices.length;
      } else if (text === " ") {
        const id = choices[cursor].id;
        if (selected.has(id)) {
          selected.delete(id);
        } else {
          selected.add(id);
        }
      } else if (text === "a" || text === "A") {
        if (selected.size === choices.length) {
          selected.clear();
        } else {
          for (const choice of choices) {
            selected.add(choice.id);
          }
        }
      }
      renderedLines = renderRawList(title, choices, cursor, selected, renderedLines);
    };

    stdin.on("data", onData);
  });
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
