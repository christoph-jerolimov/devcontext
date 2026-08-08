# CLI guide

```
devcontext [global options] <command> [command options]
```

This page covers the commands in the shape people use them, with filters and
worked examples. For the exhaustive list — every command, every argument, every
option — see the generated [command reference](commands.md).

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

Every command that produces output accepts `-o, --output` — that is all of them
except `init` and `serve`, which produce a file and a server rather than a
report:

| Format     | Description                                                                  |
| ---------- | ---------------------------------------------------------------------------- |
| `default`  | Aligned columns for humans; optional columns are dropped on narrow terminals |
| `json`     | The underlying rows / the complete document as JSON                          |
| `markdown` | A markdown table, or a markdown document for detail views                    |
| `plain`    | Tab separated, no header, no colour — for `awk`, `cut` and friends           |

The same commands accept `--list`, which prints one bare identifier per line
(`owner/repo#12`, `PLAT-42`, a run id) — the format to loop over in a shell
script. In list mode the headings and explanatory notes are left out, so the
output can be piped straight into another command.

## List options

The list commands under `gh` and `jira` share:

| Option                | Default | Description                    |
| --------------------- | ------- | ------------------------------ |
| `-n, --limit <count>` | `50`    | Maximum rows; `0` for no limit |
| `--offset <count>`    | —       | Skip this many rows            |
| `--search <text>`     | —       | Match text in the title / body |

The report commands cap rows too, but with their own defaults and without
`--offset` or `--search`: `search` 25, `insights` 15, `digest` 10, `audit` 25,
`status` 10.

## Time filters

`--created-since`, `--created-before`, `--updated-since`, `--updated-before` and
`--stale` accept a relative duration (`30d`, `6w`, `3mo`, `2y`) or an absolute
date (`2024-01-31`, `2024-01-31T08:00:00Z`).

`--stale 90d` is a readable alias for `--updated-before 90d`: everything that
has not been touched for three months.

## `devcontext init`

Writes a `devcontext.yaml`, filled in from the GitHub repository of the current
directory when there is one.

| Option           | Default           | Description                                                    |
| ---------------- | ----------------- | -------------------------------------------------------------- |
| `-f, --force`    | —                 | Overwrite an existing file                                     |
| `--path <file>`  | `devcontext.yaml` | Write somewhere else                                           |
| `--example`      | —                 | Write the fully commented example instead of a detected config |
| `--detect`       | —                 | Detect only: print what was found and write nothing            |
| `--all-remotes`  | —                 | Include every git remote, not just `origin`                    |
| `--since <when>` | `12mo`            | How far back the initial sync should reach                     |

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

| Option                | Default | Description                 |
| --------------------- | ------- | --------------------------- |
| `-n, --limit <count>` | `10`    | Number of sync runs to show |

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
| `-s, --state <state>`  | `open`, `closed`, `all` (default)        |
| `-l, --label <label>`  | Label, repeatable or comma separated     |
| `-a, --author <login>` | Author                                   |
| `--assignee <login>`   | Assignee                                 |
| `--milestone <title>`  | Milestone                                |
| `--search <text>`      | Substring of the title or body           |
| `--sort <field>`       | `updated` (default), `created`, `number` |
| `--order <direction>`  | `desc` (default), `asc`                  |
| `--person <id>`        | Raised by or assigned to this person     |
| `--team <id>`          | Raised by or assigned to a team member   |
| `--no-bots`            | Hide items written by a bot              |
| `--bots-only`          | Only items written by a bot              |
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

`--person`, `--team`, `--no-bots` and `--bots-only` work here too — see
[People](people.md). `--no-bots` on an open pull request list is usually what
you want: it takes the dependency updates out without naming them.

`--state` defaults to **`all`**, as `gh issues` does. A merged pull request is
the normal end of one, so a list that hid them would read as if nothing had
ever shipped. `--state open` narrows it back down to what is still in flight.

```bash
devcontext gh prs --state open --base main
devcontext gh prs --merged --reviewer bob --updated-since 30d
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

### `jira outcomes` / `epics` / `features` / `stories` / `tasks` / `bugs`

The same command with a preset type filter (singular aliases work too):

```bash
devcontext jira stories --sprint "Sprint 7"
devcontext jira epics --open
devcontext jira bugs --project PLAT --stale 60d --list
```

Each name is a **group**, not a literal type, and `--type` uses the same groups:

| Filter                     | Also matches                      |
| -------------------------- | --------------------------------- |
| `task`                     | `Sub-task`, `Subtask`, `Sub Task` |
| `bug`                      | `Defect`                          |
| `outcome`                  | —                                 |
| `epic`, `feature`, `story` | —                                 |

Jira lets every site rename its types, and a subtask arrives spelled
differently on Cloud and Server — asking for tasks and getting none of the
subtasks under them is not what anybody means. A type that names no group is
matched exactly, so a site's own custom types stay filterable:

```bash
devcontext jira workitems --type "Spike"
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

The viewer shows the same tree beside an open work item — see
[the web viewer](web.md#hierarchy).

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

## `devcontext tickets` (alias `ticket`)

GitHub issues and Jira work items as one list. Pull requests are not here — a
pull request is a change, not a request for one, and `gh prs` already lists
them.

| Option                   | Description                                             |
| ------------------------ | ------------------------------------------------------- |
| `--source <source>`      | `github` or `jira`, repeatable; both when omitted       |
| `-c, --container <name>` | Repository (`acme/platform`) or Jira project (`PLAT`)   |
| `-t, --type <type>`      | `Bug`, `Story`, `Issue`, ... repeatable                 |
| `-s, --state <state>`    | `open`, `closed` or `all` (default)                     |
| `--assignee <name>`      | Assigned to this person                                 |
| `--person <id>`          | Raised by or assigned to this configured person         |
| `--team <id>`            | Raised by or assigned to a member of this team          |
| `--search <text>`        | Substring of the title or the body                      |
| `--types`                | List the types present and how many carry each, instead |
| `--containers`           | List the repositories and projects present, instead     |

```bash
devcontext tickets --state open --container PLAT
devcontext tickets --type Bug --source jira
devcontext tickets --types            # what types exist, and how many of each
devcontext tickets --containers       # which repositories and projects have any
```

`--types` is what the viewer's type dropdown is built from, so the list is
whatever your data contains rather than a set of names hardcoded somewhere.
Every other filter applies to the counts, so they describe the list you are
looking at:

```
SOURCE  TYPE   TICKETS
github  Issue        3
jira    Story        2
jira    Epic         1
jira    Task         1
```

### What a "type" is

Jira has always had one. GitHub only started offering typed issues recently and
most repositories have none, so an issue without one is called `Issue` rather
than being left blank — a dropdown entry with no name that matches nearly
everything is worse than a plain word.

### Open and closed across both

GitHub stores `open` / `closed`. Jira has no such flag, only a status and the
category it belongs to, so a work item counts as closed when its category is
`Done` — the same rule [History](history.md) uses. The original word is kept as
the status, so the table shows `In Progress` rather than flattening it to
`open`.

## `devcontext activity` (aliases `feed`, `changes`)

What people did, newest first, across both platforms. Every other list says
what the _state_ of things is; this one says what _happened_, and the two
cannot be read off each other — an issue that was opened, argued over for a
fortnight and closed looks, in the issue list, exactly like one nobody touched.

| Option                   | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `--since <when>`         | Events at or after this point (default `14d`)         |
| `--until <when>`         | Events before this point                              |
| `--source <source>`      | `github` or `jira`, repeatable                        |
| `-c, --container <name>` | Repository (`acme/platform`) or Jira project (`PLAT`) |
| `-k, --kind <kind>`      | `status`, `comment` or `review`, repeatable           |
| `--person <id>`          | Only what this configured person did, repeatable      |
| `--team <id>`            | Only what members of this team did, repeatable        |
| `--no-bots`              | Hide what bots did                                    |
| `--bots-only`            | Only what bots did                                    |
| `--by-person`            | Who was busy in the window, instead of what happened  |

```bash
devcontext activity --since 7d
devcontext activity --since 4h                          # while you were in that meeting
devcontext activity --team platform --kind review
devcontext activity --no-bots --container acme/platform
devcontext activity --by-person --since 30d
```

`--since` takes hours as readily as days — `1h`, `2h`, `4h`, `8h`, `12h` — which
is the grain the question usually has when it is asked in the morning or after
a meeting. The viewer offers the same windows in its dropdown.

### The three kinds

| Kind      | What it covers                                                                  |
| --------- | ------------------------------------------------------------------------------- |
| `status`  | Opened, closed, reopened, merged; a Jira work item created or moved to a status |
| `comment` | Issue, pull request and work item comments, plus the inline comments on a diff  |
| `review`  | A verdict on a pull request: approved, changes requested, commented, dismissed  |

Labels, assignment changes and renames are stored — see
[Database](database.md) — but they are bookkeeping rather than activity, and a
feed listing every label a triage bot ever applied buries the four things that
mattered.

Only the **status** field of the Jira changelog counts as a status change.
"Changed the description" is a change, but it is not that, and a feed that said
otherwise would be full of them.

A merged pull request says **merged**, once. GitHub reports a `closed` event
alongside the `merged` one — merging closes the pull request — and the feed
drops the close when a merge happened at the same moment. Two lines for one act
is not only noise: it doubled that pull request in `--by-person` and made a
merge look like twice the work of any other close. A pull request genuinely
closed, reopened weeks later and then merged still shows both, because that is
two decisions rather than one.

### `--by-person`

```
SOURCE  ACTOR         PERSON        STATUS  COMMENTS  REVIEWS  TOTAL  LAST
github  ghopper       Grace Hopper      12        41       27     80  2026-08-06
github  grace-h                          1         3        0      4  2026-08-02
```

Grouped per **identity**, not per person, for the same reason
`people --identities` is: the second row is a login nobody mapped, and rolling
it into Grace would hide exactly the thing worth seeing. See
[People](people.md).

## `devcontext contributors <ref>` (aliases `who`, `contributor`)

Who worked on an issue, pull request or work item — and, for each of them, what
they actually did.

The author has always been one column away. Everybody else was four joins away,
so in practice "who worked on this" got answered with the author alone — which
names the one person guaranteed not to have reviewed it.

| Option          | Description                                                              |
| --------------- | ------------------------------------------------------------------------ |
| `--rollup`      | Include everything beneath it: child work items and linked pull requests |
| `--role <role>` | Only this capacity                                                       |
| `--by-item`     | One row per contribution rather than one per person                      |
| `--rebuild`     | Recompute the table from the synced rows before listing                  |

```bash
devcontext contributors PLAT-7
devcontext contributors acme/platform#42
devcontext contributors PLAT-100 --rollup        # an epic, and everything under it
devcontext contributors PLAT-7 --role reviewer
```

```
WHO           DID                          TIMES  LAST
Ada Lovelace  author, committer                9  2026-08-04
Grace Hopper  reviewer, commenter              4  2026-08-05
Linus         commenter                        1  2026-08-03
```

### The capacities

| Role               | What it means                                       |
| ------------------ | --------------------------------------------------- |
| `author`           | Opened it (a GitHub author, a Jira creator)         |
| `reporter`         | Reported it on somebody else's behalf               |
| `assignee`         | It was assigned to them                             |
| `committer`        | Wrote commits on it                                 |
| `worked`           | Logged work against it                              |
| `reviewer`         | Reviewed it                                         |
| `review_requested` | Was asked to review it, and has not yet             |
| `commenter`        | Commented on it, in the conversation or on the diff |
| `merged_by`        | Merged it                                           |

The capacity is the whole point. "Involved" flattens the person who wrote it,
the person who reviewed it and the person who left one drive-by comment into
the same word, and no decision anybody makes from this list treats those the
same. Each row also carries a count — the difference between having been
present and having carried it.

Two distinctions worth knowing:

- **`review_requested` is not `reviewer`.** GitHub drops a login from the
  requested list the moment they submit, so what remains is the outstanding
  asks. Recording it as a review would say somebody looked at a pull request
  they have not opened.
- **`reporter` appears only when it differs from the creator.** Jira sets both
  to the same person on most tickets, and a role that repeats the author on
  every row says nothing. When they differ it says something real.

### `--rollup`

Nobody contributes to an epic, because an epic is a heading. Asked plainly it
answers with whoever created the heading, which is true and useless — so the
command says how many items sit beneath it and offers the rollup.

The rollup takes two hops: **down** the Jira parent links, so a feature reaches
its stories and an epic reaches everything under both, and **across** the
[cross references](#devcontext-links-alias-link), so a story reaches the pull
requests that implemented it. The second hop is the only route from a Jira key
to the people who wrote and reviewed the code.

The table is derived from rows already synced — no API call adds it — and is
rebuilt on every sync, so an existing database gets it without fetching a byte.

## `devcontext people` (alias `person`)

The configured people and bots, with the GitHub and Jira identities each of
them answers to. See [People](people.md) for the configuration itself.

| Option         | Description                                                  |
| -------------- | ------------------------------------------------------------ |
| `--team <id>`  | Only members of this team, repeatable                        |
| `--bots-only`  | Only the configured bots                                     |
| `--no-bots`    | Only the humans                                              |
| `--identities` | One row per identity, with what the data knows about it      |
| `--unmapped`   | Names found in the data that belong to nobody, busiest first |

```bash
devcontext people
devcontext people --identities        # is every configured login actually used?
devcontext people --unmapped          # who is missing from the configuration?
devcontext people --team platform --no-bots
```

`--identities` counts per identity rather than per person on purpose: a login
with a typo in it looks exactly like a quiet colleague until the two are next
to each other.

## `devcontext teams` (alias `team`)

The configured teams and their members.

```bash
devcontext teams
devcontext teams -o json
```

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

Sections: `cycle-time`, `review-latency`, `wip`, `stale`, `flaky`, `sprint`,
`burndown`, `velocity`.

| Option                     | Description                                            |
| -------------------------- | ------------------------------------------------------ |
| `--since <when>`           | Start of the window (default `90d`)                    |
| `--until <when>`           | End of the window                                      |
| `-r, --repo <repo>`        | GitHub repository, repeatable                          |
| `-p, --project <key>`      | Jira project key, repeatable                           |
| `--stale-after <duration>` | Age at which open work counts as stale (default `30d`) |
| `--min-runs <count>`       | Minimum runs before a step can be called flaky         |
| `--sprint <id>`            | Sprint id for the `sprint` and `burndown` sections     |
| `--board <id>`             | Board id, to keep `velocity` to one team               |
| `--points`                 | Burn story points rather than item counts              |
| `-n, --limit <count>`      | Rows per section (default `15`)                        |

`burndown` and `velocity` are the two sections that read the
[state history](history.md) rather than the current tables, which is what lets
them show work pulled into a sprint after it started. See
[Sprint reports](sprints.md).

```bash
devcontext insights burndown --sprint 33
devcontext insights burndown --points
devcontext insights velocity --board 1
```

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

## `devcontext serve` (alias `web`)

Serves the React viewer and the JSON API for the local database. The command was
called `web` originally; that name still works.

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
