# History

```bash
devcontext history [options]
```

How many issues were open last Tuesday. How many a person was carrying during a
sprint. Whether the backlog grew over a month or only felt like it.

## Why the other tables cannot answer this

An issue that was opened in January, closed in February and reopened in March
is **one row that says "open"**, and that row reads the same whichever of those
months you ask about. Closing, reopening and reassigning all overwrite; nothing
about the current state remembers the shape it came from.

So the shape is stored separately, as the changes that produced it.

## The table

`state_changes` holds one row per transition: **+1 when an item enters a state,
−1 when it leaves**.

| Column      | Meaning                                    |
| ----------- | ------------------------------------------ |
| `source`    | `github` or `jira`                         |
| `ref`       | `acme/platform#42`, `PLAT-7`               |
| `kind`      | `issue`, `pull_request`, `workitem`        |
| `container` | the repository or Jira project             |
| `dimension` | `state`, `assignee`, `sprint`, `points`    |
| `value`     | `open`, a person, a sprint id, an estimate |
| `at`        | when the transition happened               |
| `delta`     | `+1` or `-1`                               |

The count at any moment is the sum of every delta up to that moment:

```sql
SELECT COUNT(*) FROM (
  SELECT ref FROM state_changes
   WHERE dimension = 'state' AND value = 'open' AND at <= '2024-03-15'
   GROUP BY source, ref
  HAVING SUM(delta) > 0
);
```

Two dimensions intersect by doing that twice and joining on the item, which is
why the dimensions are separate rows rather than columns. "Open, assigned to
Alice, in sprint 33, on the 15th" is three sums and two joins.

## It is derived, not fetched

Nothing here costs an API call. Every transition comes from `gh_events` (the
issue timeline) and `jira_changelog` (the work item history), both already
synced. The table is rebuilt from scratch after every sync, and
`devcontext history --rebuild` recomputes it without syncing — which is what
you want after upgrading, since the events were always there.

## Replayed, not translated

The obvious implementation maps each event to a row: `closed` becomes −1,
`reopened` becomes +1. It is also wrong.

GitHub emits both `closed` and `merged` for a merged pull request. A timeline
fetched twice across a repository rename can hold the same transition under two
ids. Events sharing a timestamp arrive in whatever order the API felt like.

Any of those makes the running sum drift, and **a drifted sum is worse than no
answer, because nothing about it looks wrong.** So the events are replayed
against the state they describe and a row is written only when the state
actually changes. The running total of any one series is then 0 or 1 at every
point by construction, whatever the input did.

Where the timeline is silent — `issueTimeline` turned off, or a close that
predates the window — the item's own row is used to reconcile the ending state,
and a reconciling transition can never be recorded before the one it follows.

## Why the sync changed with it

This only works if **every** issue and pull request is synced, not only the
ones that changed recently. The balance carried in from before the window is
exactly what a partial sync is missing, and it cannot be recovered afterwards.

So `since` no longer bounds the list — it bounds the requests made per item.
See [Sync](sync.md#what-since-does-and-does-not-bound).

## Examples

```bash
# The last month, one row per day, with a bar
devcontext history

# One repository, one quarter
devcontext history --container acme/platform --from 2024-01-01 --to 2024-03-31

# Only what Alice was carrying, day by day
devcontext history --assignee alice

# What was open in a sprint, over the sprint
devcontext history --sprint 33 --from 2024-01-15 --to 2024-01-29

# A snapshot per person, right now
devcontext history --by-assignee

# Pull requests only, as json
devcontext history --kind pull_request --output json
```

## Where to see it

- `devcontext history` in the terminal, with a bar per day
- the **History** page in the [web viewer](web.md), as three lines — every
  ticket, GitHub issues alone, pull requests alone — with the daily movement on
  hover and a per-person snapshot beneath them
- the **History** view in the [terminal viewer](tui.md)

### Two charts on that page that are not balances

The History page also draws **pull requests finished per day** and **workflow
runs per day**, and neither reads from `state_changes`. The distinction matters:

|              | A balance                          | A count of events                |
| ------------ | ---------------------------------- | -------------------------------- |
| The question | How many were open on Tuesday      | How many finished on Tuesday     |
| Needs        | Everything carried in from earlier | Only what happened in the window |
| Read from    | `state_changes`                    | `closed_at` / `created_at`       |

Both are split rather than drawn as one total, because the total on its own
misleads. Twelve pull requests closed in a week is a good week or a wasted one
depending entirely on how many were **merged** rather than thrown away, and
whether CI is getting worse is a **failure** count rather than a run count.

The finished chart takes the `--person` and `--team` filters; the balances do
not, because "Ada's open pull requests on the 3rd of March" needs who it was
assigned to _then_, which is a different query from who holds it now.

Workflow runs are grouped by when they started, which is exact, rather than by
when they finished, which is not recorded. A run that started before midnight
and failed after it counts on the day the work was pushed — the day somebody
has to look at.

## Limits worth knowing

- **Jira "done" is inferred.** The changelog stores status _names_; whether a
  name means done comes from the status categories on the items themselves. A
  status that no current item uses is treated as open.
- **Sprint changes are matched by name.** Jira writes sprint membership as
  names in the changelog and as an id on the item. Names are resolved against
  the synced sprints; one that cannot be resolved is dropped rather than
  guessed at.
- **A person can appear twice.** GitHub knows them by login and Jira by
  display name, and nothing reconciles the two, so `grace` and `Grace` are
  counted as two people holding one item each rather than one holding two.
- **History only goes back as far as what was synced.** A repository synced
  with `issueTimeline: false` has closes and reopens reconciled from the row,
  so the balance is right today but the shape between is flat.

## What else it is for

The same table is what makes [sprint reports](sprints.md) possible. A burndown
needs to know when an item joined the sprint, not only that it is in one, and
that is exactly what a `sprint` dimension row is.
