# Search

```bash
devcontext search "rate limit"          # everything mentioning both words
devcontext search PLAT-42               # the ticket, and whatever references it
devcontext search "reset header"        # an exact phrase
devcontext search flak --kind workitem  # prefix match, work items only
devcontext search "rate limit" --list   # just the references, for a script
```

One search covers GitHub issues, pull requests and Jira work items **together
with their comments and reviews**, ranked by relevance. It reads the local
database, so it works offline and costs no API calls, and it is the same query
behind the web viewer, `GET /api/search` and the MCP `search` tool.

## What a result is

A result is an **item**, not a fragment. Comments and reviews are indexed with
the issue or work item they belong to, so a phrase that only appears in the
fortieth comment still returns the ticket — once — with the matching text shown
next to it.

Ranking is weighted by where the match is: the reference, then the title, then
labels and people, then the body, and last the comments. A title hit therefore
beats a hit buried in a long thread.

## Query syntax

| You type       | It means                                              |
| -------------- | ----------------------------------------------------- |
| `rate limit`   | Both words, anywhere in the item                      |
| `"rate limit"` | That exact phrase                                     |
| `PLAT-42`      | The literal text, dash and all                        |
| `flak`         | A prefix — the last word matches `flaky`, `flakiness` |
| `flak --exact` | No prefix matching                                    |

The last word is a prefix by default so results appear while you type. Quote a
word to match it exactly, or pass `--exact`.

Punctuation is not an operator here. `PLAT-42`, `customfield_10016` and
`fix/limiter` are searched as the text you typed, not read as "PLAT **not**
42".

## Options

| Option                | Description                                       |
| --------------------- | ------------------------------------------------- |
| `-k, --kind <kind>`   | `issue`, `pull-request` or `workitem`, repeatable |
| `-r, --repo <repo>`   | Restrict to a GitHub repository, repeatable       |
| `-p, --project <key>` | Restrict to a Jira project, repeatable            |
| `--exact`             | Do not treat the last word as a prefix            |
| `-n, --limit <count>` | Maximum hits (default 25)                         |
| `--offset <count>`    | Skip this many hits                               |
| `--rebuild`           | Rebuild the index and exit                        |

## The index

Search goes through an SQLite FTS5 index that `devcontext sync` maintains, so
the cost of a query is proportional to the number of **matches**, not to the
size of the database.

Measured on a synthetic database of 120 000 issues with 600 000 comments:

| Query                        | Through the index | Scanning |
| ---------------------------- | ----------------: | -------: |
| Rare word, one hit           |            0.2 ms |   583 ms |
| Word appearing in every item |            146 ms |   472 ms |

The rare case is the one that matters: it stays flat as the database grows,
while a scan does not.

**Keeping it current.** A full sync rebuilds the index. An incremental sync
reindexes only what it wrote — an item counts as changed when its own row was
written or one of its comments or reviews was. On the database above, a sync
that touched three issues costs about 0.45 s to reindex, against 25 s for a
full rebuild.

**Rebuilding by hand.** `devcontext search --rebuild` does the full pass.
Reach for it after deleting rows by hand, or if you ever suspect the index has
drifted from the tables.

## Without FTS5

FTS5 is a compile time option in SQLite. If your Node build lacks it,
devcontext says so once and scans the tables instead: the same results in the
same shape, only slower and without the ranking and the matching text. Nothing
else changes, and no command fails.

The same fallback covers a database that has not been synced since the index
was introduced — the rows are there, the index is empty, and scanning answers
correctly until the next sync fills it in.
