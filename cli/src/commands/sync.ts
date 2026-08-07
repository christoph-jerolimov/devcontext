import { Command } from 'commander';

import { loadConfig } from '../config/load.js';
import { runSync } from '../sync/runner.js';
import type { SyncSource } from '../sync/runner.js';
import type { TargetSyncResult } from '../sync/types.js';
import { CliError } from '../util/errors.js';
import { formatDuration } from '../util/time.js';
import { printOutput, renderTable } from '../output/format.js';
import { addOutputOptions, collect, createCommandLogger, parseLimit } from './shared.js';
import type { GlobalOptions } from './shared.js';

export function createSyncCommand(): Command {
  const command = new Command('sync')
    .description('fetch GitHub and Jira data into the SQLite database and the configured outputs')
    .option('-p, --project <key>', 'only sync this project, repeatable', collect, [])
    .option('-s, --source <source>', 'github or jira, repeatable', collect, [])
    .option(
      '-t, --target <name>',
      'only sync this repository or Jira project, repeatable',
      collect,
      [],
    )
    .option('--full', 'ignore stored cursors and download everything again')
    .option('--dry-run', 'fetch from the APIs without writing anything')
    .option('--no-progress', 'do not render the progress indicator')
    .option('--no-outputs', 'skip the yaml / markdown / json outputs')
    .option('--delay <ms>', 'minimum delay between two API calls, overrides the configuration');

  return addOutputOptions(command).action(
    async (options: Record<string, unknown>, self: Command) => {
      const globals = self.optsWithGlobals<GlobalOptions>();
      const logger = createCommandLogger(globals);
      const config = loadConfig({ configPath: globals.config });

      if (globals.db) config.databasePath = globals.db;

      const delay = parseLimit(options['delay'] as string | undefined);
      if (delay !== undefined) config.sync.minDelayMs = delay;

      const sources = (options['source'] as string[]).map((source) => {
        const normalised = source.toLowerCase();
        if (normalised !== 'github' && normalised !== 'jira') {
          throw new CliError(`Unknown source "${source}". Use github or jira.`);
        }
        return normalised as SyncSource;
      });

      logger.info(`Using configuration ${config.configPath}`);
      logger.info(`Database ${config.databasePath}`);

      const summary = await runSync({
        config,
        logger,
        projects: options['project'] as string[],
        sources,
        targets: options['target'] as string[],
        full: Boolean(options['full']),
        dryRun: Boolean(options['dryRun']),
        progress: options['progress'] !== false,
        writeOutputs: options['outputs'] !== false,
      });

      const format = globals.output === undefined ? 'default' : globals.output;

      if (format === 'json') {
        printOutput(JSON.stringify(summary, null, 2));
      } else {
        printOutput(
          renderTable(
            summary.results,
            [
              { header: 'SOURCE', value: (row) => row.source },
              { header: 'TARGET', value: (row) => row.target },
              { header: 'MODE', value: (row) => row.mode },
              { header: 'STATUS', value: (row) => row.status },
              { header: 'API CALLS', value: (row) => row.apiCalls, align: 'right' },
              { header: 'ITEMS', value: (row) => row.items, align: 'right' },
              { header: 'ERROR', value: (row) => row.error ?? '', optional: true },
            ],
            {
              format: format === 'markdown' || format === 'plain' ? format : 'default',
              title: 'Sync summary',
              emptyMessage: 'Nothing was synced; check the project and target filters.',
            },
          ),
        );
        logger.info(
          `Done in ${formatDuration(summary.durationMs)} with ${summary.apiCalls} API call(s) and ${summary.items} item(s).` +
            (summary.export ? ` Wrote ${summary.export.files} output file(s).` : ''),
        );
      }

      const failed = summary.results.filter(
        (result: TargetSyncResult) => result.status === 'failed',
      );
      if (failed.length > 0) {
        throw new CliError(
          `${failed.length} of ${summary.results.length} sync target(s) failed: ${failed
            .map((result) => `${result.target} (${result.error ?? 'unknown error'})`)
            .join('; ')}`,
        );
      }
    },
  );
}
