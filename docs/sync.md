# Sync

```bash
devcontext sync [options]
```

One `sync` run walks every configured project, and inside a project every
GitHub repository and every Jira project. Each of those targets is one _run_ in
the database, and every resource inside a target (issues, pull requests,
workflow runs, work items, sprints) is one _operation_.

## The three phases

A run does not finish one repository before starting the next. It goes through
all of them three times, and every target completes a phase before any target
begins the next one:

| Phase       | What it fetches                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| **lists**   | Every collection: issue pages, workflow run pages, Jira search pages, labels, milestones, workflows, boards |
| **items**   | The individual things a list only named: the detailed pull request payload, the sprints of each board       |
| **details** | What hangs off one item: comments, timelines, reviews, changed files, the jobs of a run, sprint membership  |

The split is by **how the data is reached**, not by what it is. A list page
already carries the issue itself, its labels and its assignees, so those are
written in the first phase and cost nothing extra. A Jira search usually
carries the comments and the history too — the ones it truncates are the only
ones that owe a request later.

The reason for the order is that **the second and third phases are the
expensive ones, and only the first can tell you how expensive.** A repository's
issue count can be probed up front, but how many of those issues are pull
requests, how many runs survive `maxWorkflowRuns`, and how many sprints hang
off a board cannot. Once the lists are in, all of that is known exactly, so the
remaining work is priced rather than guessed and the estimate stops climbing.

Cursors move at the end of the last phase a resource takes part in, never
earlier. A cursor written after the list phase would claim issues are synced
whose comments had not been fetched yet, and nothing would ever go back for
them. A target that fails drops out and the rest carry on.

## Initial and incremental syncs

The first sync of a target is an **initial sync**: it downloads everything the
configuration asks for, bounded by `since` if you set one.

Every operation stores a cursor when it finishes — usually the newest
`updated_at` it saw. The next run reads that cursor and asks the API only for
changes:

| Resource                          | Cursor              | How it is used                                                                                                   |
| --------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| GitHub issues (and pull requests) | newest `updated_at` | decides which items get their comments and timeline; the list itself is always complete                          |
| GitHub workflow runs              | newest `created_at` | `GET /actions/runs?created=>=<cursor>`, stops as soon as older runs appear                                       |
| Jira work items                   | newest `updated`    | `... AND updated >= "<cursor>"`, rewound by five minutes because JQL resolves to minutes in the server time zone |

Anything the API returns again is simply written again, so re-fetching the
boundary item is harmless.

### What `since` does and does not bound

It bounds the **requests made per item**, not the list.

Every issue, pull request and work item is listed on every run, whatever the
cursor says. That is not thoroughness for its own sake: how many issues were
open in March cannot be answered from the ones that changed since March. The
balance carried in from before is exactly the part that would be missing, and
no amount of later syncing recovers it — see [History](history.md).

The list is also the cheap half. A repository with 20,000 issues is 200 list
pages against 40,000 comment and timeline calls, so a complete walk costs about
half a percent more and the run gets no slower.

### How an item is judged worth a request

Inside that window, each listed item is compared against the copy already
stored. It is fetched again when one of these is true:

- it has **never been stored**, or the details phase never reached it (an
  interrupted run leaves the row without them);
- its `updated_at` is **newer** than the stored one — it genuinely moved;
- it is **missing a resource that is wanted now**.

The last one is why the database records which per-item resources each item has.
Turning on a resource that was off — `issueTimeline: false` to `true` — leaves
every item that has not been touched since looking perfectly current, and
without that record none of them would ever get a timeline. Not on the next
sync, not ever, and nothing would say so: the run reports success, the rows are
all there, and only the history built from those timelines is quietly flat.

Every one of those tests errs towards fetching, because the two mistakes are
not equally bad. Fetching something already current costs one request. Skipping
something stale leaves a wrong answer in the database with nothing to indicate
it.

Upgrading an existing database does not trigger a re-download: what was already
fetched is inferred per repository from what the tables hold, so only genuinely
missing resources are collected.

`--full` ignores all of this and downloads everything a second time. It used to
be the only way out of the situation above; it is now a blunt instrument for
when you suspect a gap the rules cannot see.

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

## Stopping and resuming

Ctrl-C asks the sync to stop rather than killing it. The requests in flight
finish, the run is recorded as **interrupted**, and you are told what was done.
A second Ctrl-C exits immediately — a slow API should not be able to hold you
there.

Nothing is lost either way: every write is an upsert, and a cursor only moves
when a resource finishes. Stopping in the middle of the comments of one issue
leaves the issue cursor exactly where it was, so the next run covers the whole
window again.

```bash
devcontext sync --resume
```

`--resume` skips what the last **failed or interrupted** run finished. A
resource is skipped only when its operation completed, which is also where its
cursor was written — so a skip can never leave a gap. After a run that
succeeded there is nothing to resume, and `--resume` behaves as an ordinary
incremental sync rather than quietly skipping anything.

This is worth having because the list phase is now unconditional (see above): a
repository whose issue list completed before the interruption does not walk
every page a second time.

One case is worth knowing about. Pull requests are named by the issue walk, so
resuming a run where the issues finished but the pull requests did not would
normally mean re-walking the list just to learn which numbers are pull
requests. It reads them back out of the database instead — the issues operation
completed, so every issue is already stored, and the ones the walk would have
queued are exactly the pull requests newer than the cursor.

## Rate limits and pacing

Up to `sync.concurrency` API calls run at the same time (default 4) — the
per-item work of the details phase is independent, and waiting a full round
trip before starting the next item is where an hours-long sync spends most of
its wall clock. Concurrency hides that latency; it never raises the request
rate, because every call still goes through one rate limiter that

- keeps at least `sync.minDelayMs` between any two request starts (default
  250 ms), across all parallel workers,
- reads `x-ratelimit-remaining` / `x-ratelimit-reset` and pauses until the
  window resets once fewer than `sync.rateLimitReserve` calls are left —
  counting the requests still in flight, since each will consume one,
- honours `Retry-After` on 429 and on GitHub's secondary rate limits,
- retries 408/425/429/5xx and network errors with exponential backoff
  (`retryBaseMs`, doubling, capped at one minute, `maxRetries` times).

```bash
devcontext sync --delay 1000     # at most one API call per second
```

Set `respectRateLimit: false` only if a proxy in front of the API strips the
rate limit headers, and `concurrency: 1` for the strictly serial sync of
earlier versions.

The budget the APIs report is also shown, everywhere a sync is: the progress
line appends the tightest remaining budget (`4321 rate left`), and the last
observation of each run is kept in the database, so `devcontext status`, the
TUI's status line and the web viewer's sidebar all answer "how much is left"
between runs — each aged with when it was observed, because a stored number
is not the current truth.

## Progress

```
[##########--------------]  42% | 615/1442 calls | 388 items | 3m 12s elapsed | ~4m 20s left | acme/platform: pull requests (currently on #4021, 132 of 231)
```

The part in brackets is there because the percentage alone is not much comfort
on a large repository. Two thousand pull requests is twenty minutes in which
the bar moves a few characters, and a line that says only "pull requests" is
indistinguishable from one that has hung. The position ticks per item and names
the one being fetched, so a slow phase looks slow rather than stuck.

It appears on every phase that walks a list one item at a time — the pull
requests, the comments and timelines, the workflow jobs, the Jira comments and
history, the sprint membership. A phase walking pages rather than items has no
position and simply does not show one.

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

### When a collection turns out to be enormous

The sizing pass is also where a sync says so:

```
warn:  acme/platform has 24,318 pull requests. The first sync will fetch all of
       them and may take a long time. Bound it with `since` to fetch only
       recent history.
```

Above ten thousand items in one collection — issues, pull requests, workflow
runs, Jira work items — the run warns once and carries on. It is your
repository and your disk, so it is a warning rather than a refusal; what it
buys is that nobody discovers the scale by watching a progress bar crawl for an
hour.

The count is the one that will actually be fetched, so a repository with 40,000
workflow runs and `maxWorkflowRuns: 250` says nothing. A collection the API
will not count — no `Link` header, no total — cannot be warned about either,
and is simply discovered as it is walked.

Two costs cannot be probed at all: how many jobs a workflow run has, and how
many sprints hang off a board. Neither API answers either question without
listing them, which is the work itself.

They are unaskable rather than unknowable, though — **the last sync already
found out, and the database still holds the answer.** A repository whose runs
averaged four jobs yesterday will not average one today, so the stored ratios
price both. On a first sync there is no history, so those two parts are still
discovered as the run goes; from the second sync on they are priced up front
like everything else, and each phase replaces its own figure with the exact
one as soon as it knows it.

What remains is one over-estimate, deliberately: a Jira search usually returns
a work item's comments embedded, so the request the plan reserves for them is
often never made. Whether it will be is a property of the individual item
rather than a ratio, so the plan reserves it and the run comes in slightly
under — which is the safe direction for a progress bar.

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

If what you actually want is the web viewer staying current,
`devcontext serve --watch` runs this same sync on an interval inside the
serving process, and every open page refreshes itself when the data changes —
see [Watch mode](web.md#watch-mode).
