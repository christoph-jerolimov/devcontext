# Agent (experimental)

> **Experimental.** The agent, its commands and its configuration may change or
> disappear in any release. The rest of devcontext does not depend on it.

The `eve/` workspace (`@devcontext/eve`) is an agent built on the
[eve framework](https://eve.dev) that answers questions about the local
database in a conversation instead of a query. It exposes **exactly the tools
the MCP server exposes** — same names, descriptions, input schemas and
implementations, bridged from `cli/src/mcp/tools.ts` — so the MCP surface and
the agent can never drift apart. Everything stays read only and local.

## Model

The agent talks to Anthropic Claude served through **Google Vertex AI**, using
the AI SDK's Anthropic-on-Vertex provider (`@ai-sdk/google-vertex/anthropic`)
configured in `eve/agent/agent.ts` with the `claude-opus-4-6` model.

> The community `anthropic-vertex-ai` provider package is not used because it
> targets the AI SDK v1 model specification and zod 3, which eve (ai 7, zod 4)
> cannot load; the AI SDK's own provider offers the same models and the same
> Google authentication.

Authentication is Google [application default
credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
(`gcloud auth application-default login`, or a service account). Two
environment variables select the project and region:

| Variable                      | Meaning                             |
| ----------------------------- | ----------------------------------- |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Google Cloud project id             |
| `ANTHROPIC_VERTEX_LOCATION`   | Vertex region, defaults to `global` |

## Start it

Requires Node.js >= 24 and a synced database (`devcontext sync`). From the
repository root, any of:

```bash
npm run agent          # or: npm run eve
node cli/bin/devcontext.js agent
```

Both start `eve dev`, which serves the agent on `http://127.0.0.1:2000/` and
opens a terminal REPL. `devcontext agent` forwards extra arguments to
`eve dev` (for example `devcontext agent --no-ui`) and passes `--config` /
`--db` on to the tools via `DEVCONTEXT_CONFIG` / `DEVCONTEXT_DB`.

## Tools

`devcontext mcp --tools` lists them; the agent has the same fourteen, from
`devcontext_status` to `get_workflow_run`. Each tool file under
`eve/agent/tools/` is a one-line bridge:

```ts
import { devcontextTool } from '../lib/devcontext.js';

export default devcontextTool('search');
```

`eve/agent/lib/devcontext.ts` loads the configuration the same way the CLI
does (walking up from the working directory) and opens the database read only.
