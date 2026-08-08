# Sprint reports

```bash
devcontext insights burndown --sprint 33
devcontext insights velocity
```

There are two kinds of sprint report in devcontext, and they answer different
questions from different tables.

`devcontext insights sprint` reads the current tables: what the sprint holds
now, how much of it is done, who has what. That is the report you want at the
end.

**Burndown and velocity read [the state history](history.md).** They are the
reports you want _during_ a sprint, and they cannot be built from the current
tables — an item finished on day two and one finished an hour ago are the same
row there.

## Why the history matters

Take a two week sprint that committed to five items and finished three. Drawn
from the current membership, the line falls from five to two and the team looks
steady.

Now suppose one of those five arrived on day eight, pulled in after the plan
was agreed. What actually happened is that the team committed to four,
delivered three of them, and absorbed a fifth halfway through. The honest line
goes _up_ on day eight.

Nothing in `jira_workitems` can tell those two stories apart: the sprint field
holds where an item is, not when it got there. `state_changes` records the
joining and the leaving as ±1 rows with a timestamp, so the burndown built on
it shows the step, and velocity built on it does not credit the team with
having committed to work that had not been thought of yet.

```
$ devcontext insights burndown --sprint 33
── Burndown — Sprint 7 ──
State:       closed
Dates:       2024-03-01 → 2024-03-11
Committed:   5 items, 19 points
Final scope: 5 items, 23 points
Completed:   3 items, 16 points
Scope:       1 added, 1 removed after the start

DAY         LEFT  DONE  IDEAL  SCOPE
2024-03-01     5     0      5         ████████████████████
2024-03-02     5     0    4.5         ████████████████████
2024-03-03     4     1      4         ████████████████
2024-03-04     4     1    3.5         ████████████████
2024-03-05     5     1      3  +1     ████████████████████
2024-03-06     4     2    2.5         ████████████████
2024-03-07     3     2      2  -1     ████████████
...
```

The SCOPE column is the part a burndown normally hides. Day five goes back up,
and the reason is printed beside it.

## The reports

| Report              | What it answers                                                     |
| ------------------- | ------------------------------------------------------------------- |
| `insights burndown` | Was this sprint ever on track, and what changed underneath it?      |
| `insights velocity` | What does this team commit to, and what do they actually finish?    |
| `insights sprint`   | What does this sprint hold right now? (current tables, not history) |

### Burndown

| Option          | Description                                          |
| --------------- | ---------------------------------------------------- |
| `--sprint <id>` | Which sprint; defaults to the most recent active one |
| `--points`      | Burn story points rather than item counts            |

Four series come out of it, per day:

- **remaining** — in the sprint and still open. The line that should fall.
- **done** — in the sprint and finished.
- **scope** — everything in the sprint, done or not. Drawn behind the other two
  in the viewer, because a flat remaining line means one thing when the scope
  is flat and something else entirely when it is climbing.
- **ideal** — a straight line from the committed scope to zero.

### Velocity

| Option         | Description                                |
| -------------- | ------------------------------------------ |
| `--board <id>` | One board, when several teams share a site |
| `-n, --limit`  | How many sprints (default 15)              |

```
SPRINT    STARTED     COMMITTED  COMPLETED  PTS DONE  ADDED  RATIO
Sprint 6  2024-02-16          8          8        21      0   100%
Sprint 7  2024-03-01          5          3        16      1    60%
```

Both figures are read at the instant they refer to: **committed** is the
membership when the sprint started, **completed** is what was finished and
still in the sprint at the end. A ratio above 100% is not praise — it means
work arrived after the plan was agreed, and the ADDED column says how much.

Sprints come back oldest first, because a velocity chart is read left to right
through time.

## What is honest about these numbers, and what is not

**Sprint membership is exact.** Every join and every leave is a row with the
moment it happened.

**Open and closed is exact**, on the same rule the rest of devcontext uses: a
work item is closed when its status category is `Done`. See
[History](history.md).

**Story points are not historical.** This is the one number here that is taken
from today rather than from the day being drawn. The changelog records an
estimate being changed, but nothing joins that record to a burndown without a
fourth dimension in `state_changes`, so a story re-estimated from three to
eight is drawn as eight for every day of the sprint — including the days it was
a three. Item counts have no such caveat, which is why they are the default.

**A sprint with no dates gets no ideal line.** It still gets a burndown, over
the days its membership actually changed. Inventing a start and an end from the
data the line is meant to be compared against would make every sprint look
perfectly planned.

**A sprint still running stops its actual line at today.** Drawing zero for the
days ahead would say the work is finished; carrying the last value forward
would say nothing changed. The ideal line still runs to the end, so the target
stays visible.

## When a burndown looks wrong

The reports are only as good as the history, and the history is rebuilt from
the changelogs the sync fetched.

```bash
devcontext history --rebuild
```

A sprint that shows nothing at all usually means one of:

- **The Sprint field was never found.** Jira keeps sprint membership in a
  custom field whose id differs per site. devcontext finds it by name from the
  field catalogue, so this normally takes care of itself — but a site that
  calls it something other than `Sprint` needs the mapping written out:

  ```yaml
  jira:
    sites:
      - name: acme
        fields:
          customfield_10020: sprint
  ```

  `devcontext jira fields` shows what was mapped, detected or configured. With
  nothing there the work items are in no sprint at all, so every burndown is
  empty and every velocity row is zero.

- **`changelog: false`** for that Jira project, so no sprint moves were ever
  stored. The membership then starts at each item's creation.
- **A first sync bounded by `since`**, which fetched only recent changes. A
  `--full` sync fills the gap; the rebuild after it is what makes the older
  sprints correct.
- **Sprints not synced** (`sprints: false`), so the sprint has no dates and
  nothing to draw an ideal line between.

## In the API

| Endpoint                                   | Returns                                      |
| ------------------------------------------ | -------------------------------------------- |
| `GET /api/insights/burndown/:sprintId`     | The per-day series, scope changes and totals |
| `GET /api/insights/velocity?board=&limit=` | Committed against completed per sprint       |

The viewer draws both on its **Burndown** page, with a sprint picker and an
items/points switch.
