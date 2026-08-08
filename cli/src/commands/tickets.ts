import { Command } from 'commander';

import * as tickets from '../db/queries/tickets.js';
import type { Ticket } from '../db/queries/tickets.js';
import { printOutput, renderTable, truncate } from '../output/format.js';
import type { Colour } from '../output/format.js';
import { addListOptions, collect, openReadContext, parseLimit, readOffset } from './shared.js';

/**
 * `devcontext tickets` — GitHub issues and Jira work items in one list.
 *
 * The two already have lists of their own. This one exists because the
 * question "what is open on this project" rarely stops at a system boundary,
 * and answering it otherwise means running two commands and merging the
 * output by hand.
 */
export function createTicketsCommand(): Command {
  const command = new Command('tickets')
    .aliases(['ticket'])
    .description('GitHub issues and Jira work items as one list')
    .option('--source <source>', 'github or jira, repeatable', collect, [])
    .option(
      '-c, --container <name>',
      'repository (acme/platform) or Jira project (PLAT), repeatable',
      collect,
      [],
    )
    .option('-t, --type <type>', 'Bug, Story, Issue, ... repeatable', collect, [])
    .option('-s, --state <state>', 'open, closed or all', 'all')
    .option('--assignee <name>', 'assigned to this person')
    .option('--types', 'list the types present and how many carry each, instead')
    .option('--containers', 'list the repositories and projects present, instead');

  return addListOptions(command).action((options: Record<string, unknown>, self: Command) => {
    const filter: tickets.TicketFilter = {
      sources: options['source'] as string[],
      containers: options['container'] as string[],
      types: options['type'] as string[],
      state: options['state'] as 'open' | 'closed' | 'all',
      assignee: options['assignee'] as string | undefined,
      search: options['search'] as string | undefined,
      limit: parseLimit(options['limit'] as string | undefined),
      offset: readOffset(options),
    };

    const ctx = openReadContext(self);
    try {
      if (options['types'] === true) {
        const rows = tickets.ticketTypes(ctx.db, filter);
        printOutput(
          renderTable(
            rows,
            [
              { header: 'SOURCE', value: (row) => row.source },
              { header: 'TYPE', value: (row) => row.type },
              { header: 'TICKETS', value: (row) => row.count, align: 'right' },
            ],
            {
              format: ctx.format,
              list: ctx.list,
              listValue: (row) => row.type,
              title: 'Ticket types',
              emptyMessage: 'No tickets are synced yet. Run "devcontext sync" first.',
            },
          ),
        );
        return;
      }

      if (options['containers'] === true) {
        const rows = tickets.ticketContainers(ctx.db, filter);
        printOutput(
          renderTable(
            rows,
            [
              { header: 'SOURCE', value: (row) => row.source },
              { header: 'CONTAINER', value: (row) => row.container },
              { header: 'TICKETS', value: (row) => row.count, align: 'right' },
            ],
            {
              format: ctx.format,
              list: ctx.list,
              listValue: (row) => row.container,
              title: 'Repositories and projects',
              emptyMessage: 'No tickets are synced yet. Run "devcontext sync" first.',
            },
          ),
        );
        return;
      }

      const rows = tickets.listTickets(ctx.db, filter);
      printOutput(
        renderTable(
          rows,
          [
            { header: 'REF', value: (row: Ticket) => row.ref },
            { header: 'TYPE', value: (row: Ticket) => row.type, optional: true },
            { header: 'TITLE', value: (row: Ticket) => truncate(row.title, 60) },
            {
              header: 'STATUS',
              value: (row: Ticket) => row.status ?? '',
              style: (row: Ticket) => stateColour(row),
            },
            { header: 'ASSIGNEE', value: (row: Ticket) => row.assignee ?? '' },
            { header: 'UPDATED', value: (row: Ticket) => row.updated_at?.slice(0, 10) ?? '' },
          ],
          {
            format: ctx.format,
            list: ctx.list,
            listValue: (row: Ticket) => row.ref,
            title: 'Tickets',
            emptyMessage: 'Nothing matched. Try --state all, or a wider --container.',
          },
        ),
      );
    } finally {
      ctx.close();
    }
  });
}

/** Green while it is somebody's problem, dim once it is not. */
function stateColour(row: Ticket): Colour {
  return row.state === 'open' ? 'green' : 'gray';
}
