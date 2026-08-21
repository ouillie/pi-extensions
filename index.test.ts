import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { NvimEditor } from "./index.ts";

type Cursor = { line: number; col: number };
type ExpectedState = { text: string; submitted: boolean };
type EditorInternals = {
  nvim: { call(method: string, args?: unknown[]): Promise<unknown> };
  nvimQueue: Promise<void>;
  queue: Promise<void>;
  moveCursorTo(line: number, col: number): void;
};

const theme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};

const tui = {
  terminal: { columns: 80, rows: 24 },
  requestRender() {},
} as unknown as TUI;

const keybindings = {
  matches: () => false,
} as unknown as KeybindingsManager;

function internals(editor: NvimEditor): EditorInternals {
  return editor as unknown as EditorInternals;
}

async function settle(editor: NvimEditor): Promise<void> {
  const pending = internals(editor);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([pending.nvimQueue, pending.queue]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("editor did not settle (possible input/snapshot deadlock)")), 1500);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Real-Neovim test harness. Each run starts with the requested text and cursor
 * in Normal mode. Strings in one `keys` entry are sent without waiting between
 * characters, which reproduces how multi-key commands exposed the deadlock.
 * Separate entries wait for a mode transition before continuing.
 */
async function edit(
  text: string,
  cursor: Cursor,
  keys: string | string[],
): Promise<ExpectedState> {
  const editor = new NvimEditor(tui, theme, keybindings);
  let submitted = false;
  editor.onSubmit = () => { submitted = true; };

  try {
    editor.setText(text);
    await settle(editor);

    editor.handleInput("\x1b");
    await settle(editor);

    const state = internals(editor);
    await state.nvim.call("nvim_win_set_cursor", [0, [cursor.line + 1, cursor.col]]);
    state.moveCursorTo(cursor.line, cursor.col);

    for (const chunk of typeof keys === "string" ? [keys] : keys) {
      for (const key of chunk) editor.handleInput(key);
      await settle(editor);
    }

    return { text: editor.getText(), submitted };
  } finally {
    editor.dispose();
  }
}

async function expectEdit(
  text: string,
  cursor: Cursor,
  keys: string | string[],
  expected: ExpectedState,
): Promise<void> {
  assert.deepEqual(await edit(text, cursor, keys), expected);
}

const hasNvim = spawnSync("nvim", ["--version"], { stdio: "ignore" }).status === 0;
const normal = { line: 0, col: 0 };

describe("NvimEditor Normal-mode commands", { skip: !hasNvim }, () => {
  describe("counts", () => {
    for (let count = 1; count <= 9; count++) {
      it(`${count}x applies the count and completes`, async () => {
        const text = "abcdefghij";
        await expectEdit(text, normal, `${count}x`, { text: text.slice(count), submitted: false });
      });
    }

    it("0 is a complete motion rather than a count prefix", async () => {
      await expectEdit("abc", { line: 0, col: 2 }, "0x", { text: "bc", submitted: false });
    });
  });

  describe("control-key prefixes", () => {
    it("Ctrl-\\ Ctrl-N completes before the following command", async () => {
      await expectEdit("abc", normal, "\x1c\x0ex", { text: "bc", submitted: false });
    });

    it("Ctrl-W w completes in a single-window editor", async () => {
      await expectEdit("abc", normal, "\x17wx", { text: "bc", submitted: false });
    });
  });

  describe("commands that take a character argument", () => {
    it("\" selects a register", async () => {
      await expectEdit("abc", normal, "\"ax", { text: "bc", submitted: false });
    });

    it("m sets a mark and ' jumps to its line", async () => {
      await expectEdit("abc", normal, "ma$'ax", { text: "bc", submitted: false });
    });

    it("m sets a mark and ` jumps to its exact position", async () => {
      await expectEdit("abc", normal, "ma$`ax", { text: "bc", submitted: false });
    });

    it("q records a macro and @ executes it", async () => {
      await expectEdit("abc", normal, "qaxq@a", { text: "c", submitted: false });
    });

    const characterMotions = [
      { name: "f", text: "abacad", cursor: { line: 0, col: 0 }, keys: "fcx", expected: "abaad" },
      { name: "t", text: "abacad", cursor: { line: 0, col: 0 }, keys: "tcx", expected: "abcad" },
      { name: "F", text: "abacad", cursor: { line: 0, col: 5 }, keys: "Fax", expected: "abacd" },
      { name: "T", text: "abacad", cursor: { line: 0, col: 5 }, keys: "Tax", expected: "abaca" },
    ] as const;

    for (const testCase of characterMotions) {
      it(`${testCase.name} consumes its target character`, async () => {
        await expectEdit(testCase.text, testCase.cursor, testCase.keys, { text: testCase.expected, submitted: false });
      });
    }

    it("r consumes the replacement character", async () => {
      await expectEdit("abc", { line: 0, col: 1 }, "rZ", { text: "aZc", submitted: false });
    });
  });

  describe("command-family prefixes", () => {
    it("g dispatches a g command", async () => {
      await expectEdit("one\ntwo", { line: 1, col: 2 }, "ggx", { text: "on\ntwo", submitted: false });
    });

    it("[ dispatches a bracket command", async () => {
      await expectEdit("one\n\ntwo", { line: 2, col: 0 }, "[[x", { text: "ne\n\ntwo", submitted: false });
    });

    it("] dispatches a bracket command", async () => {
      await expectEdit("one\n\ntwo", normal, "]]x", { text: "one\n\nwo", submitted: false });
    });

    it("z dispatches a z command", async () => {
      await expectEdit("abc", normal, "zhx", { text: "bc", submitted: false });
    });

    it("Z consumes its second command character without hanging", async () => {
      // ZZ and ZQ intentionally terminate Neovim, so use an invalid suffix to
      // verify the same synchronous second-character read without killing it.
      await expectEdit("abc", normal, "Zxx", { text: "bc", submitted: false });
    });
  });

  describe("operator-pending commands", () => {
    for (let count = 1; count <= 9; count++) {
      it(`handles the count ${count}`, async () => {
        const text = "abcdefghij";
        await expectEdit(text, normal, `d${count}l`, { text: text.slice(count), submitted: false });
      });
    }

    it("handles Ctrl-\\ Ctrl-N while an operator is pending", async () => {
      await expectEdit("one two three", normal, "d\x1c\x0ex", { text: "ne two three", submitted: false });
    });

    it("handles an F motion", async () => {
      await expectEdit("abacad", { line: 0, col: 5 }, "dFa", { text: "abacd", submitted: false });
    });

    it("handles a T motion", async () => {
      await expectEdit("abacad", { line: 0, col: 5 }, "dTax", { text: "abaca", submitted: false });
    });

    const cases = [
      { name: "a text object", keys: "daw", expected: "two three" },
      { name: "i text object", keys: "diw", expected: " two three" },
      { name: "a count", keys: "d2w", expected: "three" },
      { name: "g motion", keys: "dgg", expected: "" },
      { name: "f motion", keys: "dft", expected: "wo three" },
      { name: "t motion", keys: "dtt", expected: "two three" },
      { name: "' mark motion", keys: "maw$d'ax", expected: "" },
      { name: "` mark motion", keys: "maw$d`ax", expected: "" },
      { name: "[ motion", keys: "d[[x", expected: "ne two three" },
      { name: "] motion", keys: "d]]x", expected: "" },
      { name: "z command", keys: "dzhx", expected: "ne two three" },
    ] as const;

    for (const testCase of cases) {
      it(`handles ${testCase.name}`, async () => {
        await expectEdit("one two three", normal, testCase.keys, { text: testCase.expected, submitted: false });
      });
    }
  });

  describe("submission", () => {
    it("does not submit ordinary Normal-mode commands", async () => {
      await expectEdit("abc", normal, "ggx", { text: "bc", submitted: false });
    });

    it("submits after a Normal-mode command enters Insert mode", async () => {
      await expectEdit("abc", { line: 0, col: 2 }, ["A", "!", "\r"], { text: "", submitted: true });
    });
  });
});
