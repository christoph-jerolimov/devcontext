import { Database, loadConfig, mcpToolsByName } from '@devcontext/cli';
import type { McpToolContext } from '@devcontext/cli';
import { defineTool } from 'eve/tools';

/**
 * Structural copy of eve's (unexported) JSON schema object type. The MCP tool
 * definitions are plain JSON literals, but their `properties` field is typed
 * as `Record<string, unknown>`, which needs a cast to a JSON-value shape.
 */
type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

let context: McpToolContext | undefined;

/**
 * Loads the devcontext configuration (walking up from the working directory,
 * like the CLI does) and opens the database read only. Shared by every tool
 * call; opened lazily so `eve dev` starts even before the first sync.
 */
function toolContext(): McpToolContext {
  if (!context) {
    const config = loadConfig({ configPath: process.env.DEVCONTEXT_CONFIG });
    const db = Database.open(process.env.DEVCONTEXT_DB ?? config.databasePath, {
      create: false,
      readOnly: true,
    });
    context = { config, db };
  }
  return context;
}

/**
 * Bridges one MCP tool into eve. The agent exposes exactly the tools the MCP
 * server exposes — same names, descriptions, input schemas and implementations
 * — so the two assistant surfaces can never drift apart.
 */
export function devcontextTool(name: string) {
  const tool = mcpToolsByName.get(name);
  if (!tool) {
    throw new Error(
      `Unknown devcontext MCP tool "${name}". Available: ${[...mcpToolsByName.keys()].join(', ')}.`,
    );
  }
  return defineTool({
    description: tool.definition.description,
    inputSchema: tool.definition.inputSchema as unknown as JsonObject,
    execute: (input) => tool.run(input, toolContext()),
  });
}
