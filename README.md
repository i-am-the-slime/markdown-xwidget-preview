# markdown-xwidget-preview

Emacs xwidget Markdown preview backed by a bundled Vite/React renderer.

## Requirements

- Emacs built with `xwidget-webkit`
- `markdown-mode`
- `bun`

Commercial font files are not included. The renderer will use installed/local
fonts when available and fall back otherwise. Optional local font files can be
placed in `preview/public/fonts/`.

## Install

```elisp
(add-to-list 'load-path "~/Developer/markdown-xwidget-preview/elisp")
(require 'markdown-xwidget-preview)
(markdown-xwidget-preview-setup)
```

Doom users can use:

```elisp
(load-file "~/Developer/markdown-xwidget-preview/elisp/markdown-xwidget-preview.el")
(markdown-xwidget-preview-setup)
```

Run once:

```sh
cd ~/Developer/markdown-xwidget-preview/preview
bun install
```

## Use

In a Markdown buffer:

- `C-c C-p` open preview beside the source buffer
- `C-c C-r` reload preview
- `C-c C-R` restart preview server
- `C-c C-s` start preview server
- `C-c C-k` stop preview server

With Doom localleader bindings installed by `markdown-xwidget-preview-setup`:

- `SPC m p` open preview
- `SPC m r` reload
- `SPC m R` restart server
- `SPC m s` start server
- `SPC m k` stop server

The server starts on demand from the bundled `preview/` directory and the current buffer contents are streamed into the preview, including unsaved edits.

Generated Vite artifacts are cleaned automatically before server start and after preview buffer close:

- `preview/dist`
- `preview/.vite`
- `preview/node_modules/.vite`
- `preview/*.log`

## Configure

```elisp
(setq markdown-xwidget-preview-url "http://127.0.0.1:5173/")
(setq markdown-xwidget-preview-command '("bun" "dev"))
(setq markdown-xwidget-preview-clean-artifacts-on-start t)
(setq markdown-xwidget-preview-clean-artifacts-on-preview-kill t)
```

The preview app root is inferred from the Elisp file location. Override if needed:

```elisp
(setq markdown-xwidget-preview-project-root "/path/to/markdown-xwidget-preview/preview")
```
