import { Command } from 'commander';

import * as insights from '../insights/index.js';
import { formatHours } from '../insights/stats.js';
import type { Distribution } from '../insights/stats.js';
import { printOutput, renderKeyValues, renderTable, truncate } from '../output/format.js';
import type { OutputFormat } from '../output/format.js';
import { CliError } from '../util/errors.js';
import { resolveTimeExpression } from '../util/time.js';
import { addOutputOptions, collect, openReadContext, parseLimit } from './shared.js';
import type { CommandContext } from './shared.js';

const SECTIONS = ['cycle-time', 'review-latency', 'wip', 'stale', 'flaky', 'sprint'] as const;
type Section = (typeof SECTIONS)[number];

export function createInsightsCommand(): Command {
  const command = new Command('insights')
    .aliases(['report', 'stats'])
    .description('cycle time, review latency, work in progress, stale items, flaky steps, sprints')
    .argument('[section]', `one of ${SECTIONS.join(', ')}; omit for an overview of all of them`)
    .option('--since <when>', 'only consider activity at or after this (default 90d)', '90d')
    .option('--until <when>', 'only consider activity before this')
    .option('-r, --repo <repo>', 'GitHub repository, repeatable', collect, [])
    .option('-p, --project <key>', 'Jira project key, repeatable', collect, [])
    .option('--stale-after <duration>', 'age at which open work counts as stale', '30d')
    .option('--min-runs <count>', 'minimum runs before a step can be called flaky', '5')
    .option('--sprint <id>', 'sprint id for the sprint report')
    .option('-n, --limit <count>', 'rows per section', '15');

  return addOutputOptions(command).action(
    (section: string | undefined, options: Record<string, unknown>, self: Command) => {
      if (section !== undefined && !SECTIONS.includes(section as Section)) {
        throw new CliError(`Unknown section "${section}".`, {
          hint: `Available sections: ${SECTIONS.join(', ')}.`,
        });
      }

      const ctx = openReadContext(self);
      try {
        const filter: insights.InsightFilter = {
          since: resolveTimeExpression(String(options['since'])),
          until: options['until'] ? resolveTimeExpression(String(options['until'])) : undefined,
          repos:
            (options['repo'] as string[]).length > 0 ? (options['repo'] as string[]) : undefined,
          projects:
            (options['project'] as string[]).length > 0
              ? (options['project'] as string[])
              : undefined,
          limit: parseLimit(options['limit'] as string) ?? 15,
        };

        const wanted: Section[] = section ? [section as Section] : [...SECTIONS];
        const reports: Record<string, unknown> = {};
        const blocks: string[] = [];

        for (const name of wanted) {
          const rendered = renderSection(name, ctx, filter, options, reports);
          if (rendered !== null) blocks.push(rendered);
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

function renderSection(
  section: Section,
  ctx: CommandContext,
  filter: insights.InsightFilter,
  options: Record<string, unknown>,
  reports: Record<string, unknown>,
): string | null {
  const format = ctx.format;

  // `--list` is meant to be piped, so the prose around the table is left out
  // in that mode: a triage script should not have to strip it.
  const heading = (title: string): string => (ctx.list ? '' : headingFor(title, format));
  const note = (text: string): string => (ctx.list ? '' : noteFor(text, format));

  switch (section) {
    case 'cycle-time': {
      const report = insights.cycleTime(ctx.db, filter);
      reports['cycleTime'] = report;
      return [
        heading('Cycle time'),
        distributionLine(report.overall, format),
        renderTable(
          report.byType,
          [
            { header: 'TYPE', value: (row) => row.type },
            { header: 'ITEMS', value: (row) => row.distribution.count, align: 'right' },
            { header: 'MEDIAN', value: (row) => formatHours(row.distribution.p50), align: 'right' },
            { header: 'P85', value: (row) => formatHours(row.distribution.p85), align: 'right' },
          ],
          { format, emptyMessage: 'No completed work items with a status history in this window.' },
        ),
        report.items.length > 0
          ? renderTable(
              report.items,
              [
                { header: 'KEY', value: (row) => row.key },
                { header: 'TIME', value: (row) => formatHours(row.hours), align: 'right' },
                { header: 'TYPE', value: (row) => row.type, optional: true },
                { header: 'ASSIGNEE', value: (row) => row.assignee, optional: true },
                { header: 'SUMMARY', value: (row) => truncate(row.summary, 50) },
              ],
              { format, title: 'Slowest' },
            )
          : '',
        report.withoutStart > 0
          ? note(
              `${report.withoutStart} item(s) reached Done without ever passing through an in-progress status; they are not counted.`,
            )
          : '',
      ]
        .filter((part) => part !== '')
        .join('\n');
    }

    case 'review-latency': {
      const report = insights.reviewLatency(ctx.db, filter);
      reports['reviewLatency'] = report;
      return [
        heading('Review latency'),
        renderKeyValues(
          [
            ['Pull requests', report.toMerge.count],
            ['Time to first review (median)', formatHours(report.toFirstReview.p50)],
            ['Time to first review (p85)', formatHours(report.toFirstReview.p85)],
            ['Time to merge (median)', formatHours(report.toMerge.p50)],
            ['Time to merge (p85)', formatHours(report.toMerge.p85)],
            ['Merged without a review', report.mergedWithoutReview],
          ],
          format,
        ),
        renderTable(
          report.byReviewer.slice(0, filter.limit ?? 15),
          [
            { header: 'REVIEWER', value: (row) => row.reviewer },
            { header: 'REVIEWS', value: (row) => row.reviews, align: 'right' },
            {
              header: 'MEDIAN RESPONSE',
              value: (row) => formatHours(row.medianResponseHours),
              align: 'right',
            },
          ],
          { format, title: 'Reviewers', emptyMessage: 'No reviews in this window.' },
        ),
      ]
        .filter((part) => part !== '')
        .join('\n');
    }

    case 'wip': {
      const report = insights.wip(ctx.db, filter);
      reports['wip'] = report;
      return [
        heading('Work in progress'),
        renderKeyValues(
          [
            ['Work items in progress', report.workitems],
            ['Open pull requests', report.openPullRequests],
            ['... of which drafts', report.draftPullRequests],
            ['Open issues', report.openIssues],
          ],
          format,
        ),
        renderTable(
          report.byAssignee.slice(0, filter.limit ?? 15),
          [
            { header: 'WHO', value: (row) => row.assignee },
            { header: 'WORK ITEMS', value: (row) => row.workitems, align: 'right' },
            { header: 'PULL REQUESTS', value: (row) => row.pullRequests, align: 'right' },
            { header: 'OLDEST', value: (row) => formatHours(row.oldestHours), align: 'right' },
          ],
          { format, emptyMessage: 'Nothing in flight.' },
        ),
      ]
        .filter((part) => part !== '')
        .join('\n');
    }

    case 'stale': {
      const threshold = resolveTimeExpression(String(options['staleAfter']));
      const report = insights.staleItems(ctx.db, threshold, filter);
      reports['stale'] = report;
      return [
        heading(`Stale (untouched since ${threshold.slice(0, 10)})`),
        renderTable(
          report.items,
          [
            { header: 'KIND', value: (row) => row.kind },
            { header: 'REF', value: (row) => row.ref },
            { header: 'AGE', value: (row) => formatHours(row.ageHours), align: 'right' },
            { header: 'OWNER', value: (row) => row.owner, optional: true },
            { header: 'TITLE', value: (row) => truncate(row.title, 50) },
          ],
          {
            format,
            list: ctx.list,
            listValue: (row) => row.ref,
            emptyMessage: 'Nothing has gone stale.',
          },
        ),
      ]
        .filter((part) => part !== '')
        .join('\n');
    }

    case 'flaky': {
      const report = insights.flakySteps(ctx.db, {
        minRuns: Number(options['minRuns']) || 5,
        since: filter.since,
        repos: filter.repos,
        limit: filter.limit,
      });
      reports['flaky'] = report;
      return [
        heading(`Flaky steps (at least ${report.minRuns} runs)`),
        renderTable(
          report.steps,
          [
            { header: 'WORKFLOW', value: (row) => row.workflow, optional: true },
            { header: 'JOB', value: (row) => row.job, optional: true },
            { header: 'STEP', value: (row) => truncate(row.step, 40) },
            { header: 'RUNS', value: (row) => row.runs, align: 'right' },
            { header: 'FAILURES', value: (row) => row.failures, align: 'right' },
            {
              header: 'RATE',
              value: (row) => (row.failureRate === null ? '' : `${row.failureRate}%`),
              align: 'right',
            },
            { header: 'RETRIED GREEN', value: (row) => row.retriedGreen, align: 'right' },
          ],
          { format, emptyMessage: 'No step failed often enough to report.' },
        ),
      ]
        .filter((part) => part !== '')
        .join('\n');
    }

    case 'sprint': {
      const sprintId =
        options['sprint'] !== undefined ? Number(options['sprint']) : latestSprint(ctx);
      if (sprintId === null) return null;

      const report = insights.sprintReport(ctx.db, sprintId);
      if (!report) {
        if (options['sprint'] !== undefined) {
          throw new CliError(`No sprint ${sprintId} in the database.`);
        }
        return null;
      }
      reports['sprint'] = report;

      return [
        heading(`Sprint ${report.sprint.name ?? report.sprint.id}`),
        renderKeyValues(
          [
            ['State', report.sprint.state],
            ['Goal', report.sprint.goal],
            [
              'Dates',
              [report.sprint.startDate?.slice(0, 10), report.sprint.endDate?.slice(0, 10)]
                .filter(Boolean)
                .join(' → '),
            ],
            ['Work items', `${report.done}/${report.items}`],
            ['Completion', report.completionRate === null ? null : `${report.completionRate}%`],
            [
              'Story points',
              report.storyPoints ? `${report.storyPointsDone}/${report.storyPoints}` : null,
            ],
            ['Scope changes', report.scopeChanges.length],
          ],
          format,
        ),
        renderTable(
          report.byAssignee,
          [
            { header: 'WHO', value: (row) => row.assignee },
            { header: 'ITEMS', value: (row) => row.items, align: 'right' },
            { header: 'DONE', value: (row) => row.done, align: 'right' },
            { header: 'POINTS', value: (row) => row.points, align: 'right' },
          ],
          { format, emptyMessage: 'The sprint has no work items.' },
        ),
      ]
        .filter((part) => part !== '')
        .join('\n');
    }

    default:
      return null;
  }
}

/** The most recent active sprint, so the overview has something to show. */
function latestSprint(ctx: CommandContext): number | null {
  const row = ctx.db.get<{ id: number }>(
    `SELECT id FROM jira_sprints
      ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'closed' THEN 1 ELSE 2 END,
               COALESCE(start_date, '') DESC
      LIMIT 1`,
  );
  return row?.id ?? null;
}

function headingFor(title: string, format: OutputFormat): string {
  if (format === 'markdown') return `## ${title}\n`;
  if (format === 'plain') return `# ${title}`;
  return `\u001b[1m── ${title} ──\u001b[0m`;
}

function distributionLine(distribution: Distribution, format: OutputFormat): string {
  return renderKeyValues(
    [
      ['Completed', distribution.count],
      ['Median', formatHours(distribution.p50)],
      ['P85', formatHours(distribution.p85)],
      ['Longest', formatHours(distribution.max)],
    ],
    format,
  );
}

function noteFor(text: string, format: OutputFormat): string {
  return format === 'markdown' ? `\n_${text}_` : `\n${text}`;
}
