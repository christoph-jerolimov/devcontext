# devcontext

[![CI](https://github.com/christoph-jerolimov/devcontext/actions/workflows/ci.yml/badge.svg)](https://github.com/christoph-jerolimov/devcontext/actions/workflows/ci.yml)

Sync development data locally to give people and AI complete project context.

devcontext downloads what your projects actually happened in — GitHub issues,
pull requests, reviews and Actions runs, Jira work items, comments, history and
sprints — into a local **SQLite database**, and mirrors it into yaml and
markdown files for grepping and reading. Everything then works offline, at the
speed of a local query.

```bash
devcontext sync                                  # GitHub + Jira -> SQLite (+ yaml/markdown)
devcontext gh issues --stale 90d                 # what has been rotting for a quarter
devcontext gh prs 42 -o markdown                 # a pull request with every review
devcontext jira search "rate limit"              # work items, descriptions and comments
devcontext jira stories --sprint "Sprint 7"      # the current sprint
devcontext web                                   # browse it all in the browser
```

## Why

Issue trackers are good at "what is open right now" and bad at everything else.
Once the data is local you can ask real questions with SQL, feed a complete
discussion to an AI assistant without a dozen API calls, keep working on a
plane, and diff two points in time.

## What is synced

**GitHub** — repositories, labels, milestones, issues, every comment, the
complete timeline (labels added and removed, assignments, closes, reopens,
renames, references), pull requests with additions and merge state, every review
and inline review comment with its diff hunk, commit lists, changed files with
patches, workflows, runs, jobs, every step and optionally the full job logs.

**Jira** — projects, the field catalogue, work items (with a JQL filter so
security tickets can stay out), descriptions converted from ADF to markdown,
every comment, the complete field history, issue links, attachment metadata,
boards, sprints and sprint membership. Custom fields get readable names through
a mapping in the configuration.

Every row also keeps the untouched API payload, so nothing is lost.

## Install

Requires Node.js 22.5+ (the database is the built-in `node:sqlite`, so there is
nothing to compile).

```bash
git clone https://github.com/christoph-jerolimov/devcontext.git
cd devcontext
npm install
npm run build
npm link --workspace @devcontext/cli    # optional: puts `devcontext` on your PATH
```

## Configure

```bash
export GITHUB_TOKEN=ghp_...
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...

devcontext init          # writes a commented devcontext.yaml
```

```yaml
version: 1

jira:
  sites:
    - name: acme
      baseUrl: https://acme.atlassian.net
      email: ${JIRA_EMAIL}
      tokenEnv: JIRA_API_TOKEN
      fields:
        customfield_10016: storyPoints

projects:
  - key: platform
    github:
      - repo: acme/platform
      - repo: acme/platform-docs
    jira:
      - project: PLAT
        filter: labels != security
```

A project links any number of GitHub repositories and Jira projects.
See [docs/configuration.md](docs/configuration.md) for every key.

## Sync

```bash
devcontext sync
```

The first run downloads everything; every later run continues from the stored
cursor and only fetches changes. The sync respects API rate limits, keeps a
configurable pause between calls and shows how much work is left:

```
[##########--------------]  42% | 615/1442 calls | 388 items | 3m 12s elapsed | ~4m 20s left | acme/platform: pull requests
```

Each run and each resource is recorded in the database, so `devcontext status`
can always tell you what was synced when, and where the next run will continue.

## Query

Every command speaks `--output default|json|markdown|plain`, and every list
command has `--list` for shell scripts.

```bash
devcontext gh repos
devcontext gh issues --repo acme/platform --label bug --stale 90d
devcontext gh issues 12                       # body + all comments + full timeline
devcontext gh prs --state all --reviewer bob
devcontext gh runs --conclusion failure
devcontext gh steps --conclusion failure -n 20
devcontext gh logs 2001 | grep -i error

devcontext jira workitems --project PLAT --open
devcontext jira epics --list
devcontext jira workitem PLAT-42 -o markdown  # description + comments + full history
devcontext jira sprints --state active
devcontext jira fields --mapped
```

Or go straight to SQL — see [docs/database.md](docs/database.md) for the schema
and a set of ready-made queries (cycle time, review load, flaky steps, scope
creep).

```bash
sqlite3 .devcontext/devcontext.db \
  "SELECT key, summary FROM jira_workitems WHERE status_category = 'In Progress'"
```

## Browse

```bash
devcontext web
```

A local React viewer with the same filters, detail views for issues, pull
requests, workflow runs, work items and sprints, and a JSON API behind it.

## Give it to your AI assistant

```bash
claude mcp add devcontext -- devcontext mcp --config $PWD/devcontext.yaml
```

`devcontext mcp` serves the same data over the Model Context Protocol, so an
assistant can read the full history of a ticket, a review discussion or a CI
failure straight from your machine — no API round trips, no rate limit, and it
works offline. Read only, and it exposes the same queries the CLI uses. See
[docs/mcp.md](docs/mcp.md).

## Repository layout

| Directory       | Contents                                                            |
| --------------- | ------------------------------------------------------------------- |
| [`cli/`](cli)   | The `devcontext` command: sync, database, read commands, web server |
| [`web/`](web)   | The React viewer, served by `devcontext web`                        |
| [`docs/`](docs) | End user documentation                                              |

## Documentation

- [Getting started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Sync](docs/sync.md)
- [CLI reference](docs/cli.md)
- [Outputs](docs/outputs.md)
- [Database](docs/database.md)
- [Web viewer](docs/web.md)
- [MCP server](docs/mcp.md)
- [Development](docs/development.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

Apache-2.0
