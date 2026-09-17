import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {KeybindingsManager} from '@earendil-works/pi-coding-agent';
import {matchesKey, type EditorTheme, type TUI} from '@earendil-works/pi-tui';
import {NvimEditor} from './index.ts';

/**
 * A location in the prompt buffer.
 *
 * Both {@code line} and {@code column} are treated as zero-indexed.
 */
type Position = {
  line: number;
  column: number;
};

const piShortcuts = [
  ['o', 'app.tools.expand'],
  ['t', 'app.thinking.toggle'],
  ['l', 'app.model.select'],
  ['g', 'app.editor.external'],
  ['x', 'app.message.copy'],
  ['z', 'app.suspend'],
  ['c', 'app.clear'],
  ['v', 'app.clipboard.pasteImage'],
] as const;

/** Return an {@link NvimEditor} sufficient for use in tests. */
function testEditor(): NvimEditor {
  // Provide minimal fakes to the `NvimEditor` constructor
  // in order to test that its contents can be edited as expected.
  const tui = {
    terminal: {columns: 80, rows: 24},
    requestRender() {},
    getShowHardwareCursor: () => false,
    setShowHardwareCursor() {},
  } as unknown as TUI;

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

  const keybindings = {
    matches: (data: string, action: string) =>
      (action === 'app.exit' && matchesKey(data, 'ctrl+d')) ||
      piShortcuts.some(([key, id]) =>
        action === id && matchesKey(data, `ctrl+${key}`),
      ),
  } as unknown as KeybindingsManager;

  return new NvimEditor(tui, theme, keybindings);
}

/** Wait for queued Neovim work and snapshot application. */
async function settle(editor: NvimEditor): Promise<void> {
  await editor['queue'];
}

/** The externally observable editor state after a series of keystrokes. */
type EditorState = {
  text: string;
  submitted: boolean;
};

/**
 * Helper to return an {@link EditorState} that was submitted
 * at some point during processing.
 */
function submitted(text?: string): EditorState {
  return {
    text: text ?? '',
    submitted: true,
  };
}

/** Helper to return an {@link EditorState} that was never submitted. */
function unsubmitted(text?: string): EditorState {
  return {
    text: text ?? '',
    submitted: false,
  };
}

/**
 * Execute series of keystrokes
 * against a fresh editor backed by a real Neovim process.
 *
 * Each run starts with the requested text and cursor in Normal mode.
 * Characters within `keys` are sent in order.
 * Separate entries are useful when a command changes modes
 * and the next key must be interpreted in that new mode.
 */
async function edit(
  text: string,
  cursor: Position,
  keys: string | string[],
): Promise<EditorState> {
  const editor = testEditor();

  let submitted = false;
  let result: string | undefined;
  editor.onSubmit = text => {
    submitted = true;
    result = text;
  };

  try {
    // Set the initial text.
    editor.setText(text);
    await settle(editor);

    // Enter normal mode (the initial mode is insert).
    editor.handleInput('\x1b');
    await settle(editor);

    // Navigate the cursor to the specified starting position.
    await editor['nvim'].call('nvim_win_set_cursor', [
      0,
      [cursor.line + 1, cursor.column],
    ]);
    editor['moveCursorTo'](cursor.line, cursor.column);

    // Send all the input, pausing for processing between chunks.
    for (const chunk of typeof keys === 'string' ? [keys] : keys) {
      for (const key of chunk) editor.handleInput(key);
      await settle(editor);
    }

    // If submitted, return the the text that was sent to the agent.
    // If unsubmitted, return the final state of the editor.
    return {text: result ?? editor.getText(), submitted};
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

void describe('Normal mode', () => {
  void describe('counts', () => {
    for (const count of [1, 20, 103]) {
      void it(`${count}x applies the count and completes`, async () => {
        const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(10);
        await expectEdit(
          text,
          {line: 0, column: 0},
          `${count}x`,
          unsubmitted(text.slice(count)),
        );
      });
    }

    void it('0 is a complete motion rather than a count prefix', async () => {
      await expectEdit('abc', {line: 0, column: 2}, '0x', unsubmitted('bc'));
    });
  });

  void describe('control-key prefixes', () => {
    void it('Ctrl-\\ Ctrl-N completes before the following command', async () => {
      await expectEdit(
        'abc',
        {line: 0, column: 0},
        '\x1c\x0ex',
        unsubmitted('bc'),
      );
    });

    void it('Ctrl-W w completes in a single-window editor', async () => {
      await expectEdit(
        'abc',
        {line: 0, column: 0},
        '\x17wx',
        unsubmitted('bc'),
      );
    });
  });

  void describe('commands that take a character argument', () => {
    void it('" selects a register', async () => {
      await expectEdit('abc', {line: 0, column: 0}, '"ax', unsubmitted('bc'));
    });

    void it("m sets a mark and ' jumps to its line", async () => {
      await expectEdit(
        'abcdefg',
        {line: 0, column: 0},
        "lma$hx'ax",
        unsubmitted('bcdeg'),
      );
    });

    void it('m sets a mark and ` jumps to its exact position', async () => {
      await expectEdit(
        'abcdefg',
        {line: 0, column: 0},
        'lma$hx`ax',
        unsubmitted('acdeg'),
      );
    });

    void it('q records a macro and @ executes it', async () => {
      await expectEdit(
        'abcdefghijk',
        {line: 0, column: 0},
        ['qa3~mxA', '_\x1b', '`xq3l@a'],
        unsubmitted('ABCdefGHIjk__'),
      );
    });

    const characterMotions = [
      {
        name: 'f',
        text: 'abacad',
        cursor: {line: 0, column: 0},
        keys: 'fcx',
        expected: 'abaad',
      },
      {
        name: 't',
        text: 'abacad',
        cursor: {line: 0, column: 0},
        keys: 'tcx',
        expected: 'abcad',
      },
      {
        name: 'F',
        text: 'abacad',
        cursor: {line: 0, column: 5},
        keys: 'Fax',
        expected: 'abacd',
      },
      {
        name: 'T',
        text: 'abacad',
        cursor: {line: 0, column: 5},
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

    for (const char of ['Z', '?', '/', ':']) {
      void it(`r consumes the replacement character ${char}`, async () => {
        await expectEdit('abc', {line: 0, column: 1}, `r${char}`, unsubmitted(`a${char}c`));
        await expectEdit('abc', {line: 0, column: 1}, ['r', char], unsubmitted(`a${char}c`));
      });
    }

    for (const char of ['?', '/', ':']) {
      void it(`f consumes the target character ${char}`, async () => {
        await expectEdit(`a${char}b`, {line: 0, column: 0}, `f${char}x`, unsubmitted('ab'));
      });
    }
  });

  void describe('command-family prefixes', () => {
    void it('g dispatches a g command without blocking the input queue', async () => {
      await expectEdit(
        'one\ntwo',
        {line: 1, column: 2},
        ['g', 'gx'],
        unsubmitted('on\ntwo'),
      );
    });

    void it('[ dispatches a bracket command', async () => {
      await expectEdit(
        'one\n\ntwo',
        {line: 2, column: 0},
        '[[x',
        unsubmitted('ne\n\ntwo'),
      );
    });

    void it('] dispatches a bracket command', async () => {
      await expectEdit(
        'one\n\ntwo',
        {line: 0, column: 0},
        ']]x',
        unsubmitted('one\n\nwo'),
      );
    });

    void it('z dispatches a z command', async () => {
      await expectEdit('abc', {line: 0, column: 0}, 'zhx', unsubmitted('bc'));
    });

    void it('Z consumes its second command character without hanging', async () => {
      // ZZ and ZQ intentionally terminate Neovim, so use an invalid suffix to
      // verify the same synchronous second-character read without killing it.
      await expectEdit('abc', {line: 0, column: 0}, 'Zxx', unsubmitted('bc'));
    });
  });

  void describe('operator-pending commands', () => {
    for (const count of [1, 20, 103]) {
      void it(`handles the count ${count}`, async () => {
        const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(10);
        await expectEdit(
          text,
          {line: 0, column: 0},
          `d${count}l`,
          unsubmitted(text.slice(count)),
        );
      });
    }

    void it('handles Ctrl-\\ Ctrl-N while an operator is pending', async () => {
      await expectEdit(
        'one two three',
        {line: 0, column: 0},
        'd\x1c\x0ex',
        unsubmitted('ne two three'),
      );
    });

    void it('handles an F motion', async () => {
      await expectEdit(
        'abacad',
        {line: 0, column: 5},
        'dFa',
        unsubmitted('abacd'),
      );
    });

    void it('handles a T motion', async () => {
      await expectEdit(
        'abacad',
        {line: 0, column: 5},
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
          {line: 0, column: 0},
          testCase.keys,
          unsubmitted(testCase.expected),
        );
      });
    }
  });

  void describe('ex-style commands', () => {
    for (const key of [':', '/', '?']) {
      void it(`silently ignores ${key}`, async () => {
        await expectEdit(
          'abc',
          {line: 0, column: 0},
          `${key}x`,
          unsubmitted('bc'),
        );
      });
    }
  });

  void describe('submission', () => {
    void it('does not submit ordinary Normal-mode commands', async () => {
      await expectEdit('abc', {line: 0, column: 0}, 'ggx', unsubmitted('bc'));
    });

    void it('submits on Enter', async () => {
      await expectEdit('abc', {line: 0, column: 0}, '\r', submitted('abc'));
    });

    void it('submits after a Normal-mode command enters Insert mode', async () => {
      await expectEdit(
        'abc',
        {line: 0, column: 2},
        ['A', '!', '\r'],
        submitted('abc!'),
      );
    });
  });
});

void describe('Insert mode', () => {
  void it('submits on Enter', async () => {
    await expectEdit(
      'abc',
      {line: 0, column: 0},
      ['i', '\r'],
      submitted('abc'),
    );
  });

  void it('handles Backspace without leaving Insert mode', async () => {
    await expectEdit(
      'abc',
      {line: 0, column: 0},
      ['i', 'X\x7fZ'],
      unsubmitted('Zabc'),
    );
  });

  void it('inserts a literal less-than sign', async () => {
    await expectEdit(
      'abc',
      {line: 0, column: 0},
      ['i', '<'],
      unsubmitted('<abc'),
    );
  });

  void it('delegates Ctrl-D to the Pi editor', async () => {
    await expectEdit(
      'abc',
      {line: 0, column: 0},
      ['i', '\x04'],
      unsubmitted('bc'),
    );
  });

  void it('inserts a newline for Shift-Enter and stays in Insert mode', async () => {
    await expectEdit(
      'abc',
      {line: 0, column: 2},
      ['A', '\n', 'Z'],
      unsubmitted('abc\nZ'),
    );
  });
});

void describe('Visual mode', () => {
  void it('uses Ctrl-V for blockwise editing', async () => {
    await expectEdit(
      'abc\ndef',
      {line: 0, column: 1},
      '\x16jld',
      unsubmitted('a\nd'),
    );
  });
});

void describe('Ctrl-D synchronization', () => {
  for (const normal of [false, true]) {
    for (const data of ['\x04', '\x1b[100;6u']) {
      void it(`exits an empty prompt with ${JSON.stringify(data)}, normal=${normal}`, async () => {
        const editor = testEditor();
        let exits = 0;
        editor.onCtrlD = () => exits++;
        try {
          await settle(editor);
          if (normal) {
            editor.handleInput('\x1b');
            await settle(editor);
          }
          editor.handleInput(data);
          assert.equal(exits, 1);
          await settle(editor);
        } finally {
          editor.dispose();
        }
      });
    }
    for (const data of normal ? ['\x1b[100;6u'] : ['\x04', '\x1b[100;6u']) {
      void it(`synchronizes deletion with ${JSON.stringify(data)}, normal=${normal}`, async () => {
        const editor = testEditor();
        try {
          editor.setText('éabc');
          await settle(editor);
          editor.handleInput('\x1b');
          await settle(editor);
          editor.handleInput('0l');
          await settle(editor);
          if (!normal) {
            editor.handleInput('i');
            await settle(editor);
          }
          editor.handleInput(data);
          await settle(editor);
          assert.equal(editor.getText(), 'ébc');
          const snapshot = await editor['nvim'].snapshot();
          assert.equal(snapshot.text, 'ébc');
          assert.equal(snapshot.col, 2);
          assert.equal(snapshot.mode, normal ? 'NORMAL' : 'INSERT');
          editor.handleInput(normal ? 'x' : 'Z');
          await settle(editor);
          assert.equal(editor.getText(), normal ? 'éc' : 'éZbc');
        } finally {
          editor.dispose();
        }
      });
    }
  }

  void it('synchronizes deletion of a newline in Insert mode', async () => {
    await expectEdit(
      'ab\ncd', {line: 0, column: 1}, ['a', '\x04', 'Z'], unsubmitted('abZcd'),
    );
  });

  void it('cancels a pending Normal-mode command before synchronizing', async () => {
    const editor = testEditor();
    try {
      editor.setText('abc');
      await settle(editor);
      editor.handleInput('\x1b');
      await settle(editor);
      editor.handleInput('0');
      await settle(editor);
      editor.handleInput('r');
      await settle(editor);
      editor.handleInput('\x1b[100;6u');
      await settle(editor);
      assert.equal((await editor['nvim'].snapshot()).text, 'bc');
    } finally {
      editor.dispose();
    }
  });

  void it('keeps unshifted Ctrl-D in Neovim for nonempty Normal mode', async () => {
    await expectEdit('abc', {line: 0, column: 0}, '\x04', unsubmitted('abc'));
  });
});

void describe('Pi shortcut routing', () => {
  const shortcuts = piShortcuts.map(([letter, action]) => {
    const code = letter.charCodeAt(0);
    return {
      key: `<C-${letter}>`, action,
      inputs: [String.fromCharCode(code - 96), `\x1b[${code};5u`],
      shiftedInputs: [`\x1b[${code};6u`, `\x1b[27;6;${code}~`],
    };
  });
  const cases = shortcuts.flatMap(({key, action, inputs, shiftedInputs}) => [
    ...inputs.map(data => ({key, action, data, shifted: false})),
    ...shiftedInputs.map(data => ({
      key: key.replace('<C-', '<C-S-'), action, data, shifted: true,
    })),
  ]);
  for (const {key, action, data, shifted} of cases) {
    for (const normal of [false, true]) {
      void it(`routes ${JSON.stringify(data)} in ${normal ? 'Normal' : 'Insert'} mode`, async () => {
        const editor = testEditor();
        let toggles = 0;
        if (action === 'app.clipboard.pasteImage') {
          editor.onPasteImage = () => toggles++;
        } else {
          editor.onAction(action, () => toggles++);
        }
        try {
          await settle(editor);
          if (normal) {
            editor.handleInput('\x1b');
            await settle(editor);
          }
          // A mapping makes delivery to Neovim observable in either mode.
          await editor['nvim'].call('nvim_set_keymap', [
            normal ? 'n' : 'i',
            key,
            normal ? 'iX<Esc>' : 'X',
            {noremap: true},
          ]);
          editor.handleInput(data);
          const sentToNvim = normal && !shifted;
          assert.equal(toggles, sentToNvim ? 0 : 1);
          await settle(editor);
          assert.equal(editor.getText(), sentToNvim ? 'X' : '');
          assert.equal(editor['mode'], normal ? 'NORMAL' : 'INSERT');
        } finally {
          editor.dispose();
        }
      });
    }
  }
});

void describe('Terminal key translation', () => {
  const mappings = [
    {data: '\x1b[27;5u', key: '<C-Esc>'},
    {data: '\x1b[27;5;27~', key: '<C-Esc>'},
    {data: '\x1b[119;5u', key: '<C-w>'},
    {data: '\x1b[1;3D', key: '<A-Left>'},
    {data: '\x1b[Z', key: '<S-Tab>'},
    {data: '\x1b[43;5u', key: '<C-+>'},
    {data: '\x1b[60;5u', key: '<C-LT>'},
    {data: '\x1b[97;7u', key: '<C-A-a>'},
    {data: '\x7f', key: '<BS>'},
    {data: '\x1b[3~', key: '<Del>'},
  ];
  for (const {data, key} of mappings) {
    void it(`forwards ${JSON.stringify(data)} as ${key}`, async () => {
      const editor = testEditor();
      try {
        await settle(editor);
        // A Neovim mapping verifies key identity, including its modifiers.
        await editor['nvim'].call('nvim_set_keymap', [
          'i',
          key,
          'X',
          {noremap: true},
        ]);
        editor.handleInput(data);
        await settle(editor);
        assert.equal(editor.getText(), 'X');
      } finally {
        editor.dispose();
      }
    });
  }

  const inputs = [
    {data: '\x1b[27;5u', expected: 'hello'},
    {data: '\x1b[999;5u', expected: 'hello'},
    {data: '\x1b[97u', expected: 'helloa'},
    {data: '\x1b[97:65;2u', expected: 'helloA'},
    {data: '\x1b[233u', expected: 'helloé'},
    {data: '\x1b[60u', expected: 'hello<'},
    {data: '<Esc><BS>é+', expected: 'hello<Esc><BS>é+'},
    {
      data: '\x1b[200~<Esc>\x1b[27;5u\x1b[201~',
      expected: 'hello<Esc>\x1b[27;5u',
    },
  ];
  for (const {data, expected} of inputs) {
    void it(`safely handles ${JSON.stringify(data)} in Insert mode`, async () => {
      const editor = testEditor();
      try {
        await settle(editor);
        editor.handleInput('hello');
        await settle(editor);
        editor.handleInput(data);
        await settle(editor);
        assert.equal(editor.getText(), expected);
      } finally {
        editor.dispose();
      }
    });
  }
});

void describe('Cursor synchronization', () => {
  void it('remains responsive with a prompt longer than 2,000 characters', async () => {
    const text = 'a'.repeat(2500);
    await expectEdit(
      text,
      {line: 0, column: 2499},
      '0x',
      unsubmitted(text.slice(1)),
    );
  });
});
