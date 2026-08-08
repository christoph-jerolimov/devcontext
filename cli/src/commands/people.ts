import { Command } from 'commander';

import type { Person } from '../config/types.js';
import { identityActivity, unmappedIdentities } from '../db/queries/people.js';
import type { IdentityActivity } from '../db/queries/people.js';
import { printOutput, renderTable } from '../output/format.js';
import { Directory } from '../people/directory.js';
import { addOutputOptions, collect, openReadContext } from './shared.js';

/**
 * `devcontext people` — who the configuration knows about, and how much of the
 * data actually reaches them.
 *
 * The counts are the point. A mapping is a list of strings somebody typed, and
 * a login with a typo in it is indistinguishable from a quiet colleague until
 * you put the two next to each other. `--unmapped` asks the opposite question,
 * which is the one that finds the person who was never configured at all.
 */
export function createPeopleCommand(): Command {
  const command = new Command('people')
    .aliases(['person'])
    .description('the configured people and bots, with their GitHub and Jira identities')
    .option('--team <id>', 'only members of this team, repeatable', collect)
    .option('--bots-only', 'only the configured bots')
    .option('--no-bots', 'only the humans')
    .option('--identities', 'one row per identity, with what the data knows about it')
    .option('--unmapped', 'names found in the data that belong to nobody, busiest first');

  return addOutputOptions(command).action((options: Record<string, unknown>, self: Command) => {
    const ctx = openReadContext(self);
    try {
      const directory = Directory.from(ctx.config);

      if (options['unmapped'] === true) {
        printUnmapped(ctx, directory);
        return;
      }

      const people = selectPeople(directory, options);

      if (options['identities'] === true) {
        printIdentities(ctx, people);
        return;
      }

      printOutput(
        renderTable(
          people,
          [
            { header: 'ID', value: (row) => row.id },
            { header: 'NAME', value: (row) => row.name },
            {
              header: 'KIND',
              value: (row) => row.kind,
              style: (row) => (row.kind === 'bot' ? 'gray' : 'cyan'),
            },
            { header: 'GITHUB', value: (row) => row.github.join(', ') },
            { header: 'JIRA', value: (row) => row.jira.join(', ') },
            { header: 'EMAIL', value: (row) => row.email ?? '', optional: true },
          ],
          {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => row.id,
            title: 'People',
            emptyMessage:
              'No people are configured. Add a people: section to devcontext.yaml — see docs/people.md.',
          },
        ),
      );
    } finally {
      ctx.close();
    }
  });
}

/** `devcontext teams` — the groups, and who is in them. */
export function createTeamsCommand(): Command {
  const command = new Command('teams')
    .aliases(['team'])
    .description('the configured teams and their members');

  return addOutputOptions(command).action((_options: Record<string, unknown>, self: Command) => {
    const ctx = openReadContext(self);
    try {
      const directory = Directory.from(ctx.config);
      const rows = directory.teams.map((team) => {
        const members = directory.membersOf(team);
        return {
          id: team.id,
          name: team.name,
          description: team.description ?? '',
          people: members.filter((person) => person.kind === 'person').length,
          bots: members.filter((person) => person.kind === 'bot').length,
          members: members.map((person) => person.id).join(', '),
        };
      });

      printOutput(
        renderTable(
          rows,
          [
            { header: 'ID', value: (row) => row.id },
            { header: 'NAME', value: (row) => row.name },
            { header: 'PEOPLE', value: (row) => row.people, align: 'right' },
            { header: 'BOTS', value: (row) => row.bots, align: 'right', optional: true },
            { header: 'MEMBERS', value: (row) => row.members },
            { header: 'DESCRIPTION', value: (row) => row.description, optional: true },
          ],
          {
            format: ctx.format,
            list: ctx.list,
            listValue: (row) => row.id,
            title: 'Teams',
            emptyMessage:
              'No teams are configured. Add a teams: section to devcontext.yaml — see docs/people.md.',
          },
        ),
      );
    } finally {
      ctx.close();
    }
  });
}

type ReadContext = ReturnType<typeof openReadContext>;

function selectPeople(directory: Directory, options: Record<string, unknown>): Person[] {
  const teams = options['team'] as string[] | undefined;
  const chosen = teams?.length
    ? (directory.select({ teams })?.people ?? [])
    : [...directory.people];

  if (options['botsOnly'] === true) return chosen.filter((person) => person.kind === 'bot');
  if (options['bots'] === false) return chosen.filter((person) => person.kind === 'person');
  return chosen;
}

interface IdentityRow extends IdentityActivity {
  person: string;
  kind: string;
}

function printIdentities(ctx: ReadContext, people: Person[]): void {
  const rows: IdentityRow[] = [];
  for (const person of people) {
    for (const [source, identities] of [
      ['github', person.github],
      ['jira', person.jira],
    ] as const) {
      for (const identity of identities) {
        rows.push({
          ...identityActivity(ctx.db, source, identity),
          person: person.id,
          kind: person.kind,
        });
      }
    }
  }

  printOutput(
    renderTable(
      rows,
      [
        { header: 'PERSON', value: (row) => row.person },
        { header: 'SOURCE', value: (row) => row.source },
        { header: 'IDENTITY', value: (row) => row.identity },
        { header: 'AUTHORED', value: (row) => row.authored, align: 'right' },
        { header: 'ASSIGNED', value: (row) => row.assigned, align: 'right' },
        { header: 'PRS', value: (row) => row.pullRequests, align: 'right', optional: true },
        { header: 'REVIEWS', value: (row) => row.reviews, align: 'right', optional: true },
        { header: 'COMMENTS', value: (row) => row.comments, align: 'right' },
        {
          header: 'LAST SEEN',
          value: (row) => row.lastSeen?.slice(0, 10) ?? '',
          // A configured identity that appears nowhere is the thing this table
          // exists to show, so it is the one that gets a colour.
          style: (row) => (row.lastSeen === null ? 'yellow' : 'gray'),
        },
      ],
      {
        format: ctx.format,
        list: ctx.list,
        listValue: (row) => row.identity,
        title: 'Identities',
        emptyMessage: 'No identities are configured. See docs/people.md.',
      },
    ),
  );
}

function printUnmapped(ctx: ReadContext, directory: Directory): void {
  const mapped = new Set<string>();
  for (const person of directory.people) {
    for (const login of person.github) mapped.add(`github:${login.trim().toLowerCase()}`);
    for (const name of person.jira) mapped.add(`jira:${name.trim().toLowerCase()}`);
  }

  const rows = unmappedIdentities(ctx.db, mapped, { limit: ctx.limit ?? 25 });

  printOutput(
    renderTable(
      rows,
      [
        { header: 'SOURCE', value: (row) => row.source },
        { header: 'IDENTITY', value: (row) => row.identity },
        { header: 'ITEMS', value: (row) => row.count, align: 'right' },
      ],
      {
        format: ctx.format,
        list: ctx.list,
        listValue: (row) => row.identity,
        title: 'Unmapped identities',
        emptyMessage: 'Every name in the data belongs to a configured person.',
      },
    ),
  );
}
