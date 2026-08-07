# Database

The SQLite database is the primary target of every sync. It is a plain file
(`.devcontext/devcontext.db` by default) that any SQLite client can open:

```bash
sqlite3 .devcontext/devcontext.db
```

devcontext uses the `node:sqlite` module built into Node.js 22.5+, so there is
no native dependency to compile.

## Conventions

- **`raw`** — every table keeps the untouched JSON payload of the API response.
  Nothing is lost, even when devcontext does not lift a field into a column.
  Query it with SQLite's JSON functions:
  `SELECT json_extract(raw, '$.author_association') FROM gh_issues;`
- **`synced_at`** — when devcontext last wrote the row.
- **Keys** — GitHub rows are keyed by `(host, id)`, Jira rows by `(site, id)`,
  so several GitHub Enterprise servers or Jira sites can share one database.
- **List columns** — `labels`, `assignees`, `components`, … are JSON arrays of
  strings. `LIKE '%"bug"%'` is the cheap filter; `json_each()` the exact one.
- **Timestamps** are ISO 8601 strings, so string comparison is chronological.

## Bookkeeping tables

| Table                         | Contents                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `meta`                        | Schema version and timestamps                                                             |
| `projects`, `project_sources` | The configured projects, mirrored so the database is self describing                      |
| `sync_runs`                   | One row per target per `devcontext sync`: mode, status, API calls, items, duration, error |
| `sync_operations`             | One row per resource inside a run, with the cursor before and after                       |
| `sync_state`                  | Where the next incremental sync continues, per scope                                      |

## GitHub tables

| Table                                                                       | One row per                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `gh_repositories`                                                           | Repository                                                                 |
| `gh_users`                                                                  | User seen anywhere in the payloads                                         |
| `gh_labels`, `gh_milestones`                                                | Label / milestone of a repository                                          |
| `gh_issues`                                                                 | Issue **and** pull request (`is_pull_request`), as GitHub itself models it |
| `gh_issue_labels`, `gh_issue_assignees`                                     | Normalised label / assignee link                                           |
| `gh_comments`                                                               | Comment on an issue or pull request                                        |
| `gh_events`                                                                 | Timeline event: labeled, assigned, closed, renamed, referenced, …          |
| `gh_pull_requests`                                                          | Pull request with additions, deletions, merge state, …                     |
| `gh_reviews`                                                                | Review with its verdict                                                    |
| `gh_review_comments`                                                        | Inline review comment with `path`, `line` and `diff_hunk`                  |
| `gh_commits`                                                                | Commit of a pull request                                                   |
| `gh_pull_request_files`                                                     | Changed file including its patch                                           |
| `gh_workflows`, `gh_workflow_runs`, `gh_workflow_jobs`, `gh_workflow_steps` | Actions data                                                               |
| `gh_job_logs`                                                               | Complete job log (`workflowLogs: true`)                                    |
| `gh_releases`                                                               | Release (`releases: true`)                                                 |

## Jira tables

| Table                                                  | One row per                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `jira_projects`                                        | Project                                                              |
| `jira_fields`                                          | Field of the site, with `mapped_name` from your configuration        |
| `jira_workitems`                                       | Work item, with `custom_fields` as a JSON object keyed by your names |
| `jira_workitem_labels`                                 | Normalised label link                                                |
| `jira_comments`                                        | Comment (body converted to markdown)                                 |
| `jira_changelog`                                       | **Changed field** of a history entry                                 |
| `jira_links`                                           | Issue link, one row per direction                                    |
| `jira_attachments`                                     | Attachment metadata                                                  |
| `jira_worklogs`                                        | Work log (`worklogs: true`)                                          |
| `jira_boards`, `jira_sprints`, `jira_sprint_workitems` | Agile data                                                           |

Descriptions and comment bodies are stored as markdown whichever Jira flavour
they came from: Atlassian Document Format (Cloud, REST API v3) and wiki markup
(Data Center and Server, v2) are both converted during sync. The untouched
payload is still in the `raw` column if you need the original.

## Example queries

### Issues nobody has touched for three months

```sql
SELECT repo_full_name, number, title, updated_at
  FROM gh_issues
 WHERE is_pull_request = 0
   AND state = 'open'
   AND updated_at < datetime('now', '-90 days')
 ORDER BY updated_at;
```

### How long pull requests take to merge

```sql
SELECT repo_full_name,
       ROUND(AVG(julianday(merged_at) - julianday(created_at)), 1) AS avg_days,
       COUNT(*) AS merged
  FROM gh_pull_requests
 WHERE merged_at IS NOT NULL
   AND created_at >= datetime('now', '-180 days')
 GROUP BY repo_full_name;
```

### Who reviews whom

```sql
SELECT p.author AS pr_author, r.author AS reviewer, COUNT(*) AS reviews
  FROM gh_reviews r
  JOIN gh_pull_requests p ON p.id = r.pr_id AND p.host = r.host
 WHERE r.submitted_at >= datetime('now', '-90 days')
 GROUP BY pr_author, reviewer
 ORDER BY reviews DESC;
```

### When was a label added, and by whom

```sql
SELECT issue_number, actor, created_at, event, label
  FROM gh_events
 WHERE event IN ('labeled', 'unlabeled')
   AND label = 'needs-triage'
 ORDER BY created_at DESC;
```

### The flakiest workflow steps

```sql
SELECT s.name,
       SUM(s.conclusion = 'failure') AS failures,
       COUNT(*) AS runs,
       ROUND(100.0 * SUM(s.conclusion = 'failure') / COUNT(*), 1) AS failure_pct
  FROM gh_workflow_steps s
  JOIN gh_workflow_jobs j ON j.id = s.job_id AND j.host = s.host
 GROUP BY s.name
HAVING runs > 10
 ORDER BY failure_pct DESC;
```

### Cycle time from "In Progress" to "Done"

```sql
WITH moves AS (
  SELECT workitem_key,
         MIN(CASE WHEN to_string = 'In Progress' THEN created_at END) AS started,
         MAX(CASE WHEN to_string = 'Done' THEN created_at END) AS finished
    FROM jira_changelog
   WHERE field = 'status'
   GROUP BY workitem_key
)
SELECT w.key, w.type, w.summary,
       ROUND(julianday(m.finished) - julianday(m.started), 1) AS days
  FROM moves m
  JOIN jira_workitems w ON w.key = m.workitem_key
 WHERE m.started IS NOT NULL AND m.finished IS NOT NULL
 ORDER BY days DESC;
```

### Story points per assignee in a sprint

```sql
SELECT w.assignee, SUM(w.story_points) AS points, COUNT(*) AS items
  FROM jira_workitems w
  JOIN jira_sprint_workitems m ON m.workitem_id = w.id AND m.site = w.site
  JOIN jira_sprints s ON s.id = m.sprint_id AND s.site = m.site
 WHERE s.name = 'Sprint 7'
 GROUP BY w.assignee
 ORDER BY points DESC;
```

### Work items that changed sprint (scope creep)

```sql
SELECT workitem_key, COUNT(*) AS sprint_changes,
       GROUP_CONCAT(to_string, ' → ') AS path
  FROM jira_changelog
 WHERE field = 'Sprint'
 GROUP BY workitem_key
HAVING sprint_changes > 1
 ORDER BY sprint_changes DESC;
```

### Reading a custom field

```sql
SELECT key, summary, json_extract(custom_fields, '$.teamName') AS team
  FROM jira_workitems
 WHERE json_extract(custom_fields, '$.teamName') = 'Platform';
```

### Anything not lifted into a column

```sql
SELECT number, json_extract(raw, '$.reactions.total_count') AS reactions
  FROM gh_issues
 ORDER BY reactions DESC
 LIMIT 10;
```

## Schema changes

The schema is versioned in `meta.schema_version` and created idempotently on
every start, so opening an older database upgrades it in place. A database
written by a _newer_ devcontext is refused with a clear error instead of being
corrupted.
