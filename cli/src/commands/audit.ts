import { Command } from 'commander';

import {
  configReport,
  contentReport,
  peopleReport,
  secretsReport,
  storageReport,
} from '../audit/index.js';
import { bold, printOutput, renderKeyValues, renderTable, truncate } from '../output/format.js';
import type { OutputFormat } from '../output/format.js';
import { CliError } from '../util/errors.js';
import { addOutputOptions, openReadContext, parseLimit } from './shared.js';
import type { CommandContext } from './shared.js';

const SECTIONS = ['storage', 'content', 'people', 'secrets', 'config'] as const;
type Section = (typeof SECTIONS)[number];

export function createAuditCommand(): Command {
  const command = new Command('audit')
    .description('what is stored locally, who is in it, and what a sync would fetch')
    .argument('[section]', `one of ${SECTIONS.join(', ')}; omit for all of them`)
    .option('--all', 'include low confidence secret matches (keyword heuristics)')
    .option('-n, --limit <count>', 'rows per section', '25');

  return addOutputOptions(command).action(
    (section: string | undefined, options: Record<string, unknown>, self: Command) => {
      if (section !== undefined && !SECTIONS.includes(section as Section)) {
        throw new CliError(`Unknown section "${section}".`, {
          hint: `Available sections: ${SECTIONS.join(', ')}.`,
        });
      }

      const ctx = openReadContext(self);
      try {
        const limit = parseLimit(options['limit'] as string) ?? 25;
        const wanted: Section[] = section ? [section as Section] : [...SECTIONS];
        const reports: Record<string, unknown> = {};
        const blocks: string[] = [];

        for (const name of wanted) {
          blocks.push(render(name, ctx, { limit, all: options['all'] === true }, reports));
        }

        if (ctx.format === 'json') {
          printOutput(JSON.stringify(reports, null, 2));
          return;
        }
        printOutput(blocks.filter((block) => block.trim() !== '').join('\n\n'));
      } finally {
        ctx.close();
      }
    },
  );
}

function render(
  section: Section,
  ctx: CommandContext,
  options: { limit: number; all: boolean },
  reports: Record<string, unknown>,
): string {
  const format = ctx.format;

  // `--list` exists to be piped, so in that mode the prose around the table is
  // not output — it is noise the receiving script would have to strip.
  const heading = (title: string): string => (ctx.list ? '' : headingFor(title, format));
  const subheading = (title: string): string => (ctx.list ? '' : subheadingFor(title, format));
  const note = (text: string): string => (ctx.list ? '' : noteFor(text, format));

  switch (section) {
    case 'storage': {
      const report = storageReport(ctx.config);
      reports['storage'] = report;
      return [
        heading('Where the data lives'),
        renderTable(
          report.files,
          [
            { header: 'WHAT', value: (row) => row.kind },
            { header: 'PATH', value: (row) => row.shortPath },
            { header: 'SIZE', value: (row) => (row.exists ? bytes(row.bytes) : 'not written yet') },
            { header: 'MODE', value: (row) => row.mode, optional: true },
            {
              header: 'GIT',
              value: (row) =>
                row.tracked === null ? 'no repo' : row.tracked ? 'NOT IGNORED' : 'ignored',
            },
          ],
          { format, emptyMessage: 'Nothing is configured to be written.' },
        ),
        report.unignored.length > 0
          ? note(
              `${report.unignored.length} path(s) are not covered by .gitignore. Committing them would publish every issue, comment and log this database holds.`,
            )
          : '',
      ]
        .filter((part) => part !== '')
        .join('\n');
    }

    case 'content': {
      const report = contentReport(ctx.db);
      reports['content'] = report;
      return [
        heading('What is stored'),
        renderTable(
          report.groups,
          [
            { header: 'GROUP', value: (row) => row.group },
            { header: 'ROWS', value: (row) => row.rows, align: 'right' },
            { header: 'FREE TEXT COLUMNS', value: (row) => row.freeText.join(', ') || '—' },
          ],
          { format, emptyMessage: 'The database is empty; run "devcontext sync".' },
        ),
        note(
          `${report.totalRows} row(s) in total. Every row also keeps the untouched API payload in its "raw" column, so anything the API returned is present even when no column names it.`,
        ),
      ]
        .filter((part) => part !== '')
        .join('\n');
    }

    case 'people': {
      const report = peopleReport(ctx.db, options.limit);
      reports['people'] = report;
      return [
        heading('Whose data is in here'),
        renderTable(
          report.people,
          [
            { header: 'NAME', value: (row) => row.name },
            { header: 'SOURCE', value: (row) => row.source, optional: true },
            { header: 'APPEARS AS', value: (row) => row.appearsAs.join(', ') },
          ],
          {
            format,
            list: ctx.list,
            listValue: (row) => row.name,
            emptyMessage: 'No identities stored.',
          },
        ),
        report.emails > 0
          ? note(
              `${report.emails} commit(s) also carry an author email address. Those are personal data under GDPR and similar regimes.`,
            )
          : '',
      ]
        .filter((part) => part !== '')
        .join('\n');
    }

    case 'secrets': {
      const report = secretsReport(ctx.db, {
        includeLowConfidence: options.all,
        limit: options.limit,
      });
      reports['secrets'] = report;

      return [
        heading('Credentials found in the synced text'),
        renderTable(
          report.hits,
          [
            { header: 'REF', value: (row) => row.ref },
            { header: 'WHERE', value: (row) => row.where },
            { header: 'LINE', value: (row) => row.line, align: 'right', optional: true },
            { header: 'KIND', value: (row) => row.label },
            { header: 'CONFIDENCE', value: (row) => row.confidence, optional: true },
            { header: 'LOOKS LIKE', value: (row) => truncate(row.fingerprint, 24) },
          ],
          {
            format,
            list: ctx.list,
            listValue: (row) => row.ref,
            emptyMessage: `Nothing that looks like a credential in ${report.scanned} text field(s).`,
          },
        ),
        report.hits.length > 0
          ? note(
              'The values themselves are never printed — only a masked fingerprint, because a credential in a terminal or a CI log has been leaked twice. Rotate anything real; devcontext only mirrors what the platform already stored.',
            )
          : '',
        options.all
          ? ''
          : note('Pass --all to include keyword heuristics such as "password = ...".'),
      ]
        .filter((part) => part !== '')
        .join('\n');
    }

    case 'config': {
      const report = configReport(ctx.config);
      reports['config'] = report;

      const blocks = [
        heading('What a sync would fetch'),
        renderKeyValues(
          [
            ['Configuration', report.configPath],
            ['Targets', report.targets.length],
            ['Writes to GitHub or Jira', 'never — every API call is a GET'],
          ],
          format,
        ),
      ];

      for (const target of report.targets) {
        // The name is a subheading rather than a key/value, because
        // renderKeyValues drops entries with an empty value.
        blocks.push(
          [
            subheading(`${target.source} · ${target.target}`),
            renderKeyValues(
              [
                ['Fetches', target.enabled.join(', ') || 'nothing'],
                ['Skips', target.disabled.join(', ') || 'nothing'],
                ['Limited by', target.limits.join('; ') || 'nothing'],
                [
                  'Credential',
                  `$${target.tokenEnv}${target.tokenPresent ? '' : ' (not set — this target would fail)'}`,
                ],
              ],
              format,
            ),
          ].join('\n'),
        );
      }

      return blocks.join('\n\n');
    }

    default:
      return '';
  }
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

/*
 * The escapes go through `bold` rather than being written out here.
 *
 * They were written out here, and the ESC byte was missing — so every heading
 * printed a literal "[1m── Where the data lives ──[0m". Hand written escapes
 * also ignore whether colour is wanted at all, and this output is piped into
 * `less` and `grep` often enough for that to matter.
 */
export function headingFor(title: string, format: OutputFormat): string {
  if (format === 'markdown') return `## ${title}\n`;
  if (format === 'plain') return `# ${title}`;
  return bold(`── ${title} ──`);
}

export function subheadingFor(title: string, format: OutputFormat): string {
  if (format === 'markdown') return `### ${title}\n`;
  if (format === 'plain') return `## ${title}`;
  return bold(title);
}

function noteFor(text: string, format: OutputFormat): string {
  return format === 'markdown' ? `\n_${text}_` : `\n${text}`;
}
