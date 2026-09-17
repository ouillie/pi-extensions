import {
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
} from '@earendil-works/pi-coding-agent';
import {decodeMultiStream, encode} from '@msgpack/msgpack';
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  matchesKey,
  parseKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
} from '@earendil-works/pi-tui';

/** Mirror the hard-coded 500ms ceiling Pi uses for the double-click latency. */
const DOUBLE_CLICK_DELAY_MS = 500;

/** Return true if there is an invocable program called `nvim` on the PATH. */
function hasNvim() {
  return spawnSync('nvim', ['--version'], {stdio: 'ignore'}).status === 0;
}

type Mode = 'NORMAL' | 'INSERT' | 'VISUAL' | 'LINE' | 'BLOCK';
type Pending = {resolve: (v: unknown) => void; reject: (e: unknown) => void};
type WarningLogger = (message: string) => void;
type VisualSelection = {
  kind: 'char' | 'line' | 'block';
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
};

/** Remove Pi's reverse-video software cursor from a rendered line. */
function stripCursorHighlight(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[7m([\s\S]*)\x1b\[0m/g, '$1');
}

function highlightVisibleRange(
  line: string,
  startCol: number,
  endCol: number,
): string {
  const width = visibleWidth(line);
  const start = Math.max(0, Math.min(startCol, width));
  const end = Math.max(start, Math.min(endCol, width));
  if (start === end) return line;

  const markerIndex = line.indexOf(CURSOR_MARKER);
  const markerCol =
    markerIndex === -1 ? 0 : visibleWidth(line.slice(0, markerIndex));
  if (markerIndex !== -1) line = line.replace(CURSOR_MARKER, '');

  const highlighted = `${sliceByColumn(line, 0, start)}\x1b[7m${sliceByColumn(line, start, end - start)}\x1b[27m${sliceByColumn(line, end, width - end)}`;
  if (markerIndex === -1) return highlighted;
  return `${sliceByColumn(highlighted, 0, markerCol)}${CURSOR_MARKER}${sliceByColumn(highlighted, markerCol, width - markerCol)}`;
}

// Tmux surrounds pasted text with these CSI markers.
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Given a (UTF-16) string
 * and the hypothetical offset of a byte in that string if it were UTF-8-encoded,
 * return the index of the UTF-16 code unit corresponding to that UTF-8 byte.
 *
 * Neovim represents column indices as UTF-8 byte offsets, but JS uses UTF-16 strings.
 */
function utf8ByteOffsetToUtf16Index(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let utf16 = 0;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const units = cp > 0xffff ? 2 : 1;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    bytes += size;
    utf16 += units;
    if (byteOffset <= bytes) return utf16;
    i += units;
  }
  return utf16;
}

/** Convert Neovim's visual state into a compact selection range for rendering. */
function visualSelectionFromState(
  mode: Mode,
  startPos: unknown,
  cursorPos: unknown,
  startVirtCol: unknown,
  cursorVirtCol: unknown,
): VisualSelection | null {
  if (mode !== 'VISUAL' && mode !== 'LINE' && mode !== 'BLOCK') return null;
  if (!Array.isArray(startPos) || !Array.isArray(cursorPos)) return null;

  const startLine = Math.max(0, ((startPos[1] as number | undefined) ?? 1) - 1);
  const endLine = Math.max(0, ((cursorPos[0] as number | undefined) ?? 1) - 1);

  if (mode === 'LINE') {
    return {
      kind: 'line',
      startLine: Math.min(startLine, endLine),
      startCol: 0,
      endLine: Math.max(startLine, endLine),
      endCol: Number.MAX_SAFE_INTEGER,
    };
  }

  const startCol = Math.max(
    0,
    Math.min(
      ((startVirtCol as number | undefined) ?? 1) - 1,
      ((cursorVirtCol as number | undefined) ?? 1) - 1,
    ),
  );
  const endCol = Math.max(
    (startVirtCol as number | undefined) ?? 1,
    (cursorVirtCol as number | undefined) ?? 1,
  );

  if (mode === 'BLOCK') {
    return {
      kind: 'block',
      startLine: Math.min(startLine, endLine),
      startCol,
      endLine: Math.max(startLine, endLine),
      endCol,
    };
  }

  return {
    kind: 'char',
    startLine: Math.min(startLine, endLine),
    startCol,
    endLine: Math.max(startLine, endLine),
    endCol,
  };
}

class Nvim {
  private process: ChildProcessWithoutNullStreams;
  private id = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void>;
  private warn: WarningLogger;

  constructor(warn: WarningLogger) {
    this.warn = warn;
    this.process = spawn('nvim', ['--clean', '-n', '--headless', '--embed'], {
      stdio: 'pipe',
    });
    void this.readLoop();
    this.process.stderr.on('data', () => {});
    this.process.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('nvim exited'));
      this.pending.clear();
    });
    this.ready = this.init();
  }

  private async readLoop() {
    for await (const msg of decodeMultiStream(
      this.process.stdout as AsyncIterable<Uint8Array>,
    ))
      this.onMsg(msg);
  }

  private onMsg(msg: unknown) {
    if (!Array.isArray(msg) || msg[0] !== 1) return;
    const p = this.pending.get(msg[1]);
    if (!p) return;
    this.pending.delete(msg[1]);
    if (msg[2]) p.reject(new Error(String(msg[2])));
    else p.resolve(msg[3]);
  }

  call(method: string, args: unknown[] = []) {
    const id = this.id++;
    this.process.stdin.write(encode([0, id, method, args]));
    return new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, {resolve, reject}),
    );
  }

  async init() {
    await this.call('nvim_command', [
      'set noswapfile undofile& viminfo= shada= virtualedit=block selection=inclusive',
    ]);
    // Disable Ex commands and searches.
    for (const key of [':', '/', '?']) {
      await this.call('nvim_command', [`noremap ${key} <Nop>`]);
    }
    await this.call('nvim_command', ['enew']);
    await this.call('nvim_command', ['startinsert!']);
  }

  async setText(text: string) {
    const lines = text.split('\n');
    await this.ready;
    // Cancel any command synchronously waiting for another key before using
    // deferred APIs. This also makes externally replacing the prompt safe.
    await this.call('nvim_input', ['\x1b']);
    await this.call('nvim_buf_set_lines', [0, 0, -1, true, lines]);
    await this.call('nvim_win_set_cursor', [
      0,
      [Math.max(1, lines.length), (lines.at(-1) ?? '').length],
    ]);
    await this.call('nvim_command', ['startinsert!']);
  }

  private async wouldBlock(): Promise<boolean> {
    return ((await this.call('nvim_get_mode')) as {blocking: boolean}).blocking;
  }

  async input(data: string): Promise<boolean> {
    await this.ready;
    const printable = decodeKittyPrintable(data);
    const key = parseKey(data);
    if (printable !== undefined) {
      data = printable.replaceAll('<', '<LT>');
    } else if (key !== undefined) {
      // Keep a trailing '+' intact when it is the key itself.
      const parts = key.split(/\+(?=.)/);
      const name = parts.pop()!;
      const aliases: Record<string, string> = {
        escape: 'Esc',
        enter: 'CR',
        backspace: 'BS',
        delete: 'Del',
        '<': 'LT',
      };
      const modifiers = parts
        .map(part => `${part[0]!.toUpperCase()}-`)
        .join('');
      data =
        modifiers || name.length > 1
          ? `<${modifiers}${aliases[name] ?? name}>`
          : name.replaceAll('<', '<LT>');
    } else {
      // Unknown terminal sequences must never become Normal-mode commands.
      if (data.includes('\x1b')) return this.wouldBlock();
      data = data.replaceAll('<', '<LT>');
    }
    await this.call('nvim_input', [data]);
    return this.wouldBlock();
  }

  async paste(text: string): Promise<boolean> {
    await this.ready;
    await this.call('nvim_paste', [text, true, -1]);
    return this.wouldBlock();
  }

  async resize(width: number): Promise<boolean> {
    await this.ready;
    if (await this.wouldBlock()) return false;
    await this.call('nvim_set_option_value', [
      'columns',
      Math.max(20, width),
      {},
    ]);
    return true;
  }

  /**
   * Convert a Neovim mode indicator value to an extension-native {@link Mode} label.
   *
   * Neovim uses dozens of distinct indicators to provide detail
   * beyond the 5 modes users are familiar with.
   * For instance, `n` means "normal" Normal mode,
   * whereas `ntT` means Normal mode entered from Terminal mode with CTRL-\ CTRL-O.
   */
  private modeLabel(mode: string): Mode {
    if (mode.startsWith('n')) return 'NORMAL';
    if (mode.startsWith('i') || mode.startsWith('R')) return 'INSERT';
    if (mode.startsWith('v') || mode.startsWith('s')) return 'VISUAL';
    if (mode.startsWith('V') || mode.startsWith('S')) return 'LINE';
    if (mode.startsWith('\x16') || mode.startsWith('\x13')) return 'BLOCK';
    this.warn(`Unrecognized Neovim mode indicator: ${mode}`);
    return 'NORMAL';
  }

  async snapshot() {
    const [lines, cur, nvimMode, visualStart, visualVirtCol, cursorVirtCol] =
      await Promise.all([
        this.call('nvim_buf_get_lines', [0, 0, -1, true]),
        this.call('nvim_win_get_cursor', [0]),
        this.call('nvim_get_mode', []),
        this.call('nvim_eval', ["getpos('v')"]),
        this.call('nvim_eval', ["virtcol('v')"]),
        this.call('nvim_eval', ["virtcol('.')"]),
      ]);
    const mode = this.modeLabel((nvimMode as {mode: string}).mode);
    const text = (lines as string[]).join('\n');
    return {
      text,
      line: ((cur as number[])[0] ?? 1) - 1,
      col: (cur as number[])[1] ?? 0,
      mode,
      selection: visualSelectionFromState(
        mode,
        visualStart,
        cur,
        visualVirtCol,
        cursorVirtCol,
      ),
    };
  }

  quit() {
    this.call('nvim_command', ['qa!']).catch(() => {});
  }
}

export class NvimEditor extends CustomEditor {
  private mode: Mode = 'INSERT';
  private lastEscapeTime = -Infinity;
  private selection: VisualSelection | null = null;
  private nvim: Nvim;
  private queue = Promise.resolve();
  // Invalidates a snapshot if Pi replaces the text while the snapshot is pending.
  private snapshotGeneration = 0;
  private nvimWidth = 0;
  private isPasting = false;
  private nvimPasteBuffer = '';
  private priorShowHardwareCursor: boolean;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    warn: WarningLogger = () => {},
  ) {
    super(tui, theme, keybindings);
    this.priorShowHardwareCursor = tui.getShowHardwareCursor();
    tui.setShowHardwareCursor(true);
    this.nvim = new Nvim(warn);
    this.onPasteImage = () => this.handleInput('\x16');
    void this.enqueue(() => this.nvim.setText(this.getText()));
  }

  private enqueue(action: () => Promise<unknown>) {
    this.queue = this.queue.then(action).then(
      () => undefined,
      () => undefined,
    );
    return this.queue;
  }

  private syncText(text: string) {
    this.snapshotGeneration++;
    void this.enqueue(() => this.nvim.setText(text));
  }

  override setText(text: string): void {
    super.setText(text);
    this.selection = null;
    this.syncText(text);
  }

  override handleInput(data: string): void {
    if (!this.isPasting && matchesKey(data, 'escape')) {
      const previousEscapeTime = this.lastEscapeTime;
      this.lastEscapeTime = Date.now();
      // Only the first Esc in a rapid sequence belongs to Neovim.
      if (this.lastEscapeTime - previousEscapeTime < DOUBLE_CLICK_DELAY_MS) {
        super.handleInput('\x1b');
        return;
      }
    } else {
      this.lastEscapeTime = -Infinity;
    }

    if (data.includes(BRACKETED_PASTE_START)) {
      this.isPasting = true;
      this.nvimPasteBuffer = '';
      data = data.replaceAll(BRACKETED_PASTE_START, '');
    }
    if (this.isPasting) {
      const priorBufferLength = this.nvimPasteBuffer.length;
      this.nvimPasteBuffer += data;
      const endIndex = this.nvimPasteBuffer.indexOf(
        BRACKETED_PASTE_END,
        Math.max(priorBufferLength - BRACKETED_PASTE_END.length, 0),
      );
      if (endIndex === -1) return;
      const pasteText = this.nvimPasteBuffer.slice(0, endIndex);
      const remaining = this.nvimPasteBuffer.slice(
        endIndex + BRACKETED_PASTE_END.length,
      );
      this.isPasting = false;
      this.nvimPasteBuffer = '';
      if (pasteText.length > 0) {
        this.processNvim(() => this.nvim.paste(pasteText));
      }
      if (remaining.length > 0) this.handleInput(remaining);
      return;
    }
    // Normally in Vim:
    // - Ctrl+o:
    //   * Normal mode: jump backward through the jumplist
    //   * Insert mode: temporarily switch to Normal mode
    // - Ctrl+t:
    //   * Normal mode: jump backward through the tag stack (i.e. "ctags")
    //   * Insert mode: indent the current line
    //
    // All these key combinations are preserved in Normal mode,
    // but overridden in Insert mode to be passed as-is to pi,
    // which by default:
    // - Ctrl+o: toggle tool output expansion
    // - Ctrl+t: toggle thinking block visibility
    if (
      this.mode === 'INSERT' &&
      (matchesKey(data, 'ctrl+o') || matchesKey(data, 'ctrl+t'))
    ) {
      super.handleInput(data);
      return;
    }
    const isEnter = matchesKey(data, 'enter');
    const isCtrlD = matchesKey(data, 'ctrl+d');
    if (
      (isEnter && (this.mode === 'NORMAL' || this.mode === 'INSERT')) ||
      (isCtrlD &&
        (this.mode === 'INSERT' ||
          (this.mode === 'NORMAL' && this.getText().length === 0)))
    ) {
      super.handleInput(data);
      this.syncText(this.getText());
      return;
    }
    if (this.mode === 'INSERT' && matchesKey(data, 'shift+enter')) {
      super.handleInput('\n');
      this.syncText(this.getText());
      return;
    }
    this.processNvim(() => this.nvim.input(data));
  }

  private processNvim(f: () => Promise<boolean>) {
    const generation = this.snapshotGeneration;
    void this.enqueue(async () => {
      // Deferred APIs can block while Neovim is waiting for another key.
      // Skip the snapshot so the next queued key can complete the command.
      if (await f()) return;

      const snapshotted = await this.nvim.snapshot();
      if (generation !== this.snapshotGeneration) return;
      this.mode = snapshotted.mode;
      this.selection = snapshotted.selection;
      super.setText(snapshotted.text);
      this.moveCursorTo(snapshotted.line, snapshotted.col);
      this.tui.requestRender();
    });
  }

  private moveCursorTo(line: number, col: number) {
    const editor = this as unknown as {
      state: {lines: string[]; cursorLine: number; cursorCol: number};
      preferredVisualCol: number | null;
      snappedFromCursorCol: number | null;
    };
    editor.state.cursorLine = line;
    editor.state.cursorCol = utf8ByteOffsetToUtf16Index(
      editor.state.lines[line] ?? '',
      col,
    );
    editor.preferredVisualCol = null;
    editor.snappedFromCursorCol = null;
  }

  override render(width: number): string[] {
    // Resize Neovim if the Pi dimensions changed since the last render.
    if (width !== this.nvimWidth) {
      this.nvimWidth = width;
      void this.enqueue(async () => {
        const resized = await this.nvim.resize(width);
        if (!resized && this.nvimWidth === width) this.nvimWidth = 0;
      });
    }

    // The upstream editor renders a top border,
    // the visible wrapped text rows,
    // and a bottom border.
    // Any active autocomplete rows follow the bottom border.
    const lines = super.render(width).map(stripCursorHighlight);

    const selection = this.selection;
    if (selection && lines.length > 2) {
      const startLine = Math.min(selection.startLine, selection.endLine);
      const endLine = Math.max(selection.startLine, selection.endLine);
      for (let i = 1; i < lines.length - 1; i++) {
        const logicalLine = i - 1;
        if (logicalLine < startLine || logicalLine > endLine) continue;
        const line = lines[i]!;
        if (selection.kind === 'line') {
          lines[i] = `\x1b[7m${line}\x1b[27m`;
          continue;
        }
        const lineWidth = visibleWidth(line);
        const lineStart =
          selection.kind === 'block'
            ? selection.startCol
            : logicalLine === startLine
              ? selection.startCol
              : 0;
        const lineEnd =
          selection.kind === 'block'
            ? selection.endCol
            : logicalLine === endLine
              ? selection.endCol
              : lineWidth;
        lines[i] = highlightVisibleRange(line, lineStart, lineEnd);
      }
    }

    // Display the mode label in the bottom-right corner of the editor box.
    if (lines.length) {
      const label = ` ${this.mode} `;
      const i = lines.length - 1;
      if (visibleWidth(lines[i]!) >= label.length)
        lines[i] = truncateToWidth(lines[i]!, width - label.length, '') + label;
    }

    return lines;
  }

  dispose(restoreHardwareCursor = true) {
    if (restoreHardwareCursor)
      this.tui.setShowHardwareCursor(this.priorShowHardwareCursor);
    this.nvim.quit();
  }
}

export default function (pi: ExtensionAPI) {
  let editor: NvimEditor | undefined;
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    if (!hasNvim())
      return ctx.ui.notify(
        'pi-headless-neovim: nvim not found on PATH',
        'warning',
      );
    ctx.ui.setEditorComponent(
      (tui, theme, kb) =>
        (editor = new NvimEditor(tui, theme, kb, message =>
          ctx.ui.notify(message, 'warning'),
        )),
    );
  });
  pi.on('session_shutdown', (event, ctx) => {
    // On quit, Pi has already restored the terminal cursor before this handler runs.
    // Restoring a disabled hardware-cursor setting now would hide it again.
    editor?.dispose(event.reason !== 'quit');
    ctx.ui.setEditorComponent((editor = undefined));
  });
}
