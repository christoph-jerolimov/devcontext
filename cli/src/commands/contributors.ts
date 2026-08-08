import { Command } from 'commander';

import { loadConfig } from '../config/load.js';
import { buildContributors, ROLE_DESCRIPTIONS } from '../contributors/build.js';
import type { ContributorRole } from '../contributors/build.js';
import { Database } from '../db/database.js';
import * as contributors from '../db/queries/contributors.js';
import type { ContributorSummary } from '../db/queries/contributors.js';
import { colour, printOutput, renderTable } from '../output/format.js';
import type { Colour } from '../output/format.js';
import { Directory } from '../people/directory.js';
import type { IdentitySource } from '../people/directory.js';
import { CliError } from '../util/errors.js';
import { addListOptions, createCommandLogger, openReadContext, parseLimit } from './shared.js';
import type { GlobalOptions } from './shared.js';

/**
 * `devcontext contributors <ref>` — who worked on it, and in what capacity.
 *
 * The author column has always been one query away; everybody else was four
 * joins away, so in practice "who worked on this" got answered with the author
 * alone — which names the one person guaranteed not to have reviewed it.
 *
 * `--rollup` is the version worth having on an epic. Nobody contributes to an
 * epic directly, because an epic is a heading; asked plainly it answers with
 * whoever created the heading, which is true and useless.
 */
export function createContributorsCommand(): Command {
  const command = new Command('contributors')
    .aliases(['who', 'contributor'])
    .description('who worked on an issue, pull request or work item, and what they did')
    .argument('[ref]', 'a reference (acme/platform#42 or PLAT-7)')
    .option('--rollup', 'include everything beneath it: child work items and linked pull requests')
    .option('--role <role>', 'only this capacity (author, reviewer, commenter, ...)')
    .option('--by-item', 'one row per contribution rather than one per person')
    .option('--rebuild', 'recompute the table from the synced rows before listing');

  return addListOptions(command).action(
    (ref: string | undefined, options: Record<string, unknown>, self: Command) => {
      if (options['rebuild'] === true) rebuild(self);

      if (ref === undefined) {
        throw new CliError('Name what to look at, e.g. "devcontext contributors PLAT-7".', {
          hint: 'A reference is a GitHub item (acme/platform#42) or a Jira key (PLAT-7).',
        });
      }

      const ctx = openReadContext(self);
      const directory = Directory.from(ctx.config);
      try {
        const refs = options['rollup'] === true ? contributors.descendantsOf(ctx.db, ref) : [ref];
        const role = options['role'] as string | undefined;

        if (options['byItem'] === true) {
          const rows = contributors
            .contributionsOf(ctx.db, refs)
            .filter((row) => role === undefined || row.role === role)
            .slice(0, parseLimit(options['limit'] as string | undefined) ?? 200);

          printOutput(
            renderTable(
              rows,
              [
                { header: 'REF', value: (row) => row.ref },
                { header: 'WHO', value: (row) => name(directory, row.source, row.identity) },
                { header: 'DID', value: (row) => row.role, style: (row) => roleColour(row.role) },
                { header: 'TIMES', value: (row) => row.events, align: 'right' },
                {
                  header: 'LAST',
                  value: (row) => (row.last_at ?? '').slice(0, 10),
                  optional: true,
                },
              ],
              {
                format: ctx.format,
                list: ctx.list,
                listValue: (row) => row.identity,
                title: `Contributions to ${ref}`,
                emptyMessage: EMPTY,
              },
            ),
          );
          return;
        }

        const people = contributors
          .contributorsOf(ctx.db, refs)
          .filter((person) => role === undefined || person.roles.includes(role))
          .slice(0, parseLimit(options['limit'] as string | undefined) ?? 100);

        printOutput(
          renderTable(
            people,
            [
              {
                header: 'WHO',
                value: (row: ContributorSummary) => name(directory, row.source, row.identity),
              },
              { header: 'SOURCE', value: (row: ContributorSummary) => row.source, optional: true },
              {
                header: 'DID',
                value: (row: ContributorSummary) => row.roles.join(', '),
                style: (row: ContributorSummary) => roleColour(row.roles[0] ?? ''),
              },
              { header: 'TIMES', value: (row: ContributorSummary) => row.events, align: 'right' },
              {
                header: 'ITEMS',
                value: (row: ContributorSummary) => row.refs.length,
                align: 'right',
                optional: true,
              },
              {
                header: 'LAST',
                value: (row: ContributorSummary) => (row.last_at ?? '').slice(0, 10),
                optional: true,
              },
            ],
            {
              format: ctx.format,
              list: ctx.list,
              listValue: (row: ContributorSummary) => row.identity,
              title:
                options['rollup'] === true
                  ? `Everyone on ${ref} and what it links to`
                  : `Who worked on ${ref}`,
              emptyMessage: EMPTY,
            },
          ),
        );

        /*
         * An epic answered without the rollup names the person who created the
         * heading and nobody else, which reads like an answer. Saying so beats
         * letting it pass for one.
         *
         * "Related" rather than "beneath": a work item reaches its children,
         * but a pull request reaches the tickets it references, and neither is
         * under the other.
         */
        if (ctx.format === 'default' && !ctx.list && options['rollup'] !== true) {
          const related = contributors.descendantsOf(ctx.db, ref).length - 1;
          if (related > 0) {
            printOutput(
              colour(
                `${String(related)} related item(s) — add --rollup to include the people who worked on them.`,
                'gray',
              ),
            );
          }
        }
      } finally {
        ctx.close();
      }
    },
  );
}

const EMPTY =
  'Nobody recorded against it. Run a sync, or "devcontext contributors --rebuild" on an existing database.';

/** The person's name when the mapping knows it, else the raw identity. */
function name(directory: Directory, source: IdentitySource, identity: string): string {
  return directory.identify(source, identity)?.name ?? identity;
}

/**
 * Green for making the thing, yellow for judging it, grey for talking about it.
 *
 * The same three-way split the pull request and activity views already use, so
 * a capacity reads the same wherever it appears.
 */
function roleColour(role: string): Colour {
  if (role === 'author' || role === 'committer' || role === 'worked') return 'green';
  if (role === 'reviewer' || role === 'merged_by') return 'purple';
  if (role === 'review_requested') return 'yellow';
  return 'gray';
}

/** Recomputes the table; also used by `devcontext sync`. */
function rebuild(self: Command): void {
  const globals = self.optsWithGlobals<GlobalOptions>();
  const logger = createCommandLogger(globals);
  const config = loadConfig({ configPath: globals.config });
  const db = Database.openAndMigrate(globals.db ?? config.databasePath);
  try {
    const result = buildContributors(db);
    logger.info(`Recorded ${result.contributions} contribution(s) across ${result.items} item(s).`);
  } finally {
    db.close();
  }
}

/** What each capacity means, for the help text and the documentation. */
export function describeRoles(): Array<[ContributorRole, string]> {
  return Object.entries(ROLE_DESCRIPTIONS) as Array<[ContributorRole, string]>;
}
