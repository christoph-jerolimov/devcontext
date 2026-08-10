# Terminal viewer

```bash
npm run tui
# or, once built:
node tui/bin/devcontext-tui.js [--config <path>] [--db <path>]
```

The same views as the [web viewer](web.md), in the same order, without a
browser. It reads the local database **directly** — a terminal can open a file
where a browser cannot — so there is no server, no port and nothing to leave
running.

| Key            | Does                                |
| -------------- | ----------------------------------- |
| `1`–`9`, `tab` | switch view                         |
| `↑` `↓`        | move the selection                  |
| `page up/down` | move ten at a time                  |
| `enter`        | open the selected item              |
| `s`            | sync the opened item, right now     |
| `/`            | filter the list                     |
| `esc`          | close the item, or clear the filter |
| `q`            | quit                                |

The status line at the bottom shows the rate limit budget the last sync
observed (`rate: GitHub (github.com) 4321 left`) — the same numbers
`devcontext status` and the web viewer's sidebar show, read from the shared
database.

`s` runs the same targeted sync as `devcontext sync --only <ref>`, in this
process, for the issue, pull request or work item that is open — and the view
re-reads the database when it finishes, so the fresh comments and state are on
screen without reopening anything. It works on the items a targeted sync can
name; a workflow run or a sprint has no such reference and offers no key.

## The views

Overview, GitHub issues, Pull requests, Workflow runs, Jira work items,
Sprints, Insights and Digest are the web viewer's, deliberately in the same
order — two front ends that disagree about what exists are two things to learn.

**History** is the one the web viewer does not have yet: the number of open
items per day over the last month, as a bar per row. A terminal is a good place
for it — the shape of a month is what the question is actually about, and a bar
made of block characters needs no chart library. See [History](history.md).

## What it is not

It is a **viewer**, like the web one. It opens the database read-only and has
no way to sync, write or delete. Everything it shows comes from a `devcontext
sync` you ran yourself.

Markdown bodies are not rendered — issue and work item detail panes show the
title, the state and the URL rather than a formatted body. The web viewer is
still the better place to read a long description.

## Two things worth knowing if you change it

**React must not be duplicated.** Ink passes its state through React context,
so a second copy of React under `tui/node_modules` makes every component render
nothing at all — no error, no stack, just a blank frame. Keep the version
aligned with the root and let npm hoist one copy.

**Ink trims trailing whitespace off every text node.** A column separator
written onto the end of a cell disappears and the columns run into each other.
The space between columns is therefore a layout margin, not a character.
