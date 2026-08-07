# MCP server

```bash
devcontext mcp
```

Serves the local database over the [Model Context
Protocol](https://modelcontextprotocol.io) on stdio, so an AI assistant can
read the complete history of a ticket, a pull request or a CI failure **from
your machine**: no API round trips, no rate limit, no token spent on pagination,
and it works offline.

Everything is read only — the server opens the SQLite file in read-only mode and
exposes no tool that writes anywhere.

## Registering it

Claude Code:

```bash
claude mcp add devcontext -- devcontext mcp --config /path/to/devcontext.yaml
```

Any client that takes a JSON configuration:

```json
{
  "mcpServers": {
    "devcontext": {
      "command": "devcontext",
      "args": ["mcp", "--config", "/path/to/devcontext.yaml"]
    }
  }
}
```

`--config` is optional when the client's working directory is inside a project
that has a `devcontext.yaml`; `--db` points at a database directly.

## Tools

`devcontext mcp --tools` lists them (add `-o json` for the full schemas).

| Tool                                      | What it answers                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `devcontext_status`                       | Which repositories and Jira projects exist locally, row counts, how fresh the data is. The one to call first.   |
| `list_repositories`                       | The synced GitHub repositories                                                                                  |
| `search`                                  | One phrase across issues, pull requests and work items **including their comments**                             |
| `list_issues`                             | Issues by repository, state, label, author, assignee, text, age                                                 |
| `get_issue`                               | One issue: body, every comment, the full timeline                                                               |
| `list_pull_requests`                      | Pull requests, plus merged / base branch / reviewer filters                                                     |
| `get_pull_request`                        | One pull request: commits, changed files, every review with its inline comments, the conversation, the timeline |
| `list_workitems`                          | Jira work items by project, type, status, category, assignee, sprint, epic, text, age                           |
| `get_workitem`                            | One work item: description, custom fields, links, comments, the complete field history                          |
| `list_sprints` / `get_sprint`             | Sprints, and one sprint with its work items and story points                                                    |
| `list_workflow_runs` / `get_workflow_run` | Actions runs, and one run with every job and step                                                               |

Time filters (`updatedSince`, `updatedBefore`) take the same values as the CLI:
`30d`, `6w`, `3mo` or an absolute date. `updatedBefore` is how an assistant
finds stale work.

The tools go through the same query layer as the CLI commands, so what an agent
sees and what you see can never drift apart.

## Things worth asking it

- "What changed on PLAT-42 since it was created, and which pull requests
  reference it?"
- "Which issues in acme/platform have been open and untouched for 90 days?"
- "Why did the last CI run on main fail?" (`list_workflow_runs` →
  `get_workflow_run` gives the failing step directly)
- "Summarise the review discussion on pull request 42."
- "What is in the current sprint, and how many story points are done?"

## Implementation notes

The server implements MCP over stdio directly — JSON-RPC 2.0, one message per
line — rather than depending on the official SDK, which pulls in express, hono,
cors, jose and a dozen more packages for transports this command does not use.
devcontext keeps three runtime dependencies in total, and the stdio wire format
is small and stable.

`initialize`, `ping`, `tools/list`, `tools/call` and the `notifications/*`
messages are handled; `resources/list` and `prompts/list` answer with empty
lists because clients ask for them even when the capability is not advertised.
The protocol revision the client requests is echoed when it is one this server
knows.

Tool failures (a missing argument, an unknown key) come back as a **tool result
with `isError: true`**, not as a JSON-RPC error, so the model can read the
message and correct itself instead of the call blowing up in the client.

Only protocol messages go to stdout; every log line goes to stderr.
