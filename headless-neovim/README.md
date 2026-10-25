# Headless Neovim for Pi

Tiny [Pi] extension that replaces the prompt editor with a `CustomEditor`
backed by headless [Neovim].

- Looks for `nvim` on `PATH`.
- Double-tap `Esc` to send a single `Esc` to Pi
  (single-tap enters normal mode).
- Ex commands and searches are disabled
  (ignores `:`, `/`, and `?` in normal mode).
- From normal mode, `Ctrl+v` enters visual block mode as normal in Vim.
  From insert mode, `Ctrl+v` can be used to paste images as normal in Pi.

[Pi]: https://pi.dev/
[Neovim]: https://neovim.io/

## Use

First, [install Neovim](https://neovim.io/doc/install/)
and make sure the `nvim` binary is available on your `PATH`.

Then, install this extension from source:

```sh
pnpm install
pi install .
```
