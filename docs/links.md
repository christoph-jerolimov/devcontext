# Cross links between GitHub and Jira

Neither platform records the other side reliably, but people write the
reference down anyway — in the branch name, the pull request title, a commit
message, a comment. devcontext holds both datasets, so it can find those
references and turn them into a table you can query.

```bash
devcontext links PLAT-42          # pull requests and issues that reference a ticket
devcontext links acme/platform#43 # tickets a pull request references
devcontext links --high           # only branch names, titles and Jira fields
devcontext links --rebuild        # recompute (a sync does this automatically)
```

```
FROM              KIND          TO                VIA     CONFIDENCE  MATCH
acme/platform#43  pull_request  PLAT-42           branch  high        plat-42
acme/platform#43  pull_request  PLAT-42           title   high        PLAT-42
acme/platform#43  pull_request  PLAT-43           body    medium      PLAT-43
PLAT-45           workitem      acme/platform#42  title   high        acme/platform#42
```

## Where references are found

| Direction     | Scanned                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| GitHub → Jira | pull request branch name, title, body and commit messages; issue title and body; comments on both |
| Jira → GitHub | work item summary, description and comments                                                       |

Confidence is `high` for a branch name or a title — someone put it there on
purpose — and `medium` for prose, where a key may just be a passing mention.

## What is _not_ matched, and why

- **Jira keys of unknown projects.** `UTF-8`, `SHA-256`, `COVID-19`, `HTTP-2`
  and `RFC-7231` all have the exact shape of a Jira key. Only keys belonging to
  a project that is actually synced are accepted, which is what keeps the table
  signal rather than noise.
- **Bare `#42`.** Far too common in prose to attribute to a repository with any
  confidence. `owner/repo#42` and full URLs (including Enterprise hosts) are
  matched.
- **References to things that are not synced.** A pull request mentioning
  `PLAT-999` produces no link if that work item is not in the database.
  `devcontext links --rebuild -o json` reports those as `danglingJiraKeys` — a
  good hint that a `filter` in the configuration is excluding more than you
  meant.

Branch names are matched in the shapes people actually use:
`feature/PLAT-42-speed`, `feature/plat-42-speed`, `bugfix/plat42`,
`PLAT_42_hotfix`.

## Where the links show up

- `devcontext gh prs 43` and `devcontext gh issues 12` show a **Jira** row.
- `devcontext jira workitem PLAT-45` shows a **GitHub** section listing the
  pull requests and issues that reference it.
- The yaml / markdown / json exports carry the same fields.
- The web API answers `GET /api/links/PLAT-42`.
- The MCP server exposes `get_links`, so an assistant can ask "which pull
  requests implemented this ticket".

## How it is computed

`devcontext sync` rebuilds the table at the end of every run — it is a single
pass over text that is already in the database, so it costs no API calls.

It is a **full rebuild** rather than an incremental update on purpose: the
input is text that can change (an edited title, a renamed branch), and
recomputing from scratch means a stale link can never survive. That also makes
`devcontext links --rebuild` safe to run at any time.

## SQL

```sql
-- Which pull requests implemented an epic's stories?
SELECT w.epic_key, l.from_ref AS pull_request, w.key, w.summary
  FROM cross_links l
  JOIN jira_workitems w ON w.key = l.to_ref
 WHERE l.from_source = 'github' AND w.epic_key = 'PLAT-1'
 ORDER BY w.key;

-- Tickets that were closed without any pull request referencing them
SELECT w.key, w.summary
  FROM jira_workitems w
  LEFT JOIN cross_links l ON l.to_ref = w.key AND l.from_source = 'github'
 WHERE w.resolved_at IS NOT NULL AND l.uid IS NULL;
```
