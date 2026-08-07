# Sync

```bash
devcontext sync [options]
```

One `sync` run walks every configured project, and inside a project every
GitHub repository and every Jira project. Each of those targets is one _run_ in
the database, and every resource inside a target (issues, pull requests,
workflow runs, work items, sprints) is one _operation_.

## Initial and incremental syncs

The first sync of a target is an **initial sync**: it downloads everything the
configuration asks for, bounded by `since` if you set one.

Every operation stores a cursor when it finishes — usually the newest
`updated_at` it saw. The next run reads that cursor and asks the API only for
changes:

| Resource                          | Cursor              | How it is used                                                                                                   |
| --------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| GitHub issues (and pull requests) | newest `updated_at` | `GET /issues?since=<cursor>&sort=updated&direction=asc`                                                          |
| GitHub workflow runs              | newest `created_at` | `GET /actions/runs?created=>=<cursor>`, stops as soon as older runs appear                                       |
| Jira work items                   | newest `updated`    | `... AND updated >= "<cursor>"`, rewound by five minutes because JQL resolves to minutes in the server time zone |

Anything the API returns again is simply written again, so re-fetching the
boundary item is harmless.

`--full` ignores the stored cursors and downloads everything a second time.
Use it after changing the sync flags of a repository, or when you suspect a gap.

## What is stored

### GitHub

- the repository, its labels and milestones
- every issue with author, assignees, labels, milestone and body
- every comment of every issue and pull request
- the **complete timeline** of each issue and pull request as one row per event:
  labeled, unlabeled, assigned, unassigned, closed, reopened, renamed (with the
  old and the new title), referenced, cross-referenced, review requested, merged,
  head ref force-pushed, …
- every pull request with additions, deletions, changed files, merge state and
  merge commit
- every review with its verdict and body, and every inline review comment with
  its diff hunk, path and line
- the commit list of every pull request
- the changed files including their patch
- workflows, workflow runs, jobs and every step of every job
- optionally the complete log of every job (`workflowLogs: true`)

### Jira

- the project and the full field catalogue, including your friendly names
- every work item matching the project and the optional JQL filter, with the
  description converted to markdown — from Atlassian Document Format on Jira
  Cloud (REST API v3) and from wiki markup on Data Center and Server (v2), so
  the database holds one format whichever site you sync
- every comment
- the **complete history** as one row per changed field, so "when did this move
  to In Progress", "who removed that label" and "which sprint did it slip out
  of" are plain SQL questions
- issue links and attachment metadata
- boards, sprints and the sprint membership of every work item
- optionally work logs

Every row also keeps the untouched API payload in its `raw` column.

### After the fetch

Two passes run over what was just written, both entirely local:

- the **cross reference** table is rebuilt, so the documents carry their links
  (see [links.md](links.md));
- the **search index** is updated (see [search.md](search.md)). A full sync
  rebuilds it; an incremental sync only reindexes the items it wrote, so a
  three ticket sync stays fast on a large database.

## Rate limits and pacing

Every API call goes through a rate limiter that

- keeps at least `sync.minDelayMs` between two calls (default 250 ms),
- reads `x-ratelimit-remaining` / `x-ratelimit-reset` and pauses until the
  window resets once fewer than `sync.rateLimitReserve` calls are left,
- honours `Retry-After` on 429 and on GitHub's secondary rate limits,
- retries 408/425/429/5xx and network errors with exponential backoff
  (`retryBaseMs`, doubling, capped at one minute, `maxRetries` times).

```bash
devcontext sync --delay 1000     # at most one API call per second
```

Set `respectRateLimit: false` only if a proxy in front of the API strips the
rate limit headers.

## Progress

```
[##########--------------]  42% | 615/1442 calls | 388 items | 3m 12s elapsed | ~4m 20s left | acme/platform: pull requests
```

The total is worked out **before anything is fetched**. Every target is sized
first, in a planning pass that logs what it found:

```
Planned 2 target(s): about 1440 API call(s).
```

Sizing is cheap. Asked for one item per page, a GitHub list endpoint reports
the number of the last page in its `Link` header — and with one item per page,
that number _is_ the item count. So one request per collection buys an exact
count, and every follow up call an item implies (comments, timeline, reviews,
commits, files) is known from the configuration. Jira is easier still: a search
reports how many work items match the JQL.

Two things stay unknowable until the work is under way, and only these are
still discovered as the sync runs: how many jobs a workflow run has, and how
many sprints hang off a board. Both are small, so the percentage and the
estimated time are meaningful from the first call rather than only near the
end.

The syncers replace the planned figure for their part of the work with the real
one as they go, so a plan that guessed high or low is corrected rather than
compounded. A target that cannot be sized — an endpoint that will not report a
total — simply falls back to being discovered while it is fetched.

Outside a terminal (CI, `| tee`) the progress line is not redrawn; a summary
line is logged every 10 % instead. `--no-progress` turns it off completely.

## Where a sync is recorded

Everything lands in the database:

```sql
-- one row per target and run
SELECT id, source, target, mode, status, api_calls, items_synced, duration_ms
  FROM sync_runs ORDER BY started_at DESC LIMIT 10;

-- one row per resource inside a run
SELECT resource, status, api_calls, items_synced, cursor_before, cursor_after
  FROM sync_operations WHERE run_id = 42;

-- where the next incremental sync continues
SELECT scope, cursor, updated_at FROM sync_state ORDER BY scope;
```

`devcontext status` shows the same information without SQL.

A run that never finished (because the process was killed) is marked
`interrupted` at the start of the next sync. Since every operation commits its
cursor when it completes, an interrupted sync only repeats the resource it was
working on.

## Options

| Option                        | Description                                                         |
| ----------------------------- | ------------------------------------------------------------------- |
| `-p, --project <key>`         | Only this project, repeatable                                       |
| `-s, --source <github\|jira>` | Only this source, repeatable                                        |
| `-t, --target <name>`         | Only this repository (`owner/name`) or Jira project key, repeatable |
| `--full`                      | Ignore the stored cursors                                           |
| `--dry-run`                   | Talk to the APIs, write nothing (the run is still recorded)         |
| `--delay <ms>`                | Override `sync.minDelayMs`                                          |
| `--no-progress`               | No progress indicator                                               |
| `--no-outputs`                | Skip the yaml / markdown / json mirrors                             |
| `-o, --output <format>`       | Format of the summary table                                         |

The exit code is non-zero when at least one target failed; targets that
succeeded keep their data and their cursor.

## Scheduling

devcontext has no daemon; use whatever scheduler you already have.

```cron
*/30 * * * * cd /home/me/work && /usr/local/bin/devcontext sync --quiet
```
