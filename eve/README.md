# @devcontext/eve

> **Experimental.** This workspace, its commands and its configuration may
> change or disappear in any release. The rest of devcontext does not depend
> on it.

An agent built on the [eve framework](https://eve.dev) that answers questions
about the local devcontext database. It exposes exactly the tools the MCP
server exposes — bridged from `cli/src/mcp/tools.ts`, so the two surfaces can
never drift apart — and talks to Anthropic Claude served through Google
Vertex AI (`@ai-sdk/google-vertex/anthropic`, model `claude-opus-4-6`).

Start it from the repository root (Node.js >= 24):

```bash
npm run agent          # or: npm run eve
node cli/bin/devcontext.js agent
```

Set `ANTHROPIC_VERTEX_PROJECT_ID` (and optionally
`ANTHROPIC_VERTEX_LOCATION`, default `global`) and authenticate with Google
application default credentials.

See [docs/agent.md](../docs/agent.md) for the full picture.
