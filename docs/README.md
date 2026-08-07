# devcontext documentation

devcontext syncs the development data of your projects — GitHub issues, pull
requests and Actions runs, Jira work items, comments, history and sprints —
into a local SQLite database, and mirrors it into yaml and markdown files. The
database is the primary target; the files exist so you (and any tool or AI
assistant on your machine) can grep, diff and read the same data offline.

## Contents

| Document                              | What it covers                                                      |
| ------------------------------------- | ------------------------------------------------------------------- |
| [Getting started](getting-started.md) | Install, configure, first sync, first query                         |
| [Configuration](configuration.md)     | Every key of `devcontext.yaml`                                      |
| [Sync](sync.md)                       | Initial vs. incremental sync, rate limits, progress, what is stored |
| [CLI guide](cli.md)                   | The commands with their filters, output formats and examples        |
| [Command reference](commands.md)      | Generated: every command, argument and option, exhaustively         |
| [Outputs](outputs.md)                 | Layout of the yaml, markdown and json mirrors                       |
| [Database](database.md)               | Table reference and example SQL queries                             |
| [Search](search.md)                   | Full text search across both platforms, and how the index works     |
| [Insights](insights.md)               | Cycle time, review latency, WIP, stale items, flaky steps, sprints  |
| [Digest](digest.md)                   | What happened in a window, for a standup or a weekly update         |
| [Cross links](links.md)               | How GitHub and Jira references are connected                        |
| [Audit](audit.md)                     | What is stored locally, whose data it is, and what a sync fetches   |
| [Web viewer](web.md)                  | The React viewer and the JSON API behind it                         |
| [MCP server](mcp.md)                  | Serving the same data to an AI assistant                            |
| [Development](development.md)         | Monorepo layout, tests, how to extend devcontext                    |
| [Troubleshooting](troubleshooting.md) | Tokens, rate limits, permissions, common errors                     |

## The short version

```bash
npm install                 # once, in the repository root
npm run build

export GITHUB_TOKEN=ghp_...
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...

node cli/bin/devcontext.js init     # writes a commented devcontext.yaml
node cli/bin/devcontext.js sync     # fills .devcontext/devcontext.db + yaml + markdown
node cli/bin/devcontext.js gh issues --stale 90d
node cli/bin/devcontext.js jira stories --sprint "Sprint 7"
node cli/bin/devcontext.js serve      # http://127.0.0.1:4173
node cli/bin/devcontext.js mcp      # serve it to an AI assistant over MCP
```

## Design in one picture

```
GitHub REST API  ─┐
                  ├─►  sync  ─►  SQLite (primary)  ─►  cli read commands
Jira REST API    ─┘      │                          ─►  web viewer (React)
                         └─────►  yaml / markdown / json mirrors (debugging, grep, AI context)
```

Everything the APIs return is preserved: each row keeps the untouched payload
in a `raw` column, and the columns next to it exist so queries stay short.
