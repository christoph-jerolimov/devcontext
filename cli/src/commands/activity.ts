import { Command } from 'commander';

import * as activity from '../db/queries/activity.js';
import type { ActivityEvent } from '../db/queries/activity.js';
import { colour, printOutput, renderTable, truncate } from '../output/format.js';
import type { Colour } from '../output/format.js';
import type { Directory } from '../people/directory.js';
import { resolveTimeExpression } from '../util/time.js';
import {
  addListOptions,
  addPeopleFilterOptions,
  collect,
  openReadContext,
  parseLimit,
  readOffset,
  readPeopleFilter,
} from './shared.js';
import type { PeopleFilterOptions } from './shared.js';

/**
 * `devcontext activity` — what people did, newest first.
 *
 * Every other list says what the state of things is. This one says what
 * happened, which cannot be read off the first: an issue that was opened,
 * argued over for a fortnight and closed looks, in the issue list, exactly
 * like one nobody ever touched.
 */
export function createActivityCommand(): Command {
  const command = new Command('activity')
    .aliases(['feed', 'changes'])
    .description('status changes, comments and reviews across GitHub and Jira, newest first')
    .option('--since <when>', 'events at or after this point (7d, 6w, 2024-01-31)', '14d')
    .option('--until <when>', 'events before this point')
    .option('--source <source>', 'github or jira, repeatable', collect, [])
    .option(
      '-c, --container <name>',
      'repository (acme/platform) or Jira project (PLAT), repeatable',
      collect,
      [],
    )
    .option('-k, --kind <kind>', 'status, comment or review, repeatable', collect, [])
    .option('--by-person', 'who was busy in the window, instead of what happened');

  addPeopleFilterOptions(command);

  return addListOptions(command).action((options: Record<string, unknown>, self: Command) => {
    const ctx = openReadContext(self);
    try {
      const people = readPeopleFilter(ctx.config, options as PeopleFilterOptions);
      const directory = people.directory;

      const filter: activity.ActivityFilter = {
        since: when(options['since']),
        until: when(options['until']),
        sources: options['source'] as string[],
        containers: options['container'] as string[],
        kinds: options['kind'] as string[],
        excludeBots: people.excludeBots,
        onlyBots: people.onlyBots,
        // Both sources, because the feed spans them: a Jira display name
        // configured as a bot should be hidden here too.
        bots: directory.botIdentities(),
        limit: parseLimit(options['limit'] as string | undefined),
        offset: readOffset(options),
        ...(people.selection
          ? { people: { github: people.selection.github, jira: people.selection.jira } }
          : {}),
      };

      if (options['byPerson'] === true) {
        const rows = activity.activityByActor(ctx.db, filter);
        printOutput(
          renderTable(
            rows,
            [
              { header: 'SOURCE', value: (row) => row.source },
              { header: 'ACTOR', value: (row) => row.actor },
              {
                header: 'PERSON',
                // The name when the mapping knows it, and nothing when it does
                // not — a blank here is a name worth adding to devcontext.yaml.
                value: (row) => directory.identify(row.source, row.actor)?.name ?? '',
                style: (row) =>
                  directory.identify(row.source, row.actor) === undefined ? 'yellow' : 'gray',
              },
              { header: 'STATUS', value: (row) => row.status, align: 'right' },
              { header: 'COMMENTS', value: (row) => row.comments, align: 'right' },
              { header: 'REVIEWS', value: (row) => row.reviews, align: 'right', optional: true },
              { header: 'TOTAL', value: (row) => row.total, align: 'right' },
              { header: 'LAST', value: (row) => row.lastSeen.slice(0, 10) },
            ],
            {
              format: ctx.format,
              list: ctx.list,
              listValue: (row) => row.actor,
              title: 'Activity by person',
              emptyMessage: 'Nothing happened in this window. Try a wider --since.',
            },
          ),
        );
        return;
      }

      const rows = activity.listActivity(ctx.db, filter);
      const total = activity.countActivity(ctx.db, filter);

      printOutput(
        renderTable(
          rows,
          [
            {
              header: 'WHEN',
              value: (row: ActivityEvent) => row.at.slice(0, 16).replace('T', ' '),
            },
            {
              header: 'WHO',
              value: (row: ActivityEvent) => who(directory, row),
            },
            {
              header: 'DID',
              value: (row: ActivityEvent) => row.action,
              style: (row: ActivityEvent) => actionColour(row),
            },
            { header: 'REF', value: (row: ActivityEvent) => row.ref },
            { header: 'TITLE', value: (row: ActivityEvent) => truncate(row.title, 50) },
            {
              header: 'DETAIL',
              value: (row: ActivityEvent) => truncate(oneLine(row.detail), 40),
              optional: true,
            },
          ],
          {
            format: ctx.format,
            list: ctx.list,
            listValue: (row: ActivityEvent) => row.ref,
            title: 'Activity',
            emptyMessage: 'Nothing happened in this window. Try a wider --since.',
          },
        ),
      );

      // A page is not the answer; saying so beats implying it is.
      if (ctx.format === 'default' && !ctx.list && total > rows.length) {
        printOutput(
          colour(
            `Showing ${String(rows.length)} of ${String(total)} — narrow the window or raise --limit.`,
            'gray',
          ),
        );
      }
    } finally {
      ctx.close();
    }
  });
}

function when(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? resolveTimeExpression(value) : undefined;
}

/** The person's name when the mapping knows it, else the raw identity. */
function who(directory: Directory, row: ActivityEvent): string {
  if (!row.actor) return '';
  return directory.identify(row.source, row.actor)?.name ?? row.actor;
}

/**
 * Green for what opens work, purple for what closes it, and the review colours
 * the pull request list already uses — so a verdict reads the same wherever it
 * appears.
 */
function actionColour(row: ActivityEvent): Colour {
  if (row.action.startsWith('opened') || row.action === 'created' || row.action === 'reopened') {
    return 'green';
  }
  if (row.action === 'merged') return 'purple';
  if (row.action === 'closed') return 'red';
  if (row.action === 'approved') return 'green';
  if (row.action === 'requested changes') return 'yellow';
  return 'gray';
}

/** A comment body is many lines; a table cell is one. */
function oneLine(value: string | null): string {
  return value === null ? '' : value.replaceAll(/\s+/g, ' ').trim();
}
