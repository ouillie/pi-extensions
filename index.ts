import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { decodeMultiStream, encode } from "@msgpack/msgpack";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { matchesKey, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

function hasNvim() {
  return spawnSync("nvim", ["--version"], { stdio: "ignore" }).status === 0;
}

type Mode = "NORMAL" | "INSERT" | "VISUAL" | "V-LINE" | "V-BLOCK";
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

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
    await this.call("nvim_buf_set_lines", [0, 0, -1, true, lines]);
    await this.call("nvim_win_set_cursor", [0, [Math.max(1, lines.length), (lines.at(-1) ?? "").length]]);
    await this.call("nvim_command", ["startinsert!"]);
  }

  async input(data: string) {
    await this.ready;
    if (matchesKey(data, "backspace")) data = "<BS>";
    if (matchesKey(data, "delete")) data = "<Del>";
    await this.call("nvim_input", [data]);
    return this.snapshot();
  }

  async resize(width: number) {
    await this.ready;
    await this.call("nvim_set_option_value", ["columns", Math.max(20, width), {}]);
  }

  async snapshot() {
    const [lines, cur, mode] = await Promise.all([
      this.call("nvim_buf_get_lines", [0, 0, -1, true]),
      this.call("nvim_win_get_cursor", [0]),
      this.call("nvim_get_mode", []),
    ]);
    return {
      text: (lines as string[]).join("\n"),
      line: ((cur as number[])[0] ?? 1) - 1,
      col: (cur as number[])[1] ?? 0,
      mode: modeName(String((mode as { mode: string }).mode)),
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

class NvimEditor extends CustomEditor {
  private mode: Mode = "INSERT";
  private nvim = new Nvim();
  private queue = Promise.resolve();
  private nvimWidth = 0;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    void this.nvim.setText(this.getText());
  }

  override setText(text: string): void {
    super.setText(text);
    this.queue = this.queue.then(() => this.nvim.setText(text)).catch(() => {});
  }

  override handleInput(data: string): void {
    if (this.mode === "INSERT" && (matchesKey(data, "enter") || matchesKey(data, "ctrl+d"))) {
      super.handleInput(data);
      this.queue = this.queue.then(() => this.nvim.setText(this.getText())).catch(() => {});
      return;
    }
    if (this.mode !== "INSERT" && data === ":") return;
    this.queue = this.queue.then(async () => this.apply(await this.nvim.input(data))).catch(() => {});
  }

  private apply(s: { text: string; line: number; col: number; mode: Mode }) {
    this.mode = s.mode;
    super.setText(s.text);
    this.moveCursorTo(s.line, s.col);
    this.tui.requestRender();
  }

  private moveCursorTo(line: number, col: number) {
    super.handleInput("\x01");
    for (let i = 0; i < line; i++) super.handleInput("\x1b[B");
    super.handleInput("\x01");
    for (let i = 0; i < col; i++) super.handleInput("\x1b[C");
  }

  override render(width: number): string[] {
    if (width !== this.nvimWidth) {
      this.nvimWidth = width;
      this.queue = this.queue.then(() => this.nvim.resize(width)).catch(() => {});
    }
    const lines = super.render(width);
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
