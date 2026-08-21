import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {describe, it} from 'node:test';
import type {KeybindingsManager} from '@earendil-works/pi-coding-agent';
import type {EditorTheme, TUI} from '@earendil-works/pi-tui';
import {NvimEditor} from './index.ts';

/** A zero-based location in the prompt buffer. */
type Position = {
  line: number;
  col: number;
};

/** The externally observable editor state after a series of keystrokes. */
type EditorState = {
  text: string;
  submitted: boolean;
};

// After submission, the editor should always be empty.
const submitted: EditorState = {
  text: '',
  submitted: true,
};

/** Helper to return an {@link EditorState} that contains unsubmitted text. */
function unsubmitted(text: string): EditorState {
  return {
    text,
    submitted: false,
  };
}

/**
 * Narrow white-box view used to position and synchronize the editor.
 *
 * Pi does not publish its internal test fakes,
 * and NvimEditor intentionally has no production API
 * for awaiting snapshots or setting a Neovim cursor.
 * Keeping that test-only access here avoids adding testing concerns to the extension.
 */
type EditorInternals = {
  nvim: {
    call(method: string, args?: unknown[]): Promise<unknown>;
  };
  nvimQueue: Promise<void>;
  queue: Promise<void>;
  moveCursorTo(line: number, col: number): void;
};

// These fakes implement only the collaborators reached by non-rendering editor tests.
// Neovim itself must be real because its input state machine is the behavior under test.
const theme: EditorTheme = {
  borderColor: text => text,
  selectList: {
    selectedPrefix: text => text,
    selectedText: text => text,
    description: text => text,
    scrollInfo: text => text,
    noMatch: text => text,
  },
};

const tui = {
  terminal: {columns: 80, rows: 24},
  requestRender() {},
} as unknown as TUI;

const keybindings = {
  matches: () => false,
} as unknown as KeybindingsManager;

function internals(editor: NvimEditor): EditorInternals {
  return editor as unknown as EditorInternals;
}

/**
 * Waits for both input delivery and snapshot application.
 *
 * The timeout is also the regression assertion: with the old single-queue
 * implementation, an incomplete command made these promises wait forever.
 */
async function settle(editor: NvimEditor): Promise<void> {
  const pending = internals(editor);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([pending.nvimQueue, pending.queue]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                'editor did not settle (possible input/snapshot deadlock)',
              ),
            ),
          1500,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Runs a command against a fresh editor backed by a real Neovim process.
 *
 * Each run starts with the requested text and cursor in Normal mode. Characters
 * within one `keys` entry are deliberately sent without waiting: waiting after
 * an incomplete prefix would hide the exact scheduling regression these tests
 * cover. Separate entries are useful when a command changes modes and the next
 * key must be interpreted in that new mode.
 */
async function edit(
  text: string,
  cursor: Position,
  keys: string | string[],
): Promise<EditorState> {
  const editor = new NvimEditor(tui, theme, keybindings);
  let submitted = false;
  editor.onSubmit = () => {
    submitted = true;
  };

  try {
    editor.setText(text);
    await settle(editor);

    editor.handleInput('\x1b');
    await settle(editor);

    const state = internals(editor);
    await state.nvim.call('nvim_win_set_cursor', [
      0,
      [cursor.line + 1, cursor.col],
    ]);
    state.moveCursorTo(cursor.line, cursor.col);

    for (const chunk of typeof keys === 'string' ? [keys] : keys) {
      for (const key of chunk) editor.handleInput(key);
      await settle(editor);
    }

    return {text: editor.getText(), submitted};
  } finally {
    editor.dispose();
  }
}

async function expectEdit(
  text: string,
  cursor: Position,
  keys: string | string[],
  expected: EditorState,
): Promise<void> {
  assert.deepEqual(await edit(text, cursor, keys), expected);
}

const hasNvim =
  spawnSync('nvim', ['--version'], {stdio: 'ignore'}).status === 0;
const normal = {line: 0, col: 0};

void describe('NvimEditor Normal-mode commands', {skip: !hasNvim}, () => {
  void describe('counts', () => {
    for (let count = 1; count <= 9; count++) {
      void it(`${count}x applies the count and completes`, async () => {
        const text = 'abcdefghij';
        await expectEdit(
          text,
          normal,
          `${count}x`,
          unsubmitted(text.slice(count)),
        );
      });
    }

    void it('0 is a complete motion rather than a count prefix', async () => {
      await expectEdit('abc', {line: 0, col: 2}, '0x', unsubmitted('bc'));
    });
  });

  void describe('control-key prefixes', () => {
    void it('Ctrl-\\ Ctrl-N completes before the following command', async () => {
      await expectEdit('abc', normal, '\x1c\x0ex', unsubmitted('bc'));
    });

    void it('Ctrl-W w completes in a single-window editor', async () => {
      await expectEdit('abc', normal, '\x17wx', unsubmitted('bc'));
    });
  });

  void describe('commands that take a character argument', () => {
    void it('" selects a register', async () => {
      await expectEdit('abc', normal, '"ax', unsubmitted('bc'));
    });

    void it("m sets a mark and ' jumps to its line", async () => {
      await expectEdit('abc', normal, "ma$'ax", unsubmitted('bc'));
    });

    void it('m sets a mark and ` jumps to its exact position', async () => {
      await expectEdit('abc', normal, 'ma$`ax', unsubmitted('bc'));
    });

    void it('q records a macro and @ executes it', async () => {
      await expectEdit('abc', normal, 'qaxq@a', unsubmitted('c'));
    });

    const characterMotions = [
      {
        name: 'f',
        text: 'abacad',
        cursor: {line: 0, col: 0},
        keys: 'fcx',
        expected: 'abaad',
      },
      {
        name: 't',
        text: 'abacad',
        cursor: {line: 0, col: 0},
        keys: 'tcx',
        expected: 'abcad',
      },
      {
        name: 'F',
        text: 'abacad',
        cursor: {line: 0, col: 5},
        keys: 'Fax',
        expected: 'abacd',
      },
      {
        name: 'T',
        text: 'abacad',
        cursor: {line: 0, col: 5},
        keys: 'Tax',
        expected: 'abaca',
      },
    ] as const;

    for (const testCase of characterMotions) {
      void it(`${testCase.name} consumes its target character`, async () => {
        await expectEdit(
          testCase.text,
          testCase.cursor,
          testCase.keys,
          unsubmitted(testCase.expected),
        );
      });
    }

    void it('r consumes the replacement character', async () => {
      await expectEdit('abc', {line: 0, col: 1}, 'rZ', unsubmitted('aZc'));
    });
  });

  void describe('command-family prefixes', () => {
    void it('g dispatches a g command', async () => {
      await expectEdit(
        'one\ntwo',
        {line: 1, col: 2},
        'ggx',
        unsubmitted('on\ntwo'),
      );
    });

    void it('[ dispatches a bracket command', async () => {
      await expectEdit(
        'one\n\ntwo',
        {line: 2, col: 0},
        '[[x',
        unsubmitted('ne\n\ntwo'),
      );
    });

    void it('] dispatches a bracket command', async () => {
      await expectEdit('one\n\ntwo', normal, ']]x', unsubmitted('one\n\nwo'));
    });

    void it('z dispatches a z command', async () => {
      await expectEdit('abc', normal, 'zhx', unsubmitted('bc'));
    });

    void it('Z consumes its second command character without hanging', async () => {
      // ZZ and ZQ intentionally terminate Neovim, so use an invalid suffix to
      // verify the same synchronous second-character read without killing it.
      await expectEdit('abc', normal, 'Zxx', unsubmitted('bc'));
    });
  });

  void describe('operator-pending commands', () => {
    for (let count = 1; count <= 9; count++) {
      void it(`handles the count ${count}`, async () => {
        const text = 'abcdefghij';
        await expectEdit(
          text,
          normal,
          `d${count}l`,
          unsubmitted(text.slice(count)),
        );
      });
    }

    void it('handles Ctrl-\\ Ctrl-N while an operator is pending', async () => {
      await expectEdit(
        'one two three',
        normal,
        'd\x1c\x0ex',
        unsubmitted('ne two three'),
      );
    });

    void it('handles an F motion', async () => {
      await expectEdit(
        'abacad',
        {line: 0, col: 5},
        'dFa',
        unsubmitted('abacd'),
      );
    });

    void it('handles a T motion', async () => {
      await expectEdit(
        'abacad',
        {line: 0, col: 5},
        'dTax',
        unsubmitted('abaca'),
      );
    });

    const cases = [
      {name: 'a text object', keys: 'daw', expected: 'two three'},
      {name: 'i text object', keys: 'diw', expected: ' two three'},
      {name: 'a count', keys: 'd2w', expected: 'three'},
      {name: 'g motion', keys: 'dgg', expected: ''},
      {name: 'f motion', keys: 'dft', expected: 'wo three'},
      {name: 't motion', keys: 'dtt', expected: 'two three'},
      {name: "' mark motion", keys: "maw$d'ax", expected: ''},
      {name: '` mark motion', keys: 'maw$d`ax', expected: ''},
      {name: '[ motion', keys: 'd[[x', expected: 'ne two three'},
      {name: '] motion', keys: 'd]]x', expected: ''},
      {name: 'z command', keys: 'dzhx', expected: 'ne two three'},
    ] as const;

    for (const testCase of cases) {
      void it(`handles ${testCase.name}`, async () => {
        await expectEdit(
          'one two three',
          normal,
          testCase.keys,
          unsubmitted(testCase.expected),
        );
      });
    }
  });

  void describe('submission', () => {
    void it('does not submit ordinary Normal-mode commands', async () => {
      await expectEdit('abc', normal, 'ggx', unsubmitted('bc'));
    });

    void it('submits after a Normal-mode command enters Insert mode', async () => {
      await expectEdit('abc', {line: 0, col: 2}, ['A', '!', '\r'], submitted);
    });
  });
});
