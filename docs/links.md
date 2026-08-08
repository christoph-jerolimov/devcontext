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

## Options

| Option                | Description                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `--high`              | Only high confidence links — branch names, titles, Jira fields                                         |
| `--via <source>`      | Only links found in `branch`, `title`, `body`, `commit`, `comment`, `closes` or `timeline`, repeatable |
| `--from <source>`     | Only links originating in `github` or `jira`                                                           |
| `--to <source>`       | Only links pointing at `github` or `jira`                                                              |
| `--rebuild`           | Recompute from the synced text before listing                                                          |
| `-n, --limit <count>` | Maximum rows (default 50)                                                                              |
| `--offset <count>`    | Skip this many rows                                                                                    |

```bash
devcontext links --via branch --high      # only what a branch name proves
devcontext links --from jira --to github  # tickets that name a pull request
```

## Where references are found

| Direction       | Scanned                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------- |
| GitHub → Jira   | pull request branch name, title, body and commit messages; issue title and body; comments on both |
| Jira → GitHub   | work item summary, description and comments                                                       |
| GitHub → GitHub | a pull request's closing keywords, and GitHub's own cross-reference timeline events               |

Confidence is `high` for a branch name or a title — someone put it there on
purpose — and `medium` for prose, where a key may just be a passing mention.

## Which pull request fixed this issue

Two sources, and the point of having both is that they fail differently.

**GitHub's own timeline** (`via: timeline`). A `cross-referenced` event records
that one item mentioned another, with the referring item attached and already
resolved by GitHub — there is no prose to misread and no bare number to
attribute. The payload arrives with the issue timeline the sync already fetches,
so this costs no extra API call. It is exact about _that_ a reference exists,
and says nothing about whether the referrer promised to close anything.

**Closing keywords** (`via: closes`). `Fixes #12`, `closes acme/other#7`,
`Resolved https://github.com/acme/other/issues/9` — the exact syntax GitHub
itself acts on, read from the pull request body. This is the one that means the
issue is finished when the pull request lands.

The distinction matters more than it looks. A pull request that says "see also
#12" and one that says "fixes #12" both contain `#12`, and only the second
belongs in a release note. When both sources find the same pair it is one link,
and `closes` is the reason shown.

Whoever raised the issue is also recorded as a
[contributor](cli.md#devcontext-contributors-ref-aliases-who-contributor) to the
pull request, with the role `raised` — they wrote the problem statement and are
the one who can say whether it was solved. Through a `closes` link only: a
mention has not made them a collaborator, and crediting it would inflate every
contributor list on a chatty repository.

## What is _not_ matched, and why

- **Jira keys of unknown projects.** `UTF-8`, `SHA-256`, `COVID-19`, `HTTP-2`
  and `RFC-7231` all have the exact shape of a Jira key. Only keys belonging to
  a project that is actually synced are accepted, which is what keeps the table
  signal rather than noise.
- **Bare `#42`.** Far too common in prose to attribute to a repository with any
  confidence — "step #3 failed" would link to an unrelated issue.
  `owner/repo#42` and full URLs (including Enterprise hosts) are matched.

  The one exception is a bare reference **immediately after a closing
  keyword**, where `fixes #12` is not something anybody writes by accident, it
  is the syntax GitHub acts on, and the repository is unambiguous. Even there
  the keyword has to be directly in front of it: "fixes the crash reported in
  #12" is prose about an issue rather than a promise to close one, and GitHub
  ignores it too.

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
- The **web viewer** shows a **Links** section on every issue, pull request and
  work item, and clicking a row crosses to the other platform. See
  [the web viewer](web.md#cross-links).
- The web API answers `GET /api/links/PLAT-42`, and
  `GET /api/links/acme/platform%2342` from the GitHub side.
- The MCP server exposes `get_links`, so an assistant can ask "which pull
  requests implemented this ticket".
- `devcontext links --via closes` lists just the fixes, and `--via timeline`
  just what GitHub cross-referenced itself.

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
