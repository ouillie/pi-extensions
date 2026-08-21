import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { decodeMultiStream, encode } from "@msgpack/msgpack";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CURSOR_MARKER, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/** Return true if there is an invocable program called `nvim` on the PATH. */
function hasNvim() {
  return spawnSync("nvim", ["--version"], { stdio: "ignore" }).status === 0;
}

type Mode = "NORMAL" | "INSERT" | "VISUAL" | "V-LINE" | "V-BLOCK";
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
type VisualSelection = { kind: "char" | "line" | "block"; startLine: number; startCol: number; endLine: number; endCol: number };

function stripCursorHighlight(line: string): string {
  return line.replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/g, "$1");
}

function splitCursorMarker(line: string): { text: string; markerCol: number | null } {
  const markerIndex = line.indexOf(CURSOR_MARKER);
  if (markerIndex === -1) return { text: line, markerCol: null };
  return { text: line.replace(CURSOR_MARKER, ""), markerCol: visibleWidth(line.slice(0, markerIndex)) };
}

function restoreCursorMarker(line: string, markerCol: number | null): string {
  if (markerCol === null) return line;
  const width = visibleWidth(line);
  const col = Math.max(0, Math.min(markerCol, width));
  return `${sliceByColumn(line, 0, col)}${CURSOR_MARKER}${sliceByColumn(line, col, width - col)}`;
}

function highlightVisibleRange(line: string, startCol: number, endCol: number): string {
  const width = visibleWidth(line);
  const start = Math.max(0, Math.min(startCol, width));
  const end = Math.max(start, Math.min(endCol, width));
  if (start === end) return line;
  return `${sliceByColumn(line, 0, start)}\x1b[7m${sliceByColumn(line, start, end - start)}\x1b[27m${sliceByColumn(line, end, width - end)}`;
}

// Tmux surrounds pasted text with these CSI markers.
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

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
  for (let i = 0; i < text.length; ) {
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
function visualSelectionFromState(rawMode: string, startPos: unknown, cursorPos: unknown, startVirtCol: unknown, cursorVirtCol: unknown): VisualSelection | null {
  if (rawMode !== "v" && rawMode !== "V" && rawMode !== "\x16") return null;
  if (!Array.isArray(startPos) || !Array.isArray(cursorPos)) return null;

  const startLine = Math.max(0, ((startPos[1] as number | undefined) ?? 1) - 1);
  const endLine = Math.max(0, ((cursorPos[0] as number | undefined) ?? 1) - 1);

  if (rawMode === "V") {
    return { kind: "line", startLine: Math.min(startLine, endLine), startCol: 0, endLine: Math.max(startLine, endLine), endCol: Number.MAX_SAFE_INTEGER };
  }

  const startCol = Math.max(0, Math.min(((startVirtCol as number | undefined) ?? 1) - 1, ((cursorVirtCol as number | undefined) ?? 1) - 1));
  const endCol = Math.max(((startVirtCol as number | undefined) ?? 1), ((cursorVirtCol as number | undefined) ?? 1));

  if (rawMode === "\x16") {
    return { kind: "block", startLine: Math.min(startLine, endLine), startCol, endLine: Math.max(startLine, endLine), endCol };
  }

  return { kind: "char", startLine: Math.min(startLine, endLine), startCol, endLine: Math.max(startLine, endLine), endCol };
}

class Nvim {
  private process: ChildProcessWithoutNullStreams;
  private id = 1;
  private pending = new Map<number, Pending>();
  ready: Promise<void>;

  constructor() {
    this.process = spawn("nvim", ["--clean", "-n", "--headless", "--embed"], { stdio: "pipe" });
    void this.readLoop();
    this.process.stderr.on("data", () => {});
    this.process.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("nvim exited"));
      this.pending.clear();
    });
    this.ready = this.init();
  }

  private async readLoop() {
    for await (const msg of decodeMultiStream(this.process.stdout as AsyncIterable<Uint8Array>)) this.onMsg(msg);
  }

  private onMsg(msg: unknown) {
    if (!Array.isArray(msg) || msg[0] !== 1) return;
    const p = this.pending.get(msg[1]);
    if (!p) return;
    this.pending.delete(msg[1]);
    msg[2] ? p.reject(new Error(String(msg[2]))) : p.resolve(msg[3]);
  }

  call(method: string, args: unknown[] = []) {
    const id = this.id++;
    this.process.stdin.write(encode([0, id, method, args]));
    return new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async init() {
    await this.call("nvim_command", ["set noswapfile undofile& viminfo= shada= virtualedit=block selection=inclusive"]);
    await this.call("nvim_command", ["enew"]);
    await this.call("nvim_command", ["startinsert!"]);
  }

  async setText(text: string) {
    const lines = text.split("\n");
    await this.ready;
    // Cancel any command synchronously waiting for another key before using
    // deferred APIs. This also makes externally replacing the prompt safe.
    await this.call("nvim_input", ["\x1b"]);
    await this.call("nvim_buf_set_lines", [0, 0, -1, true, lines]);
    await this.call("nvim_win_set_cursor", [0, [Math.max(1, lines.length), (lines.at(-1) ?? "").length]]);
    await this.call("nvim_command", ["startinsert!"]);
  }

  async input(data: string) {
    await this.ready;
    if (matchesKey(data, "backspace")) data = "<BS>";
    else if (matchesKey(data, "delete")) data = "<Del>";
    else if (matchesKey(data, "up")) data = "<Up>";
    else if (matchesKey(data, "down")) data = "<Down>";
    else if (matchesKey(data, "left")) data = "<Left>";
    else if (matchesKey(data, "right")) data = "<Right>";
    else if (matchesKey(data, "home")) data = "<Home>";
    else if (matchesKey(data, "end")) data = "<End>";
    else if (matchesKey(data, "pageUp")) data = "<PageUp>";
    else if (matchesKey(data, "pageDown")) data = "<PageDown>";
    else if (matchesKey(data, "ctrl+v")) data = "\x16";
    await this.call("nvim_input", [data]);
  }

  async paste(text: string) {
    await this.ready;
    await this.call("nvim_paste", [text, false, -1]);
  }

  async resize(width: number) {
    await this.ready;
    await this.call("nvim_set_option_value", ["columns", Math.max(20, width), {}]);
  }

  async snapshot() {
    const [lines, cur, mode, visualStart, visualVirtCol, cursorVirtCol] = await Promise.all([
      this.call("nvim_buf_get_lines", [0, 0, -1, true]),
      this.call("nvim_win_get_cursor", [0]),
      this.call("nvim_get_mode", []),
      this.call("nvim_eval", ["getpos('v')"]),
      this.call("nvim_eval", ["virtcol('v')"]),
      this.call("nvim_eval", ["virtcol('.')"]),
    ]);
    const rawMode = String((mode as { mode: string }).mode);
    const text = (lines as string[]).join("\n");
    return {
      text,
      line: ((cur as number[])[0] ?? 1) - 1,
      col: (cur as number[])[1] ?? 0,
      mode: modeName(rawMode),
      selection: visualSelectionFromState(rawMode, visualStart, cur, visualVirtCol, cursorVirtCol),
    };
  }

  quit() {
    this.call("nvim_command", ["qa!"]).catch(() => {});
  }
}

function modeName(m: string): Mode {
  if (m === "i" || m === "ic" || m === "ix") return "INSERT";
  if (m === "v") return "VISUAL";
  if (m === "V") return "V-LINE";
  if (m === "\x16") return "V-BLOCK";
  return "NORMAL";
}

export class NvimEditor extends CustomEditor {
  private mode: Mode = "INSERT";
  private selection: VisualSelection | null = null;
  private nvim = new Nvim();
  private queue = Promise.resolve();
  // Serialize input delivery, but never put snapshots in this queue: Neovim
  // may need a later key before its deferred snapshot APIs can run.
  private nvimQueue = Promise.resolve();
  private revision = 0;
  private nvimWidth = 0;
  private isPasting = false;
  private nvimPasteBuffer = "";

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    this.onPasteImage = () => this.handleInput("\x16");
    void this.enqueueNvim(() => this.nvim.setText(this.getText())).catch(() => {});
  }

  private enqueueNvim<T>(action: () => Promise<T>): Promise<T> {
    const result = this.nvimQueue.then(action);
    this.nvimQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private syncText(text: string) {
    this.revision++;
    void this.enqueueNvim(() => this.nvim.setText(text)).catch(() => {});
  }

  override setText(text: string): void {
    super.setText(text);
    this.selection = null;
    this.syncText(text);
  }

  override handleInput(data: string): void {
    if (data.includes(BRACKETED_PASTE_START)) {
      this.isPasting = true;
      this.nvimPasteBuffer = "";
      data = data.replaceAll(BRACKETED_PASTE_START, "");
    }
    if (this.isPasting) {
      this.nvimPasteBuffer += data;
      const endIndex = this.nvimPasteBuffer.indexOf(BRACKETED_PASTE_END);
      if (endIndex === -1) return;
      const pasteText = this.nvimPasteBuffer.slice(0, endIndex);
      const remaining = this.nvimPasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
      this.isPasting = false;
      this.nvimPasteBuffer = "";
      if (pasteText.length > 0) {
        const revision = this.revision;
        const snapshot = this.enqueueNvim(() => this.nvim.paste(pasteText)).then(() => this.nvim.snapshot());
        this.queue = this.queue.then(async () => {
          const state = await snapshot;
          if (revision === this.revision) this.apply(state);
        }).catch(() => {});
      }
      if (remaining.length > 0) this.handleInput(remaining);
      return;
    }
    if (this.mode === "INSERT") {
      const isInsertNewline = matchesKey(data, "shift+enter");
      if (isInsertNewline || matchesKey(data, "enter") || matchesKey(data, "ctrl+d")) {
        super.handleInput(isInsertNewline ? "\n" : data);
        this.syncText(this.getText());
        return;
      }
    } else if (data === ":") {
      // Ignore Ex commands.
      return;
    }
    const revision = this.revision;
    const snapshot = this.enqueueNvim(() => this.nvim.input(data)).then(() => this.nvim.snapshot());
    this.queue = this.queue.then(async () => {
      const state = await snapshot;
      if (revision === this.revision) this.apply(state);
    }).catch(() => {});
  }

  private apply(s: { text: string; line: number; col: number; mode: Mode; selection: VisualSelection | null }) {
    this.mode = s.mode;
    this.selection = s.selection;
    super.setText(s.text);
    this.moveCursorTo(s.line, s.col);
    this.tui.requestRender();
  }

  private moveCursorTo(line: number, col: number) {
    const editor = this as unknown as {
      state: { lines: string[]; cursorLine: number; cursorCol: number };
      preferredVisualCol: number | null;
      snappedFromCursorCol: number | null;
    };
    editor.state.cursorLine = line;
    editor.state.cursorCol = utf8ByteOffsetToUtf16Index(editor.state.lines[line] ?? "", col);
    editor.preferredVisualCol = null;
    editor.snappedFromCursorCol = null;
  }

  override render(width: number): string[] {
    if (width !== this.nvimWidth) {
      this.nvimWidth = width;
      this.queue = this.queue.then(() => this.nvim.resize(width)).catch(() => {});
    }
    const lines = super.render(width);
    const selection = this.selection;
    if (selection && lines.length > 2) {
      const startLine = Math.min(selection.startLine, selection.endLine);
      const endLine = Math.max(selection.startLine, selection.endLine);
      for (let i = 1; i < lines.length - 1; i++) {
        const logicalLine = i - 1;
        if (logicalLine < startLine || logicalLine > endLine) continue;
        const stripped = stripCursorHighlight(lines[i]!);
        const { text: line, markerCol } = splitCursorMarker(stripped);
        if (selection.kind === "line") {
          lines[i] = restoreCursorMarker(`\x1b[7m${line}\x1b[27m`, markerCol);
          continue;
        }
        const lineWidth = visibleWidth(line);
        const lineStart = selection.kind === "block" ? selection.startCol : logicalLine === startLine ? selection.startCol : 0;
        const lineEnd = selection.kind === "block" ? selection.endCol : logicalLine === endLine ? selection.endCol : lineWidth;
        lines[i] = restoreCursorMarker(highlightVisibleRange(line, lineStart, lineEnd), markerCol);
      }
    }
    if (lines.length) {
      const label = ` ${this.mode} `;
      const i = lines.length - 1;
      if (visibleWidth(lines[i]!) >= label.length) lines[i] = truncateToWidth(lines[i]!, width - label.length, "") + label;
    }
    return lines;
  }

  dispose() { this.nvim.quit(); }
}

export default function (pi: ExtensionAPI) {
  let editor: NvimEditor | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (!hasNvim()) return ctx.ui.notify("pi-neovim: nvim not found on PATH", "warning");
    ctx.ui.setEditorComponent((tui, theme, kb) => (editor = new NvimEditor(tui, theme, kb)));
  });
  pi.on("session_shutdown", (_event, ctx) => {
    editor?.dispose();
    editor = undefined;
    ctx.ui.setEditorComponent(undefined);
  });
}
