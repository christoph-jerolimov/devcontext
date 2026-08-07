import { Command } from 'commander';

import { loadConfig } from '../config/load.js';
import { Database } from '../db/database.js';
import { printOutput, renderKeyValues, renderTable, truncate } from '../output/format.js';
import { buildSearchIndex, searchAll, searchIndexAvailable } from '../search/index.js';
import type { SearchHit } from '../search/index.js';
import { CliError } from '../util/errors.js';
import { addOutputOptions, collect, createCommandLogger, openReadContext } from './shared.js';
import type { GlobalOptions } from './shared.js';

const KINDS = ['issue', 'pull-request', 'workitem'] as const;

export function createSearchCommand(): Command {
  const command = new Command('search')
    .aliases(['find', 'q'])
    .description('full text search across issues, pull requests, work items and their comments')
    .argument('[query...]', 'words to look for; quote a phrase to match it exactly')
    .option('-k, --kind <kind>', `restrict to ${KINDS.join(', ')}, repeatable`, collect, [])
    .option('-r, --repo <repo>', 'GitHub repository, repeatable', collect, [])
    .option('-p, --project <key>', 'Jira project key, repeatable', collect, [])
    .option('--exact', 'do not treat the last word as a prefix')
    .option('-n, --limit <count>', 'maximum number of hits', '25')
    .option('--offset <count>', 'skip this many hits')
    .option('--rebuild', 'rebuild the index and exit');

  return addOutputOptions(command).action(
    async (words: string[], options: Record<string, unknown>, self: Command) => {
      if (options['rebuild'] === true) {
        await rebuild(self);
        return;
      }

      const query = words.join(' ').trim();
      if (query === '') {
        throw new CliError('Nothing to search for.', {
          hint: 'Pass words to look for, e.g. devcontext search "rate limit".',
        });
      }

      for (const kind of options['kind'] as string[]) {
        if (!KINDS.includes(kind as (typeof KINDS)[number])) {
          throw new CliError(`Unknown kind "${kind}".`, {
            hint: `Use one of ${KINDS.join(', ')}.`,
          });
        }
      }

      const ctx = openReadContext(self);
      try {
        if (!searchIndexAvailable(ctx.db)) {
          ctx.logger.warn(
            'This SQLite build has no FTS5, so devcontext is scanning the tables instead. Results are the same, just slower.',
          );
        }

        const containers = [
          ...(options['repo'] as string[]),
          ...(options['project'] as string[]).map((key) => key.toUpperCase()),
        ];

        const hits = searchAll(ctx.db, query, {
          kinds: (options['kind'] as string[]).length
            ? (options['kind'] as Array<SearchHit['kind']>)
            : undefined,
          containers: containers.length > 0 ? containers : undefined,
          limit: Number(options['limit']) || 25,
          offset: Number(options['offset']) || 0,
          prefix: options['exact'] !== true,
        });

        printOutput(
          renderTable(
            hits,
            [
              { header: 'REF', value: (row) => row.ref },
              { header: 'KIND', value: (row) => row.kind, optional: true },
              { header: 'STATE', value: (row) => row.state, optional: true },
              { header: 'TITLE', value: (row) => truncate(row.title, 60) },
              { header: 'MATCH', value: (row) => truncate(row.snippet, 60), optional: true },
            ],
            {
              format: ctx.format,
              list: ctx.list,
              listValue: (row) => row.ref,
              emptyMessage: `Nothing matches "${query}".`,
            },
          ),
        );
      } finally {
        ctx.close();
      }
    },
  );
}

/** Recomputes the index; also used by `devcontext sync`. */
async function rebuild(self: Command): Promise<void> {
  const globals = self.optsWithGlobals<GlobalOptions>();
  const logger = createCommandLogger(globals);
  const config = loadConfig({ configPath: globals.config });

  const db = Database.openAndMigrate(globals.db ?? config.databasePath);
  try {
    if (!searchIndexAvailable(db)) {
      throw new CliError('This SQLite build has no FTS5, so there is no index to rebuild.', {
        hint: 'Search still works by scanning the tables; no action is needed.',
      });
    }

    const stats = buildSearchIndex(db);
    logger.info(`Indexed ${stats.rows} item(s).`);
    if (globals.output === 'json') {
      printOutput(JSON.stringify(stats, null, 2));
    } else {
      printOutput(
        renderKeyValues(
          [
            ['Issues', stats.issues],
            ['Pull requests', stats.pullRequests],
            ['Work items', stats.workitems],
          ],
          'default',
        ),
      );
    }
  } finally {
    db.close();
  }
  await Promise.resolve();
}
