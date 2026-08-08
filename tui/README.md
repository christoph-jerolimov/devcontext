# @devcontext/tui

The devcontext viewer, in the terminal.

```bash
npm run build
node tui/bin/devcontext-tui.js            # or: npm run tui
```

Same views as the web viewer, in the same order, reading the same local
database — directly, since a terminal can open a file and a browser cannot, so
there is no server and no port to pick.

| Key            | Does                                |
| -------------- | ----------------------------------- |
| `1`–`9`, `tab` | switch view                         |
| `↑` `↓`        | move the selection                  |
| `page up/down` | move ten at a time                  |
| `enter`        | open the selected item              |
| `/`            | filter the list                     |
| `esc`          | close the item, or clear the filter |
| `q`            | quit                                |

`--config <path>` and `--db <path>` work as they do on the CLI.

## Two things worth knowing if you change it

**React must not be duplicated.** Ink passes its state through React context, so
a second copy of React in `tui/node_modules` makes every component render
nothing at all — no error, just a blank frame. Keep the version aligned with
the root.

**Ink trims trailing whitespace off every text node.** A column separator
written onto the end of a cell disappears and the columns run together, which
is why the space between them is a layout margin instead.
