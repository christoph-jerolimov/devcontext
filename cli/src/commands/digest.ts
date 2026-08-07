import { Command } from 'commander';

import { buildDigest } from '../insights/digest.js';
import type { Digest, DigestEntry } from '../insights/digest.js';
import { formatHours } from '../insights/stats.js';
import { printOutput, renderKeyValues, renderTable, truncate } from '../output/format.js';
import type { OutputFormat } from '../output/format.js';
import { resolveTimeExpression } from '../util/time.js';
import { addOutputOptions, collect, openReadContext, parseLimit } from './shared.js';

export function createDigestCommand(): Command {
  const command = new Command('digest')
    .aliases(['standup', 'summary'])
    .description('what happened in a window: shipped, started, reviewed, and still stuck')
    .option('--since <when>', 'start of the window (1w, 3d, 2024-01-31)', '1w')
    .option('--until <when>', 'end of the window; defaults to now')
    .option('-r, --repo <repo>', 'GitHub repository, repeatable', collect, [])
    .option('-p, --project <key>', 'Jira project key, repeatable', collect, [])
    .option('--person <name>', 'only activity by this person, repeatable', collect, [])
    .option('--stale-after <duration>', 'age at which open work counts as stale', '30d')
    .option('--no-stale', 'skip the stale section')
    .option('-n, --limit <count>', 'rows per section', '10');

  return addOutputOptions(command).action((options: Record<string, unknown>, self: Command) => {
    const ctx = openReadContext(self);
    try {
      const digest = buildDigest(ctx.db, {
        since: resolveTimeExpression(String(options['since'])),
        until: options['until'] ? resolveTimeExpression(String(options['until'])) : undefined,
        repos: optional(options['repo']),
        projects: optional(options['project']),
        people: optional(options['person']),
        staleAfter:
          options['stale'] === false
            ? undefined
            : resolveTimeExpression(String(options['staleAfter'])),
        limit: parseLimit(options['limit'] as string) ?? 10,
      });

      if (ctx.format === 'json') {
        printOutput(JSON.stringify(digest, null, 2));
        return;
      }
      if (ctx.list) {
        printOutput(references(digest).join('\n'));
        return;
      }
      printOutput(render(digest, ctx.format));
    } finally {
      ctx.close();
    }
  });
}

function optional(value: unknown): string[] | undefined {
  const list = value as string[];
  return list.length > 0 ? list : undefined;
}

/**
 * `--list`: every reference the digest mentions, for piping into a script.
 * An item that shows up in several sections is listed once.
 */
function references(digest: Digest): string[] {
  return [
    ...new Set(
      [
        ...digest.github.pullRequestsOpened,
        ...digest.github.pullRequestsMerged,
        ...digest.github.issuesOpened,
        ...digest.github.issuesClosed,
        ...digest.jira.created,
        ...digest.jira.started,
        ...digest.jira.finished,
      ].map((entry) => entry.ref),
    ),
  ];
}

function render(digest: Digest, format: OutputFormat): string {
  const window = `${digest.since.slice(0, 10)} → ${digest.until.slice(0, 10)}`;
  const blocks: string[] = [heading(`Digest ${window}`, format)];

  if (digest.quiet) {
    blocks.push('Nothing happened in this window.');
  }

  blocks.push(
    renderKeyValues(
      [
        ['Pull requests merged', digest.github.pullRequestsMerged.length],
        ['Pull requests opened', digest.github.pullRequestsOpened.length],
        ['Issues closed', digest.github.issuesClosed.length],
        ['Issues opened', digest.github.issuesOpened.length],
        ['Work items finished', digest.jira.finished.length],
        ['Work items started', digest.jira.started.length],
        ['Work items created', digest.jira.created.length],
        ['Reviews', digest.github.reviews],
        ['Comments', digest.github.comments + digest.jira.comments],
        ['Failed workflow runs', digest.github.failedRuns.length],
      ],
      format,
    ),
  );

  blocks.push(
    section('Merged', digest.github.pullRequestsMerged, format),
    section('Finished', digest.jira.finished, format),
    section('Opened', digest.github.pullRequestsOpened, format),
    section('Started', digest.jira.started, format),
    section('New issues', digest.github.issuesOpened, format),
    section('Closed issues', digest.github.issuesClosed, format),
  );

  if (digest.people.length > 0) {
    blocks.push(
      renderTable(
        digest.people,
        [
          { header: 'WHO', value: (row) => row.person },
          { header: 'MERGED', value: (row) => row.pullRequestsMerged, align: 'right' },
          { header: 'OPENED', value: (row) => row.pullRequestsOpened, align: 'right' },
          { header: 'REVIEWS', value: (row) => row.reviews, align: 'right' },
          { header: 'FINISHED', value: (row) => row.workitemsFinished, align: 'right' },
          { header: 'COMMENTS', value: (row) => row.comments, align: 'right', optional: true },
        ],
        { format, title: 'People' },
      ),
    );
  }

  if (digest.github.failedRuns.length > 0) {
    blocks.push(
      renderTable(
        digest.github.failedRuns,
        [
          { header: 'RUN', value: (row) => row.ref },
          { header: 'WORKFLOW', value: (row) => row.title },
          { header: 'BRANCH', value: (row) => row.detail, optional: true },
        ],
        { format, title: 'Failed runs' },
      ),
    );
  }

  blocks.push(
    renderKeyValues(
      [
        ['Work items in progress', digest.inFlight.workitems],
        ['Open pull requests', digest.inFlight.pullRequests],
        ['... of which drafts', digest.inFlight.drafts],
      ],
      format,
    ),
  );

  if (digest.stale.length > 0) {
    blocks.push(
      renderTable(
        digest.stale,
        [
          { header: 'KIND', value: (row) => row.kind },
          { header: 'REF', value: (row) => row.ref },
          { header: 'AGE', value: (row) => formatHours(row.ageHours), align: 'right' },
          { header: 'OWNER', value: (row) => row.owner, optional: true },
          { header: 'TITLE', value: (row) => truncate(row.title, 50) },
        ],
        { format, title: 'Still waiting' },
      ),
    );
  }

  return blocks.filter((block) => block.trim() !== '').join('\n\n');
}

/**
 * A section reads as a list rather than a table: this is text somebody pastes
 * into a standup, so one line per item beats aligned columns.
 */
function section(title: string, entries: DigestEntry[], format: OutputFormat): string {
  if (entries.length === 0) return '';
  const lines = entries.map((entry) => {
    const summary = truncate(entry.title, 72);
    const who = entry.who ? ` (${entry.who})` : '';
    if (format === 'markdown') {
      const ref = entry.url ? `[${entry.ref}](${entry.url})` : entry.ref;
      return `- ${ref} ${summary}${who}`;
    }
    if (format === 'plain') return `${entry.ref}\t${summary}\t${entry.who ?? ''}`;
    return `  ${entry.ref}  ${summary}${who}`;
  });
  return [subheading(title, format), ...lines].join('\n');
}

function heading(title: string, format: OutputFormat): string {
  if (format === 'markdown' || format === 'plain') return `# ${title}`;
  return `\u001b[1m── ${title} ──\u001b[0m`;
}

/** Blocks are joined by a blank line, so a heading never adds one itself. */
function subheading(title: string, format: OutputFormat): string {
  if (format === 'markdown') return `## ${title}\n`;
  if (format === 'plain') return `# ${title}`;
  return `\u001b[1m${title}\u001b[0m`;
}
