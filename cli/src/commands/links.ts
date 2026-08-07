import { Command } from 'commander';

import { loadConfig } from '../config/load.js';
import { Database } from '../db/database.js';
import * as links from '../db/queries/links.js';
import { buildCrossLinks } from '../links/build.js';
import { printOutput, renderKeyValues, renderTable, truncate } from '../output/format.js';
import { parseOutputFormat } from '../output/format.js';
import type { CrossLinkRow } from '../links/build.js';
import {
  addListOptions,
  collect,
  createCommandLogger,
  openReadContext,
  parseLimit,
  readOffset,
} from './shared.js';
import type { GlobalOptions } from './shared.js';

export function createLinksCommand(): Command {
  const command = new Command('links')
    .alias('link')
    .description('cross references between GitHub issues/pull requests and Jira work items')
    .argument('[ref]', 'only links touching this reference (acme/platform#42 or PLAT-7)')
    .option('--rebuild', 'recompute the links from the synced text before listing')
    .option('--via <source>', 'branch, title, body, commit or comment, repeatable', collect, [])
    .option('--high', 'only high confidence links (branch names, titles, Jira fields)')
    .option('--from <source>', 'github or jira')
    .option('--to <source>', 'github or jira');

  return addListOptions(command).action(
    async (ref: string | undefined, options: Record<string, unknown>, self: Command) => {
      if (options['rebuild'] === true) {
        await rebuild(self);
      }

      const ctx = openReadContext(self);
      try {
        const rows = links.listLinks(ctx.db, {
          ref,
          fromSource: options['from'] as string | undefined,
          toSource: options['to'] as string | undefined,
          via: (options['via'] as string[]).length > 0 ? (options['via'] as string[]) : undefined,
          minConfidence: options['high'] === true ? 'high' : undefined,
          limit: parseLimit(options['limit'] as string | undefined),
          offset: readOffset(options),
        });

        printOutput(
          renderTable(
            rows,
            [
              { header: 'FROM', value: (row: CrossLinkRow) => row.from_ref },
              { header: 'KIND', value: (row: CrossLinkRow) => row.from_kind, optional: true },
              { header: 'TO', value: (row: CrossLinkRow) => row.to_ref },
              { header: 'VIA', value: (row: CrossLinkRow) => row.via },
              {
                header: 'CONFIDENCE',
                value: (row: CrossLinkRow) => row.confidence,
                optional: true,
              },
              {
                header: 'MATCH',
                value: (row: CrossLinkRow) => truncate(row.detail, 40),
                optional: true,
              },
            ],
            {
              format: ctx.format,
              list: ctx.list,
              listValue: (row: CrossLinkRow) => `${row.from_ref}\t${row.to_ref}`,
              title: ref ? `Links for ${ref}` : 'Cross references',
              emptyMessage:
                'No cross references found. Run "devcontext links --rebuild" after a sync, or check that the Jira keys appear in branch names, titles or commit messages.',
            },
          ),
        );
      } finally {
        ctx.close();
      }
    },
  );
}

/** Recomputes the table; also used by `devcontext sync`. */
async function rebuild(self: Command): Promise<void> {
  const globals = self.optsWithGlobals<GlobalOptions>();
  const logger = createCommandLogger(globals);
  const config = loadConfig({ configPath: globals.config });
  const databasePath = globals.db ?? config.databasePath;

  const db = Database.openAndMigrate(databasePath);
  try {
    const result = buildCrossLinks(db);
    logger.info(`Found ${result.links} cross reference(s).`);
    if (result.danglingJiraKeys.length > 0) {
      logger.info(
        `${result.danglingJiraKeys.length} referenced Jira key(s) are not synced, e.g. ${result.danglingJiraKeys.slice(0, 5).join(', ')}.`,
      );
    }
    if (globals.output === 'json') {
      printOutput(JSON.stringify(result, null, 2));
    } else if (globals.verbose) {
      printOutput(
        renderKeyValues(
          Object.entries(result.byVia).map(([via, count]) => [via, count] as [string, number]),
          parseOutputFormat(globals.output),
        ),
      );
    }
  } finally {
    db.close();
  }
}
