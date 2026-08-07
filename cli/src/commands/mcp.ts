import { Command } from 'commander';

import { loadConfig } from '../config/load.js';
import { Database } from '../db/database.js';
import { serveStdio } from '../mcp/server.js';
import { TOOLS } from '../mcp/tools.js';
import { printOutput, renderTable } from '../output/format.js';
import { parseOutputFormat } from '../output/format.js';
import { ensureDatabase } from '../web/server.js';
import { createCommandLogger } from './shared.js';
import type { GlobalOptions } from './shared.js';
import { addOutputOptions } from './shared.js';

export function createMcpCommand(): Command {
  const command = new Command('mcp')
    .description('serve the local database over the Model Context Protocol (stdio)')
    .option('--tools', 'list the exposed tools and exit')
    .addHelpText(
      'after',
      `
Register it with an MCP client, for example in Claude Code:

  claude mcp add devcontext -- devcontext mcp --config /path/to/devcontext.yaml

or in a client configuration file:

  {
    "mcpServers": {
      "devcontext": {
        "command": "devcontext",
        "args": ["mcp", "--config", "/path/to/devcontext.yaml"]
      }
    }
  }
`,
    );

  return addOutputOptions(command).action(async (options: { tools?: boolean }, self: Command) => {
    const globals = self.optsWithGlobals<GlobalOptions>();
    const logger = createCommandLogger(globals);

    if (options.tools) {
      const format = parseOutputFormat(globals.output);
      printOutput(
        renderTable(
          TOOLS.map((tool) => tool.definition),
          [
            { header: 'TOOL', value: (row) => row.name },
            { header: 'DESCRIPTION', value: (row) => row.description },
          ],
          {
            format,
            list: Boolean(globals.list),
            listValue: (row) => row.name,
            title: 'MCP tools',
            json: TOOLS.map((tool) => tool.definition),
          },
        ),
      );
      return;
    }

    const config = loadConfig({ configPath: globals.config });
    const databasePath = globals.db ?? config.databasePath;
    ensureDatabase(databasePath);

    const db = Database.open(databasePath, { create: false, readOnly: true });
    try {
      // stdout carries protocol messages only; everything else goes to stderr.
      logger.info(`devcontext MCP server on stdio, serving ${databasePath}`);
      await serveStdio({ db, config, logger });
    } finally {
      db.close();
    }
  });
}
