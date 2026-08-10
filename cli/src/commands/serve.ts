import { Command } from 'commander';

import { loadConfig } from '../config/load.js';
import { runSync } from '../sync/runner.js';
import { SyncScheduler } from '../sync/watch.js';
import { ensureDatabase, startWebServer } from '../web/server.js';
import { CliError } from '../util/errors.js';
import { formatDuration } from '../util/time.js';
import { createCommandLogger, parseLimit } from './shared.js';
import type { GlobalOptions } from './shared.js';

const DEFAULT_WATCH_SECONDS = 300;
const MINIMUM_WATCH_SECONDS = 30;

export function createServeCommand(): Command {
  return (
    new Command('serve')
      // `web` was the original name; it stays so existing scripts keep working.
      .alias('web')
      .description('serve the React viewer and a JSON API for the local database')
      .option('-p, --port <port>', 'port to listen on')
      .option('--host <host>', 'interface to bind to')
      .option(
        '--watch [seconds]',
        `also sync on an interval while serving (default every ${String(DEFAULT_WATCH_SECONDS)}s)`,
      )
      .action(
        async (
          options: { port?: string; host?: string; watch?: string | boolean },
          self: Command,
        ) => {
          const globals = self.optsWithGlobals<GlobalOptions>();
          const logger = createCommandLogger(globals);
          const config = loadConfig({ configPath: globals.config });
          const databasePath = globals.db ?? config.databasePath;
          if (globals.db) config.databasePath = globals.db;

          ensureDatabase(databasePath);

          const port = parseLimit(options.port) ?? config.web.port;
          const host = options.host ?? config.web.host;

          const watch = resolveWatch(options.watch);
          const scheduler = watch
            ? new SyncScheduler({
                intervalMs: watch.intervalMs,
                logger,
                // The same sync the command runs, minus the progress bar — its
                // terminal is busy being a server log. Progress still goes two
                // places: to the scheduler for the connected viewers, and to
                // the log every 10%, so an hours-long sync is never silent.
                run: (ctx) => {
                  let lastMilestone = 0;
                  return runSync({
                    config,
                    logger,
                    full: false,
                    dryRun: false,
                    progress: false,
                    writeOutputs: true,
                    onProgress: (snapshot) => {
                      ctx.report(snapshot);
                      const expected = Math.max(snapshot.apiCallsExpected, snapshot.apiCalls);
                      if (expected === 0) return;
                      const milestone = Math.floor((snapshot.apiCalls / expected) * 10);
                      if (milestone <= lastMilestone) return;
                      lastMilestone = milestone;
                      const parts = [
                        `Background sync ${String(milestone * 10)}%`,
                        `${String(snapshot.apiCalls)}/${String(expected)} calls`,
                      ];
                      if (snapshot.etaMs !== null && snapshot.etaMs > 0) {
                        parts.push(`about ${formatDuration(snapshot.etaMs)} left`);
                      }
                      if (snapshot.position) parts.push(`on ${snapshot.position}`);
                      logger.info(parts.join(', ') + '.');
                    },
                  });
                },
              })
            : null;

          const server = await startWebServer({
            config,
            logger,
            port,
            host,
            databasePath,
            ...(watch && scheduler ? { watch: { scheduler, intervalMs: watch.intervalMs } } : {}),
          });
          logger.raw(`devcontext is serving the viewer on http://${host}:${port}`);
          if (watch && scheduler) {
            scheduler.subscribe((event) => {
              if (event.event === 'sync-started') logger.info('Background sync started.');
              if (event.event === 'sync-completed') {
                logger.info(
                  event.status === 'completed'
                    ? `Background sync completed in ${formatDuration(event.durationMs)}.`
                    : `Background sync failed after ${formatDuration(event.durationMs)}.`,
                );
              }
            });
            scheduler.start();
            logger.raw(`Syncing every ${String(Math.round(watch.intervalMs / 1000))}s.`);
          }
          logger.raw('Press Ctrl+C to stop.');

          const shutdown = () => {
            scheduler?.stop();
            server.close(() => process.exit(0));
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);

          // Keep the process alive until the server closes.
          await new Promise<void>((resolve) => server.on('close', () => resolve()));
        },
      )
  );
}

function resolveWatch(option: string | boolean | undefined): { intervalMs: number } | null {
  if (option === undefined || option === false) return null;
  if (option === true) return { intervalMs: DEFAULT_WATCH_SECONDS * 1000 };

  const seconds = parseLimit(option);
  if (seconds === undefined) {
    throw new CliError(`--watch expects a number of seconds, not "${option}".`);
  }
  if (seconds < MINIMUM_WATCH_SECONDS) {
    // A one-second loop is a rate-limit incident, not liveness.
    throw new CliError(
      `--watch ${String(seconds)} is too eager; the minimum is ${String(MINIMUM_WATCH_SECONDS)} seconds.`,
    );
  }
  return { intervalMs: seconds * 1000 };
}
