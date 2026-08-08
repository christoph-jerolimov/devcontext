# Configuration reference

[Configuration](configuration.md) explains what each key is _for_. This page is
the other half: one complete `devcontext.yaml` with **every key devcontext
accepts, set to the value it already uses when you leave it out**.

So this file is not a file you should write. Copying it wholesale gives you a
long configuration that behaves exactly like an empty one. It is here to
answer "what happens if I don't say anything?" without reading the source —
and to be the place you copy a single key out of when you want to change it.

Keys that have no default are marked `(no default)`. Everything else is shown
at its default value.

> A test resolves this file on every run and compares the result against the
> defaults the code actually applies, key by key, and fails when the schema
> grows a key this page does not mention. If the two ever disagree, the build
> breaks rather than the documentation quietly going stale.

```yaml
# Every relative path below is resolved against the directory of this file.
# ${VAR} and ${VAR:-fallback} are expanded from the environment.

# The configuration format. There is only one version so far.
version: 1

# The SQLite database. This is the source of truth; everything else is
# derived from it and can be deleted and regenerated.
database:
  path: .devcontext/devcontext.db

# How the sync talks to both APIs.
sync:
  # Minimum pause between two API calls. 0 goes as fast as the rate limit
  # allows; 1000 means at most one request per second. `sync --delay <ms>`
  # overrides this for a single run.
  minDelayMs: 250
  # Retries for HTTP 429, 5xx and network errors. Anything else fails at once.
  maxRetries: 5
  # Backoff base, doubled per attempt: 1s, 2s, 4s, 8s, 16s.
  retryBaseMs: 1000
  # Wait out the rate limit window instead of failing with HTTP 403.
  respectRateLimit: true
  # Start waiting once fewer than this many calls remain in the window, so a
  # parallel process is not starved by devcontext using the last few.
  rateLimitReserve: 50
  # Refuse to sit out a window longer than this and fail with a clear error.
  # 15 minutes.
  maxRateLimitWaitMs: 900000
  # Per request, not per sync.
  requestTimeoutMs: 60000
  # Page size for Jira searches. GitHub always uses its maximum of 100.
  pageSize: 100
  # The progress indicator. Turned off automatically when stdout is not a
  # terminal, so this only matters interactively.
  progress: true

# Mirrors written from the database after a successful sync, and by
# `devcontext export` at any time. They never feed back into the database.
outputs:
  yaml:
    enabled: true
    path: .devcontext/yaml
  markdown:
    enabled: true
    path: .devcontext/markdown
  # Off by default: yaml and markdown already cover reading and grepping.
  json:
    enabled: false
    path: .devcontext/json

# Defaults for `devcontext serve`.
web:
  port: 4173
  # Loopback only. Set 0.0.0.0 to expose the viewer on the network — it has no
  # authentication, so only do that on a network you trust.
  host: 127.0.0.1
  # Open a browser when the server starts.
  open: false

github:
  # When this list is omitted entirely, exactly this one host is assumed.
  hosts:
    - name: github.com # (no default) how projects refer to this host
      apiUrl: https://api.github.com
      # Derived from apiUrl when omitted: api.github.com becomes github.com,
      # any other host keeps its origin.
      webUrl: https://github.com
      tokenEnv: GITHUB_TOKEN
      # There is deliberately no `token:` here. It is accepted, but a token
      # written into this file gets committed sooner or later. Name the
      # environment variable with tokenEnv instead; `devcontext audit secrets`
      # reports where credentials are found without ever printing them.

  # Defaults for every repository. A repository below may override any of them.
  sync:
    issues: true # the issue list, which also yields the pull request list
    issueComments: true # every comment on every issue and pull request
    issueTimeline: true # labelled, assigned, closed, reopened, renamed, ...
    issueReactions: false # off: the counts are part of the issue payload anyway
    pullRequests: true # the detailed payload: additions, merge state, ...
    pullRequestReviews: true
    pullRequestComments: true # inline review comments with their diff hunk
    pullRequestCommits: true
    pullRequestFiles: true # changed files including the patch
    labels: true
    milestones: true
    releases: false
    workflows: true
    workflowRuns: true
    workflowJobs: true # jobs of each run, including every step
    workflowLogs: false # off: complete job logs are large

jira:
  # No site is assumed. Configuring a Jira project without a site is an error.
  sites:
    - name: acme # (no default) how projects refer to this site
      baseUrl: https://acme.atlassian.net # (no default) required
      apiVersion: '3' # '3' for Cloud, '2' for Data Center
      # Defaults to basic when an email is set, bearer otherwise.
      auth: basic
      email: ${JIRA_EMAIL} # (no default) only used by basic auth
      tokenEnv: JIRA_API_TOKEN
      # (no default: no mapping) `devcontext jira fields` lists what your site
      # offers. storyPoints, epicLink and sprint fill dedicated columns; any
      # other name lands in the custom_fields JSON column.
      fields: {}

  # Defaults for every Jira project below.
  sync:
    workitems: true
    comments: true
    changelog: true # the full history: status, labels, assignee, sprint, ...
    worklogs: false
    links: true
    attachments: true # metadata only, never the files themselves
    boards: true
    sprints: true # sprints of those boards, including their membership

# Who the names in the data belong to. Optional, and empty by default: without
# it a person is whatever string each API returned, so the same colleague is
# `ghopper` on one side and `Grace Hopper` on the other. See docs/people.md.
people:
  - id: grace # (no default) unique, used by --person
    name: Grace Hopper # defaults to the id
    email: grace@example.com # (no default) not used for matching
    bot: false # true moves this entry into the bots, wherever it is written
    github: [] # every GitHub login this person answers to
    jira: [] # every Jira display name, account id or email

# Exactly the same shape, with `bot` already answered. A GitHub App whose login
# ends in [bot] is treated as one without being listed here.
bots:
  - id: dependabot
    name: Dependabot
    email: bot@example.com # (no default)
    bot: true # already implied by being here
    github: []
    jira: []

# Groups of the people above, so a filter can name the group instead.
teams:
  - id: platform # (no default) unique, used by --team
    name: Platform # defaults to the id
    description: Keeps the build green. # (no default)
    members: [] # person ids; an unknown one is an error, not an empty result

# At least one project is required; everything above is optional.
projects:
  - key: acme-platform # (no default) unique, used by --project
    name: ACME Platform # defaults to the key
    description: Everything the platform team works on. # (no default)

    github:
      - repo: acme/platform # (no default) owner/name
        host: github.com # defaults to the first host above
        # (no default) How far back the *initial* sync reaches; later runs
        # continue from the stored cursor. Omitting it means everything the
        # API returns. Accepts 30d, 6w, 3mo, 2y or an absolute date.
        since: 12mo
        # Per sync run, a safety net against huge repositories. `null` or
        # "all" removes it entirely and fetches every run the API returns —
        # which on a busy repository is tens of thousands, so the sync warns
        # about the size once it knows it.
        maxWorkflowRuns: 250
        maxLogBytes: 2000000 # job logs are truncated beyond this
        # The same flags as github.sync above; this level wins.
        sync:
          issues: true
          issueComments: true
          issueTimeline: true
          issueReactions: false
          pullRequests: true
          pullRequestReviews: true
          pullRequestComments: true
          pullRequestCommits: true
          pullRequestFiles: true
          labels: true
          milestones: true
          releases: false
          workflows: true
          workflowRuns: true
          workflowJobs: true
          workflowLogs: false

    jira:
      - project: PLAT # (no default) the project key
        site: acme # defaults to the first site above
        # (no default) Extra JQL every synced work item has to match. This is
        # the place to keep sensitive tickets out of the local database.
        filter: labels != security AND issuetype != "Vulnerability"
        since: 12mo # (no default) same meaning as on a repository
        boards: [] # empty means every board of the project
        fields: {} # merged over the site mapping; this level wins
        # The same flags as jira.sync above; this level wins.
        sync:
          workitems: true
          comments: true
          changelog: true
          worklogs: false
          links: true
          attachments: true
          boards: true
          sprints: true
```

## What is not shown here

`token:` on a host and on a site. Both are accepted so that an unusual setup is
not blocked, but writing a credential into a configuration file is the thing
this project asks you not to do — see [Audit](audit.md). Use `tokenEnv`.

## Where the defaults come from

| Group           | Defined in                                     |
| --------------- | ---------------------------------------------- |
| `sync`          | `DEFAULT_SYNC_SETTINGS` in `config/resolve.ts` |
| `github.sync`   | `DEFAULT_GITHUB_SYNC`                          |
| `jira.sync`     | `DEFAULT_JIRA_SYNC`                            |
| everything else | `resolveConfig()` in the same file             |

The starter file that `devcontext init` writes is a different thing: it is
short, opinionated and meant to be edited. See
[Getting started](getting-started.md).
