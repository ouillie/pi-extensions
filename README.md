# pi-neovim

Tiny Pi extension that replaces the prompt editor with a `CustomEditor` backed by headless Neovim.

- Looks for `nvim` on `PATH`
- Uses `nvim --clean -n --headless --embed`
- Keeps Neovim as the source of truth for insert, normal, visual, visual-line, and visual-block behavior
- Disables `:` command-line entry in normal/visual modes
- Uses regular `Ctrl+v` (`\x16`) for visual block mode
- Mirrors terminal width changes into Neovim and lets Pi reflow rendering normally

## Use

```sh
npm install
pi -e ./index.ts
```

Or install/copy this package as a Pi package; `package.json` advertises `./index.ts` as the extension entry.
