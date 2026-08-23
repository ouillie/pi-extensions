# Headless Neovim for Pi

Tiny [Pi] extension that replaces the prompt editor with a `CustomEditor`
backed by headless [Neovim].

- Looks for `nvim` on `PATH`.
- Ignores `:` (Ex commands are disabled).
- From normal mode, `Ctrl+v` enters visual block mode.
  From insert mode, `Ctrl+v` can be used to paste images as normal.

[Pi]: https://pi.dev/
[Neovim]: https://neovim.io/

## Use

[Install Neovim](https://neovim.io/doc/install/)
and make sure the `nvim` binary is available on your `PATH`.

```sh
pnpm install
pi install .
```
