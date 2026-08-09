import { Command } from 'commander';

import * as history from '../db/queries/history.js';
import type { OpenOnDay } from '../db/queries/history.js';
import { colour, printOutput, renderTable } from '../output/format.js';
import { resolveTimeExpression } from '../util/time.js';
import { loadConfig } from '../config/load.js';
import { Database } from '../db/database.js';
import { buildStateHistory } from '../history/build.js';
import { addListOptions, createCommandLogger, openReadContext } from './shared.js';
import type { GlobalOptions } from './shared.js';

/**
 * `devcontext history` — how many items were open, when.
 *
 * The current tables cannot answer this. An item that was opened in January,
 * closed in February and reopened in March is one row saying "open", and that
 * row is the same whichever of those months you ask about. So the answer comes
 * from `state_changes`, which keeps the transitions rather than the outcome.
 */
export function createHistoryCommand(): Command {
  const command = new Command('history')
    .description('how many issues, pull requests or work items were open over time')
    .option('--from <when>', 'start of the window (30d, 2024-01-31)', '30d')
    .option('--to <when>', 'end of the window', 'now')
    .option('--source <source>', 'github or jira')
    .option('--container <name>', 'one repository (acme/platform) or Jira project (PLAT)')
    .option('--kind <kind>', 'issue, pull_request or workitem')
    .option('--assignee <person>', 'only items assigned to this person at the time')
    .option('--sprint <id>', 'only items in this sprint at the time')
    .option('--rebuild', 'recompute the history from the synced timelines before reading it');

  return addListOptions(command).action((options: Record<string, unknown>, self: Command) => {
    const now = new Date();
    const from = resolveTimeExpression(String(options['from'] ?? '30d'), now) ?? now.toISOString();
    const to =
      options['to'] === 'now'
        ? now.toISOString()
        : (resolveTimeExpression(String(options['to']), now) ?? now.toISOString());

    const filters = {
      source: options['source'] as string | undefined,
      container: options['container'] as string | undefined,
      kind: options['kind'] as string | undefined,
    };

    // A sync rebuilds this, but a database synced by an older version has no
    // history at all, and re-syncing to get it would be absurd when every
    // event it is derived from is already stored.
    if (options['rebuild'] === true) rebuild(self);

    const ctx = openReadContext(self);
    try {
      const rows = history.openByDay(ctx.db, {
        from,
        to,
        ...filters,
        assignee: options['assignee'] as string | undefined,
        sprint: options['sprint'] as string | undefined,
      });

      printOutput(
        renderTable(
          rows,
          [
            { header: 'DAY', value: (row: OpenOnDay) => row.day },
            { header: 'OPEN', value: (row: OpenOnDay) => row.open, align: 'right' },
            {
              header: 'OPENED',
              value: (row: OpenOnDay) => (row.opened === 0 ? '' : `+${String(row.opened)}`),
              style: () => 'green',
              align: 'right',
            },
            {
              header: 'CLOSED',
              value: (row: OpenOnDay) => (row.closed === 0 ? '' : `-${String(row.closed)}`),
              style: () => 'red',
              align: 'right',
            },
            {
              header: '',
              value: (row: OpenOnDay) => bar(row.open, rows),
              optional: true,
            },
          ],
          {
            format: ctx.format,
            list: ctx.list,
            listValue: (row: OpenOnDay) => `${row.day}\t${String(row.open)}`,
            title: `Open from ${from.slice(0, 10)} to ${to.slice(0, 10)}`,
            emptyMessage:
              'No history yet. It is built after every sync; run "devcontext sync" once.',
          },
        ),
      );
    } finally {
      ctx.close();
    }
  });
}

/**
 * A bar scaled to the tallest day in the window.
 *
 * A column of numbers hides the shape of a month; the point of asking for a
 * month at a time is to see whether the line is going up.
 */
function bar(value: number, rows: OpenOnDay[]): string {
  const peak = Math.max(...rows.map((row) => row.open), 1);
  const width = Math.round((value / peak) * 24);
  return colour('█'.repeat(width), 'gray');
}

/** Recomputes the table from the timelines and changelogs already stored. */
function rebuild(self: Command): void {
  const globals = self.optsWithGlobals<GlobalOptions>();
  const logger = createCommandLogger(globals);
  const config = loadConfig({ configPath: globals.config });

  const db = Database.openAndMigrate(globals.db ?? config.databasePath);
  try {
    const stats = buildStateHistory(db);
    logger.info(
      `Tracked ${String(stats.changes)} state change(s) across ${String(stats.items)} item(s).`,
    );
  } finally {
    db.close();
  }
}
