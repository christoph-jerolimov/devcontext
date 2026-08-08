# Configuration

devcontext reads a single yaml file. It is looked up in this order:

1. `--config <path>`
2. `$DEVCONTEXT_CONFIG`
3. the first of `devcontext.local.yaml`, `devcontext.local.yml`,
   `devcontext.yaml`, `devcontext.yml`, `.devcontext.yaml`, `.devcontext.yml`
   found in the current directory or any parent directory

`devcontext.local.yaml` is git ignored by the repository, which makes it a good
place for company internal URLs and project keys.

Every relative path is resolved against the directory of the configuration
file, so `devcontext` behaves the same from any subdirectory.

## Environment variables

Any string value may reference the environment:

```yaml
email: ${JIRA_EMAIL}
baseUrl: ${JIRA_URL:-https://acme.atlassian.net}
```

`${VAR}` is replaced by the value of `VAR`, `${VAR:-fallback}` falls back when
`VAR` is unset or empty. An unresolvable `${VAR}` is left as is, which usually
surfaces as a clear validation error.

Tokens should not be written into the file at all. Configure the _name_ of the
variable with `tokenEnv` instead.

## Top level keys

| Key        | Type                 | Default                     | Description                          |
| ---------- | -------------------- | --------------------------- | ------------------------------------ |
| `version`  | `1`                  | `1`                         | Configuration format version.        |
| `database` | string or `{ path }` | `.devcontext/devcontext.db` | Where the SQLite database lives.     |
| `sync`     | object               | see below                   | How the sync talks to the APIs.      |
| `outputs`  | object               | see below                   | The yaml / markdown / json mirrors.  |
| `web`      | object               | see below                   | Defaults for `devcontext serve`.     |
| `github`   | object               | —                           | GitHub hosts and default sync flags. |
| `jira`     | object               | —                           | Jira sites and default sync flags.   |
| `people`   | array                | `[]`                        | Who the names in the data belong to. |
| `bots`     | array                | `[]`                        | The same, for automations.           |
| `teams`    | array                | `[]`                        | Groups of the people above.          |
| `projects` | array                | required                    | At least one project.                |

Unknown keys are rejected with an error that names the offending path, so typos
never fail silently.

`people`, `bots` and `teams` are what let a query mean a colleague rather than
one of their spellings — see [People](people.md).

For all of this in one annotated file, with every value shown at the default it
already has, see [Every setting](configuration-reference.md).

## `sync`

```yaml
sync:
  minDelayMs: 250 # minimum pause between two API calls
  maxRetries: 5 # retries for 429/5xx/network errors
  retryBaseMs: 1000 # exponential backoff base (1s, 2s, 4s, ...)
  respectRateLimit: true # wait for the rate limit window instead of failing
  rateLimitReserve: 50 # start waiting once fewer than N calls are left
  maxRateLimitWaitMs: 900000 # never wait longer than this; fail instead
  requestTimeoutMs: 60000
  pageSize: 100 # page size for Jira searches (GitHub always uses 100)
  progress: true # render the progress indicator
```

`minDelayMs` is the knob to turn when an API is unhappy: `1000` means at most
one request per second. `--delay <ms>` on `devcontext sync` overrides it for a
single run.

## `outputs`

```yaml
outputs:
  yaml:
    enabled: true
    path: .devcontext/yaml
  markdown:
    enabled: true
    path: .devcontext/markdown
  json:
    enabled: false
    path: .devcontext/json
```

Outputs are written after a successful sync and can be regenerated at any time
with `devcontext export`. They never feed back into the database — see
[Outputs](outputs.md) for the file layout.

## `web`

Defaults for `devcontext serve`. The key keeps the name `web` so existing
configuration files stay valid.

```yaml
web:
  port: 4173
  host: 127.0.0.1
  open: false
```

## `github`

```yaml
github:
  hosts:
    - name: github.com # referenced by projects[].github[].host
      apiUrl: https://api.github.com # default
      webUrl: https://github.com # derived from apiUrl when omitted
      tokenEnv: GITHUB_TOKEN # default
    - name: ghe
      apiUrl: https://github.example.com/api/v3
      tokenEnv: GHE_TOKEN

  sync: # defaults for every repository
    issues: true
    workflowLogs: false
```

When no host is configured, `github.com` with `GITHUB_TOKEN` is assumed.

### Repository sync flags

Both `github.sync` (global) and `projects[].github[].sync` (per repository)
accept the same flags; the per repository value wins.

| Flag                  | Default | What it downloads                                                                                             |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `issues`              | `true`  | The issue list (which also yields the pull request list)                                                      |
| `issueComments`       | `true`  | Every comment of every issue and pull request                                                                 |
| `issueTimeline`       | `true`  | The full timeline: labels added/removed, assigned, closed, reopened, renamed, referenced, review requested, … |
| `issueReactions`      | `false` | Reaction details (the summary is part of the issue payload anyway)                                            |
| `pullRequests`        | `true`  | The detailed pull request payload (additions, merge state, …)                                                 |
| `pullRequestReviews`  | `true`  | Every review with its verdict                                                                                 |
| `pullRequestComments` | `true`  | Every inline review comment with its diff hunk                                                                |
| `pullRequestCommits`  | `true`  | The commit list of the pull request                                                                           |
| `pullRequestFiles`    | `true`  | Changed files including the patch                                                                             |
| `labels`              | `true`  | Repository labels                                                                                             |
| `milestones`          | `true`  | Repository milestones                                                                                         |
| `releases`            | `false` | Releases                                                                                                      |
| `workflows`           | `true`  | Actions workflow definitions                                                                                  |
| `workflowRuns`        | `true`  | Workflow runs                                                                                                 |
| `workflowJobs`        | `true`  | Jobs of each run, including every step                                                                        |
| `workflowLogs`        | `false` | The complete log of each job (large!)                                                                         |

## `jira`

```yaml
jira:
  sites:
    - name: acme # referenced by projects[].jira[].site
      baseUrl: https://acme.atlassian.net
      apiVersion: '3' # '3' for Cloud, '2' for Data Center
      auth: basic # basic (email + token) or bearer (PAT)
      email: ${JIRA_EMAIL}
      tokenEnv: JIRA_API_TOKEN
      fields: # custom field mapping, see below
        customfield_10016: storyPoints
        customfield_10014: epicLink
        customfield_10020: sprint

  sync: # defaults for every Jira project
    worklogs: false
```

`auth` defaults to `basic` when an `email` is set and to `bearer` otherwise.

### Custom fields

Jira exposes custom fields as `customfield_10016`. The `fields` mapping gives
them readable names, which are then used in the `custom_fields` JSON column of
`jira_workitems`, in the yaml/markdown output and in the web viewer.

Run `devcontext jira fields` after the first sync to see every field of your
site together with its Jira name — that is the fastest way to find the ids you
need.

Three names are understood by devcontext itself and fill dedicated columns:

| Mapped name   | Column                                    | Notes                                                  |
| ------------- | ----------------------------------------- | ------------------------------------------------------ |
| `storyPoints` | `jira_workitems.story_points`             | numeric                                                |
| `epicLink`    | `jira_workitems.epic_key`                 | only used when the item has no `parent` epic           |
| `sprint`      | `jira_workitems.sprint_id`, `sprint_name` | understands both the object and the legacy string form |

Mappings can be defined per site and per project; the project level wins.

### Jira project sync flags

| Flag          | Default | What it downloads                                         |
| ------------- | ------- | --------------------------------------------------------- |
| `workitems`   | `true`  | Work items matching the project and the filter            |
| `comments`    | `true`  | Every comment                                             |
| `changelog`   | `true`  | The complete history: status, labels, assignee, sprint, … |
| `links`       | `true`  | Issue links                                               |
| `attachments` | `true`  | Attachment metadata (not the files)                       |
| `boards`      | `true`  | Boards of the project                                     |
| `sprints`     | `true`  | Sprints of those boards, including their membership       |
| `worklogs`    | `false` | Work logs                                                 |

## `projects`

```yaml
projects:
  - key: acme-platform # unique, used by --project
    name: ACME Platform
    description: Everything the platform team works on.
    github:
      - repo: acme/platform # owner/name
        host: github.com # optional, defaults to the first host
        since: 12mo # how far back the initial sync reaches
        maxWorkflowRuns: 250 # safety net per sync run; null or "all" for every run
        maxLogBytes: 2000000 # job logs are truncated beyond this
        sync:
          workflowLogs: true
    jira:
      - site: acme # optional, defaults to the first site
        project: PLAT
        since: 12mo
        filter: labels != security AND issuetype != "Vulnerability"
        boards: [12, 15] # empty or omitted: every board of the project
        fields:
          customfield_10101: teamName
        sync:
          worklogs: false
```

### `maxWorkflowRuns`

A safety net per sync run, defaulting to 250. A busy repository accumulates
workflow runs faster than anything else devcontext syncs, and each one costs a
jobs call on top of the list — so an unbounded first sync of a large repository
is the one that runs for hours.

Set it to `null` or `"all"` when that is what you want:

```yaml
maxWorkflowRuns: null # or: maxWorkflowRuns: "all"
```

Both spellings mean the same thing. The run still walks newest first and still
stops at the stored cursor, so only the _first_ sync pays the full price; after
that it fetches what has appeared since.

### `since`

Accepts a relative duration (`30d`, `6w`, `3mo`, `2y`) or an absolute date
(`2024-01-31`, `2024-01-31T08:00:00Z`) and is resolved when the configuration is
loaded. It bounds the _initial_ sync — later runs continue from the stored
cursor. Leaving it out means "everything the API returns".

### `filter`

Extra JQL that every synced work item has to match. devcontext builds the query
as

```
project = "PLAT" AND (<filter>) AND updated >= "<cursor>" ORDER BY updated ASC
```

so the filter is the place to keep sensitive tickets out of the local database:

```yaml
filter: labels != security AND project != SEC AND "Restricted[Checkbox]" is EMPTY
```

`devcontext sync --verbose` logs the exact JQL that is sent.

## Multiple projects and hosts

```yaml
projects:
  - key: platform
    github:
      - repo: acme/platform
      - repo: acme/platform-docs
    jira:
      - project: PLAT
      - project: INFRA
  - key: internal
    github:
      - repo: internal/tools
        host: ghe
```

`devcontext sync --project platform` syncs a single project;
`devcontext sync --target acme/platform` a single repository or Jira project.
