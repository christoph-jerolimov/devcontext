# Digest

```bash
devcontext digest                      # the last week
devcontext digest --since 1d           # yesterday, for a standup
devcontext digest --since 1w -o markdown | pbcopy
devcontext digest --person alice       # just what one person did
devcontext digest --since 2w --no-stale
```

`insights` answers "how are we doing"; `digest` answers "what happened". It is
the report you read every morning, not the one you open when something feels
wrong — so it is short, ordered by what matters, and `-o markdown` is shaped to
be pasted straight into a standup note or a weekly update.

Everything comes from the local database, so it works offline and costs no API
calls. It is also available in the web viewer under **Digest** and as JSON
through `GET /api/digest`.

## What it reports

| Section         | Contents                                                                 |
| --------------- | ------------------------------------------------------------------------ |
| Summary         | Counts for everything below, so a quiet week is one glance               |
| Merged          | Pull requests merged in the window, credited to whoever merged them      |
| Finished        | Work items that moved into a done status in the window                   |
| Opened, Started | Pull requests opened, work items picked up                               |
| Issues          | Issues opened and closed                                                 |
| People          | Per person: merged, opened, reviews, work items finished, comments       |
| Failed runs     | Workflow runs that failed, with their branch                             |
| Still in flight | Work items in progress, open pull requests, drafts — the state right now |
| Still waiting   | Open work untouched since `--stale-after` (default 30 days)              |

## Windows

`--since` and `--until` accept the same expressions as the rest of the CLI:
`1w`, `3d`, `36h`, or an absolute date such as `2026-07-01`.

The window is half open — `>= since` and `< until` — so consecutive digests
tile without repeating an item on the boundary. That matters when the command
is run on a schedule: `--since 1w` every Monday reports each merge exactly
once.

## Started and finished

Both are read from the Jira **changelog**, not from the item's current status.
A ticket that was started this week and finished next week appears under
_Started_ this week and under _Finished_ next week — which is what a weekly
update should say. Reading the current status instead would silently drop the
first half.

Reopened work is handled the same way: the digest reports the move that
happened inside the window, so an item finished on Tuesday and reopened a
fortnight later still counts as finished on Tuesday.

An item that changed status several times inside one window is listed once,
with its latest move.

## Options

| Option                     | Description                                             |
| -------------------------- | ------------------------------------------------------- |
| `--since <when>`           | Start of the window (default `1w`)                      |
| `--until <when>`           | End of the window; defaults to now                      |
| `-r, --repo <repo>`        | Restrict to a GitHub repository, repeatable             |
| `-p, --project <key>`      | Restrict to a Jira project, repeatable                  |
| `--person <name>`          | Only activity by this person, repeatable                |
| `--stale-after <duration>` | Age at which open work counts as stale (default `30d`)  |
| `--no-stale`               | Skip the stale section                                  |
| `-n, --limit <count>`      | Rows per section (default 10); the counts stay complete |

`--limit` only trims the lists. The summary counts and the per person table are
always computed over everything in the window, so a capped section never makes
a busy week look quiet.

`--list` prints every reference the digest mentions, one per line, which pipes
into a script that wants to act on the week's work.

## Automating it

```bash
# Monday morning, into a file the team reads
devcontext sync && devcontext digest --since 1w -o markdown > weekly.md
```

Sync first: the digest reads only what is already in the database.
