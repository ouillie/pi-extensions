import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {KeybindingsManager} from '@earendil-works/pi-coding-agent';
import {
  CURSOR_MARKER,
  type EditorTheme,
  type TUI,
} from '@earendil-works/pi-tui';
import {NvimEditor} from './index.ts';

type RenderState = {
  text: string;
  line: number;
  col: number;
  mode: 'NORMAL' | 'INSERT' | 'VISUAL' | 'LINE' | 'BLOCK';
  selection: {
    kind: 'char' | 'line' | 'block';
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  } | null;
};

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

/** Render an editor whose state has the same shape as a Neovim snapshot. */
async function render(state: RenderState, width = 12): Promise<string[]> {
  const tui = {
    terminal: {columns: width, rows: 24},
    requestRender() {},
    getShowHardwareCursor: () => false,
    setShowHardwareCursor() {},
  } as unknown as TUI;
  const keybindings = {matches: () => false} as unknown as KeybindingsManager;
  const editor = new NvimEditor(tui, theme, keybindings);

  try {
    editor.setText(state.text);
    await editor['queue'];
    editor['moveCursorTo'](state.line, state.col);
    editor['mode'] = state.mode;
    editor['selection'] = state.selection;
    editor.focused = true;
    const lines = editor.render(width);
    await editor['queue'];
    return lines;
  } finally {
    editor.dispose();
  }
}

void describe('Rendering', () => {
  void it('renders an insert-mode hardware cursor without a software cursor', async () => {
    assert.deepEqual(
      await render({
        text: 'abc',
        line: 0,
        col: 3,
        mode: 'INSERT',
        selection: null,
      }),
      ['────────────', `abc${CURSOR_MARKER}         `, '────\x1b[0m INSERT '],
    );
  });

  void it('renders a characterwise visual selection around the cursor marker', async () => {
    assert.deepEqual(
      await render({
        text: 'abc',
        line: 0,
        col: 1,
        mode: 'VISUAL',
        selection: {
          kind: 'char',
          startLine: 0,
          startCol: 0,
          endLine: 0,
          endCol: 2,
        },
      }),
      [
        '────────────',
        `\x1b[7ma${CURSOR_MARKER}\x1b[7mb\x1b[27mc         `,
        '────\x1b[0m VISUAL ',
      ],
    );
  });

  void it('renders a linewise visual selection', async () => {
    assert.deepEqual(
      await render({
        text: 'abc',
        line: 0,
        col: 1,
        mode: 'LINE',
        selection: {
          kind: 'line',
          startLine: 0,
          startCol: 0,
          endLine: 0,
          endCol: Number.MAX_SAFE_INTEGER,
        },
      }),
      [
        '────────────',
        `\x1b[7ma${CURSOR_MARKER}bc         \x1b[27m`,
        '──────\x1b[0m LINE ',
      ],
    );
  });
});
