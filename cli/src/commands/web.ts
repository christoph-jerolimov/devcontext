import { Command } from 'commander';

import { loadConfig } from '../config/load.js';
import { ensureDatabase, startWebServer } from '../web/server.js';
import { createCommandLogger, parseLimit } from './shared.js';
import type { GlobalOptions } from './shared.js';

export function createWebCommand(): Command {
  return new Command('web')
    .description('serve the React viewer and a JSON API for the local database')
    .option('-p, --port <port>', 'port to listen on')
    .option('--host <host>', 'interface to bind to')
    .action(async (options: { port?: string; host?: string }, self: Command) => {
      const globals = self.optsWithGlobals<GlobalOptions>();
      const logger = createCommandLogger(globals);
      const config = loadConfig({ configPath: globals.config });
      const databasePath = globals.db ?? config.databasePath;

      ensureDatabase(databasePath);

      const port = parseLimit(options.port) ?? config.web.port;
      const host = options.host ?? config.web.host;

      const server = await startWebServer({ config, logger, port, host, databasePath });
      logger.raw(`devcontext web is running on http://${host}:${port}`);
      logger.raw('Press Ctrl+C to stop.');

      const shutdown = () => {
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      // Keep the process alive until the server closes.
      await new Promise<void>((resolve) => server.on('close', () => resolve()));
    });
}
