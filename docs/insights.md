# Insights

```bash
devcontext insights                    # everything, last 90 days
devcontext insights cycle-time
devcontext insights review-latency --since 30d
devcontext insights stale --stale-after 60d --list
devcontext insights flaky --min-runs 10
devcontext insights sprint --sprint 33
```

Everything is computed from the local database — no API calls — and is
available in the web viewer under **Insights** and as JSON through
`GET /api/insights`.

## Cycle time

Time from the **first move into an in-progress status** to the **last move into
a done status**, read from the Jira changelog.

That is deliberately not `created_at → resolved_at`: a ticket that sat in the
backlog for a month should not have that month counted as cycle time. Reading
the history also means a reopened ticket is measured to its _final_ completion,
not the first one.

Items that reached Done without ever passing through an in-progress status
cannot be measured and are reported separately rather than counted as zero.

The report shows the median, the p85 (a better "worst normal case" than the
maximum), a breakdown per work item type and the slowest items.

## Review latency

Per pull request: time to the **first review by somebody other than the
author** — a self-review does not count as having been reviewed — and time to
merge. Plus the number of pull requests **merged without any review**, and a
per-reviewer table with review counts and median response time.

## Work in progress

What is in flight right now: work items in an in-progress status, open pull
requests (and how many are drafts), open issues, and a per-person table with
the age of their oldest item.

## Stale

Open work nobody has touched since the threshold (`--stale-after`, default
30 days), across issues, pull requests and work items, oldest first.
`--list` prints just the references, so it pipes into a triage script.

## Flaky steps

Workflow steps ranked by failure rate, for steps with at least `--min-runs`
runs (default 5).

`RETRIED GREEN` is the honest flakiness signal: the same step failing on one
attempt of a run and passing on another means the failure was not caused by the
code under test. A step with a high failure rate but zero retried-green results
is more likely genuinely broken than flaky.

## Sprint

Committed versus completed items and story points, completion rate, a
per-assignee breakdown, the status distribution, and **scope changes** — work
items moved into or out of the sprint after it started, taken from the `Sprint`
field history.

Without `--sprint` the report uses the most recent active sprint.

## Options

| Option                     | Description                                                           |
| -------------------------- | --------------------------------------------------------------------- |
| `--since <when>`           | Window for cycle time, review latency and flaky steps (default `90d`) |
| `--until <when>`           | Upper bound of the window                                             |
| `-r, --repo <repo>`        | Restrict to a GitHub repository, repeatable                           |
| `-p, --project <key>`      | Restrict to a Jira project, repeatable                                |
| `--stale-after <duration>` | Age at which open work counts as stale (default `30d`)                |
| `--min-runs <count>`       | Minimum runs before a step can be called flaky (default `5`)          |
| `--sprint <id>`            | Sprint for the sprint report                                          |
| `-n, --limit <count>`      | Rows per section (default 15)                                         |

`-o json` returns every section as structured data, which is the form to feed
into a dashboard or a scheduled report.
