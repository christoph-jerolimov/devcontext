# CLI reference

```
devcontext [global options] <command> [command options]
```

## Global options

| Option                | Description                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `-c, --config <path>` | Path to `devcontext.yaml` (default: the first one found in the current directory or above) |
| `--db <path>`         | Override the database path from the configuration                                          |
| `-v, --verbose`       | Log every request                                                                          |
| `-q, --quiet`         | Only log errors                                                                            |
| `-V, --version`       | Print the version                                                                          |

Log output goes to stderr, data to stdout, so piping and redirecting work as
expected:

```bash
devcontext gh issues -o json > issues.json
```

## Output formats

Every command accepts `-o, --output`:

| Format     | Description                                                                  |
| ---------- | ---------------------------------------------------------------------------- |
| `default`  | Aligned columns for humans; optional columns are dropped on narrow terminals |
| `json`     | The underlying rows / the complete document as JSON                          |
| `markdown` | A markdown table, or a markdown document for detail views                    |
| `plain`    | Tab separated, no header, no colour — for `awk`, `cut` and friends           |

Every list command additionally accepts `--list`, which prints one bare
identifier per line (`owner/repo#12`, `PLAT-42`, a run id) — the format to loop
over in a shell script.

Common list options: `-n, --limit <count>` (default 50, `0` for no limit),
`--offset <count>`, `--search <text>`.

## Time filters

`--created-since`, `--created-before`, `--updated-since`, `--updated-before` and
`--stale` accept a relative duration (`30d`, `6w`, `3mo`, `2y`) or an absolute
date (`2024-01-31`, `2024-01-31T08:00:00Z`).

`--stale 90d` is a readable alias for `--updated-before 90d`: everything that
has not been touched for three months.

## `devcontext init`

Writes a commented `devcontext.yaml`.

| Option          | Description                                   |
| --------------- | --------------------------------------------- |
| `-f, --force`   | Overwrite an existing file                    |
| `--path <file>` | Write somewhere else than `./devcontext.yaml` |

## `devcontext sync`

Fetches from GitHub and Jira into the database and the outputs. See
[Sync](sync.md) for all options.

```bash
devcontext sync --only PLAT-42       # refresh one ticket now, then sync the rest
devcontext sync --only acme/platform#42 --only-targeted
```

## `devcontext status`

Shows the configuration in use, what is in the database, the last sync runs and
the cursors the next incremental sync will continue from.

## `devcontext export`

Writes the yaml / markdown / json mirrors again from the database, without
touching any API.

| Option                | Description                        |
| --------------------- | ---------------------------------- |
| `-r, --repo <repo>`   | Only this repository, repeatable   |
| `-p, --project <key>` | Only this Jira project, repeatable |
| `--no-workflow-runs`  | Skip the workflow run documents    |

## `devcontext github` (alias `gh`)

### `gh repos` (aliases `repo`, `repositories`, `repository`)

Lists the synced repositories.

### `gh issues [number]` (alias `issue`)

Without an argument: a filtered list. With an issue number: the complete issue —
body, every comment and the full timeline.

| Option                 | Description                              |
| ---------------------- | ---------------------------------------- |
| `-r, --repo <repo>`    | Repository `owner/name`, repeatable      |
| `-s, --state <state>`  | `open` (default), `closed`, `all`        |
| `-l, --label <label>`  | Label, repeatable or comma separated     |
| `-a, --author <login>` | Author                                   |
| `--assignee <login>`   | Assignee                                 |
| `--milestone <title>`  | Milestone                                |
| `--search <text>`      | Substring of the title or body           |
| `--sort <field>`       | `updated` (default), `created`, `number` |
| `--order <direction>`  | `desc` (default), `asc`                  |
| time filters           | see above                                |

```bash
devcontext gh issues --repo acme/platform --label bug --stale 90d
devcontext gh issues --state all --author alice -o markdown
devcontext gh issues 12
devcontext gh issues 12 -o json | jq '.comments[].author'
```

### `gh prs [number]` (aliases `pr`, `pullrequest`, `pullrequests`, `pull-request`, `pull-requests`)

Without an argument: a filtered list. With a number: the pull request with its
commits, changed files, reviews (including inline comments), comments and
timeline.

In addition to the issue options:

| Option                     | Description                 |
| -------------------------- | --------------------------- |
| `--reviewer <login>`       | Reviewed by this user       |
| `--base <ref>`             | Target branch               |
| `--draft` / `--no-draft`   | Only / never drafts         |
| `--merged` / `--no-merged` | Only merged / only unmerged |

```bash
devcontext gh prs --state all --merged --base main
devcontext gh prs --reviewer bob --updated-since 30d
devcontext gh prs 42 -o markdown > pr-42.md
```

### `gh workflows` (aliases `workflow`, `actions`, `action`)

Lists the Actions workflows with their run count and the time of the last run.

### `gh runs [id]` (alias `run`)

Without an argument: a filtered list of workflow runs. With a run id: the run
with all its jobs and every step.

| Option                      | Description                                     |
| --------------------------- | ----------------------------------------------- |
| `-r, --repo <repo>`         | Repository, repeatable                          |
| `-w, --workflow <name>`     | Workflow name or file path                      |
| `--status <status>`         | `queued`, `in_progress`, `completed`            |
| `--conclusion <conclusion>` | `success`, `failure`, `cancelled`, `skipped`, … |
| `--branch <ref>`            | Head branch                                     |
| `--event <event>`           | `push`, `pull_request`, `schedule`, …           |
| `--actor <login>`           | Who triggered the run                           |
| time filters                | see above                                       |

```bash
devcontext gh runs --conclusion failure --branch main -n 20
devcontext gh runs 1001
```

### `gh jobs [runId]` (alias `job`)

Lists workflow jobs, optionally of one run, with their duration.

### `gh steps [jobId]` (alias `step`)

Lists workflow steps, optionally of one job (`--run <id>` filters by run).

```bash
devcontext gh steps --conclusion failure -n 20
```

### `gh logs <jobId>` (alias `log`)

Prints the stored log of a job. Requires `workflowLogs: true` for the
repository.

```bash
devcontext gh logs 2001 | grep -i error
```

## `devcontext jira`

### `jira workitems [key]` (aliases `workitem`, `items`, `item`)

Without an argument: a filtered list. With a key (`PLAT-42`): the work item with
its description, links, every comment and the complete history.

| Option                  | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `-p, --project <key>`   | Jira project key, repeatable                    |
| `--site <name>`         | Jira site from the configuration, repeatable    |
| `-t, --type <type>`     | Work item type, repeatable                      |
| `--status <status>`     | Status name, repeatable                         |
| `--category <category>` | `To Do`, `In Progress`, `Done`, repeatable      |
| `--assignee <name>`     | Assignee display name (substring)               |
| `--reporter <name>`     | Reporter display name (substring)               |
| `-l, --label <label>`   | Label, repeatable                               |
| `--component <name>`    | Component, repeatable                           |
| `--sprint <name>`       | Sprint name (substring)                         |
| `--epic <key>`          | Items belonging to this epic                    |
| `--parent <key>`        | Items with this parent                          |
| `--open` / `--resolved` | Unresolved / resolved only                      |
| `--sort <field>`        | `updated` (default), `created`, `key`, `status` |
| time filters            | see above                                       |

### `jira stories` / `epics` / `features` / `bugs` / `tasks`

The same command with a preset type filter (singular aliases work too):

```bash
devcontext jira stories --sprint "Sprint 7"
devcontext jira epics --open
devcontext jira bugs --project PLAT --stale 60d --list
```

### `jira search <query>`

Searches key, summary, description **and comments**.

```bash
devcontext jira search "rate limit"
devcontext jira search "flaky" --open -o markdown
```

### `jira tree <key>`

The parents above a work item and everything below it, following both the
`parent` link (subtasks, team managed epics) and the epic link custom field
(classic epics), with a roll-up of story points and done counts.

```
$ devcontext jira tree PLAT-100
PLAT-100 (Epic) Improve the sync  · In Progress
├─ PLAT-101 (Story) Batch the API calls  ✓ Done  Alice  5sp
│  └─ PLAT-103 (Sub-task) Add the tests  ✓ Done  2sp
└─ PLAT-102 (Story) Document it  · To Do  Bob  3sp  (epic link)

Items:        4
Done:         2/4
Story points: 7/10
Types:        Epic 1, Story 2, Sub-task 1
```

Asking for a leaf shows the chain above it instead, so you always see where an
item sits.

| Option             | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `--depth <levels>` | How many levels below the item (default 5)                               |
| `--no-ancestors`   | Do not walk up to the parents                                            |
| `--links`          | Also attach the GitHub pull requests and issues that reference each item |

`-o markdown` renders a task list with checkboxes reflecting the status, which
pastes straight into a ticket or a status update; `--list` prints the keys.

### `jira sprints [id]` (alias `sprint`)

Without an argument: the sprint list with the number of work items. With an id:
the sprint with its work items, story point sum and done count.

| Option            | Description                              |
| ----------------- | ---------------------------------------- |
| `--site <name>`   | Jira site, repeatable                    |
| `--board <id>`    | Board id, repeatable                     |
| `--state <state>` | `future`, `active`, `closed`, repeatable |

### `jira projects` (alias `project`)

Lists the synced Jira projects with their work item count.

### `jira fields` (alias `field`)

Lists the Jira fields of the synced sites together with the friendly name you
configured. `--mapped` shows only the mapped ones. This is the fastest way to
find the `customfield_*` ids you want to map.

## `devcontext search <query...>` (aliases `find`, `q`)

Full text search across issues, pull requests, work items and their comments,
ranked by relevance. Quote a phrase to match it exactly; the last word is a
prefix by default. See [search.md](search.md).

| Option                | Description                                       |
| --------------------- | ------------------------------------------------- |
| `-k, --kind <kind>`   | `issue`, `pull-request` or `workitem`, repeatable |
| `-r, --repo <repo>`   | GitHub repository, repeatable                     |
| `-p, --project <key>` | Jira project key, repeatable                      |
| `--exact`             | Do not treat the last word as a prefix            |
| `-n, --limit <count>` | Maximum hits (default `25`)                       |
| `--offset <count>`    | Skip this many hits                               |
| `--rebuild`           | Rebuild the index and exit                        |

## `devcontext insights` (aliases `report`, `stats`)

Cycle time, review latency, work in progress, stale items, flaky workflow steps
and sprint reports, all computed from the local database. Takes an optional
section name to print just one of them. See [insights.md](insights.md).

## `devcontext digest` (aliases `standup`, `summary`)

What happened in a window — merged, finished, started, opened, plus who did it
and what is still stuck. `-o markdown` is shaped to be pasted into a standup.
See [digest.md](digest.md).

| Option                     | Description                                            |
| -------------------------- | ------------------------------------------------------ |
| `--since <when>`           | Start of the window (default `1w`)                     |
| `--until <when>`           | End of the window; defaults to now                     |
| `-r, --repo <repo>`        | GitHub repository, repeatable                          |
| `-p, --project <key>`      | Jira project key, repeatable                           |
| `--person <name>`          | Only activity by this person, repeatable               |
| `--stale-after <duration>` | Age at which open work counts as stale (default `30d`) |
| `--no-stale`               | Skip the stale section                                 |
| `-n, --limit <count>`      | Rows per section (default `10`)                        |

## `devcontext audit [section]`

What is stored locally, whose data it is, and what a sync would fetch. Takes an
optional section: `storage`, `content`, `people`, `secrets` or `config`. See
[audit.md](audit.md).

| Option                | Description                           |
| --------------------- | ------------------------------------- |
| `--all`               | Include low confidence secret matches |
| `-n, --limit <count>` | Rows per section (default `25`)       |

`devcontext audit secrets` scans issue bodies, comments, reviews, work items
and job logs for credentials. It reports where they are and a masked
fingerprint, never the value.

## `devcontext web`

Serves the React viewer and the JSON API for the local database.

| Option              | Description                                 |
| ------------------- | ------------------------------------------- |
| `-p, --port <port>` | Port (default `web.port`, `4173`)           |
| `--host <host>`     | Interface (default `web.host`, `127.0.0.1`) |

## Shell scripting

```bash
# every issue that has been quiet for half a year
devcontext gh issues --stale 180d --list

# story points per assignee in the active sprint
devcontext jira stories --sprint "Sprint 7" -o json |
  jq -r 'group_by(.assignee)[] | "\(.[0].assignee)\t\([.[].story_points] | add)"'

# which steps fail most often
devcontext gh steps --conclusion failure -n 0 -o plain | cut -f3 | sort | uniq -c | sort -rn
```
