import { existsSync, statSync } from 'node:fs';

import { Command } from 'commander';

import { loadConfig } from '../config/load.js';
import { Database } from '../db/database.js';
import { SyncJournal } from '../db/journal.js';
import type { SyncRunRow } from '../db/journal.js';
import { githubStats } from '../db/queries/github.js';
import { jiraStats } from '../db/queries/jira.js';
import { printOutput, renderKeyValues, renderTable } from '../output/format.js';
import { formatDuration, formatRelative } from '../util/time.js';
import { addOutputOptions, createCommandLogger, parseLimit } from './shared.js';
import type { GlobalOptions } from './shared.js';
import { parseOutputFormat } from '../output/format.js';

export function createStatusCommand(): Command {
  const command = new Command('status')
    .description('show the configuration, what is in the database and the last sync runs')
    .option('-n, --limit <count>', 'number of sync runs to show', '10');

  return addOutputOptions(command).action((options: Record<string, unknown>, self: Command) => {
    const globals = self.optsWithGlobals<GlobalOptions>();
    const logger = createCommandLogger(globals);
    const format = parseOutputFormat(globals.output);
    const config = loadConfig({ configPath: globals.config });
    const databasePath = globals.db ?? config.databasePath;

    const targets = config.projects.flatMap((project) => [
      ...project.github.map((repo) => `github:${repo.fullName}`),
      ...project.jira.map((jiraProject) => `jira:${jiraProject.projectKey}`),
    ]);

    if (!existsSync(databasePath)) {
      const info: Array<[string, string]> = [
        ['Configuration', config.configPath],
        ['Database', `${databasePath} (does not exist yet)`],
        ['Projects', config.projects.map((project) => project.key).join(', ')],
        ['Targets', targets.join(', ')],
      ];
      printOutput(renderKeyValues(info, format));
      logger.info('Run "devcontext sync" to create the database.');
      return;
    }

    const db = Database.open(databasePath, { create: false, readOnly: true });
    try {
      const journal = new SyncJournal(db);
      const runs = journal.listRuns({ limit: parseLimit(options['limit'] as string) ?? 10 });
      const state = journal.listState();
      const github = githubStats(db);
      const jira = jiraStats(db);

      if (format === 'json') {
        printOutput(
          JSON.stringify(
            {
              configPath: config.configPath,
              databasePath,
              databaseBytes: statSync(databasePath).size,
              projects: config.projects.map((project) => ({
                key: project.key,
                name: project.name,
                github: project.github.map((repo) => repo.fullName),
                jira: project.jira.map((entry) => `${entry.site.name}/${entry.projectKey}`),
              })),
              outputs: config.outputs,
              github,
              jira,
              runs,
              state,
            },
            null,
            2,
          ),
        );
        return;
      }

      printOutput(
        renderKeyValues(
          [
            ['Configuration', config.configPath],
            ['Database', databasePath],
            ['Database size', `${Math.round(statSync(databasePath).size / 1024)} KiB`],
            ['Projects', config.projects.map((project) => project.key).join(', ')],
            ['Targets', targets.join(', ')],
            [
              'Outputs',
              Object.entries(config.outputs)
                .filter(([, target]) => target.enabled)
                .map(([name, target]) => `${name} -> ${target.path}`)
                .join(', ') || 'none',
            ],
          ],
          format,
        ),
      );

      printOutput('');
      printOutput(
        renderKeyValues(
          [
            ...Object.entries(github).map(
              ([key, value]) => [`github.${key}`, value] as [string, number],
            ),
            ...Object.entries(jira).map(
              ([key, value]) => [`jira.${key}`, value] as [string, number],
            ),
          ],
          format,
        ),
      );

      printOutput('');
      printOutput(
        renderTable(
          runs,
          [
            { header: 'ID', value: (row: SyncRunRow) => row.id, align: 'right' },
            { header: 'SOURCE', value: (row: SyncRunRow) => row.source },
            { header: 'TARGET', value: (row: SyncRunRow) => row.target },
            { header: 'MODE', value: (row: SyncRunRow) => row.mode },
            { header: 'STATUS', value: (row: SyncRunRow) => row.status },
            { header: 'CALLS', value: (row: SyncRunRow) => row.api_calls, align: 'right' },
            { header: 'ITEMS', value: (row: SyncRunRow) => row.items_synced, align: 'right' },
            {
              header: 'DURATION',
              value: (row: SyncRunRow) =>
                row.duration_ms === null ? '' : formatDuration(row.duration_ms),
              align: 'right',
            },
            { header: 'STARTED', value: (row: SyncRunRow) => formatRelative(row.started_at) },
          ],
          { format, title: 'Recent sync runs', emptyMessage: 'No sync run recorded yet.' },
        ),
      );

      printOutput('');
      printOutput(
        renderTable(
          state,
          [
            { header: 'SCOPE', value: (row) => row.scope },
            { header: 'CURSOR', value: (row) => row.cursor },
            { header: 'UPDATED', value: (row) => formatRelative(row.updated_at) },
          ],
          {
            format,
            title: 'Sync state (where the next incremental sync continues)',
            emptyMessage: 'No sync state stored yet.',
          },
        ),
      );
    } finally {
      db.close();
    }
  });
}
