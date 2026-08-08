import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { buildDigest, historyQueries, insights } from '../data.js';
import { Table } from '../components/table.js';
import type { ViewProps } from './list.js';
import { bar, duration } from './format.js';

export function Insights({ store, width }: ViewProps): ReactNode {
  const data = useMemo(
    () => ({
      cycle: insights.cycleTime(store.db, {}),
      review: insights.reviewLatency(store.db, {}),
      wip: insights.wip(store.db, {}),
    }),
    [store],
  );

  return (
    <Box flexDirection="column">
      <Text bold>Cycle time</Text>
      <Text dimColor>
        {data.cycle.overall.count === 0
          ? 'Nothing finished in the window.'
          : `${String(data.cycle.overall.count)} finished · p50 ${duration(data.cycle.overall.p50)} · p85 ${duration(data.cycle.overall.p85)} · p95 ${duration(data.cycle.overall.p95)}`}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Review latency</Text>
        <Text dimColor>
          {`to first review p50 ${duration(data.review.toFirstReview.p50)} · to merge p50 ${duration(data.review.toMerge.p50)} · ${String(data.review.mergedWithoutReview)} merged unreviewed`}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Work in progress</Text>
        <Text dimColor>
          {`${String(data.wip.workitems)} work items · ${String(data.wip.openPullRequests)} open pull requests (${String(data.wip.draftPullRequests)} draft) · ${String(data.wip.openIssues)} open issues`}
        </Text>
        <Box marginTop={1}>
          <Table
            width={width}
            rows={data.wip.byAssignee.slice(0, 12)}
            emptyMessage="Nothing is assigned."
            columns={[
              { header: 'assignee', value: (row) => row.assignee, width: 20 },
              {
                header: 'work items',
                value: (row) => String(row.workitems),
                width: 11,
                align: 'right',
              },
              {
                header: 'pull requests',
                value: (row) => String(row.pullRequests),
                width: 14,
                align: 'right',
              },
              {
                header: 'oldest',
                value: (row) => duration(row.oldestHours),
                width: 8,
                align: 'right',
              },
            ]}
          />
        </Box>
      </Box>
    </Box>
  );
}

export function Digest({ store, width }: ViewProps): ReactNode {
  const data = useMemo(() => buildDigest(store.db, { since: '7d' }), [store]);

  return (
    <Box flexDirection="column">
      <Text bold>{`Since ${data.since.slice(0, 10)}`}</Text>
      {data.quiet ? <Text dimColor>Nothing happened in the window.</Text> : null}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {`${String(data.github.pullRequestsMerged.length)} merged · ${String(data.github.pullRequestsOpened.length)} opened · ${String(data.github.reviews)} reviews · ${String(data.github.issuesClosed.length)} issues closed`}
        </Text>
        <Text dimColor>
          {`Jira: ${String(data.jira.finished.length)} finished · ${String(data.jira.started.length)} started · ${String(data.jira.created.length)} created`}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Table
          width={width}
          rows={data.people.slice(0, 12)}
          emptyMessage="Nobody did anything in the window."
          columns={[
            { header: 'person', value: (row) => row.person, width: 20 },
            {
              header: 'merged',
              value: (row) => String(row.pullRequestsMerged),
              width: 8,
              align: 'right',
            },
            { header: 'reviews', value: (row) => String(row.reviews), width: 8, align: 'right' },
            {
              header: 'closed',
              value: (row) => String(row.issuesClosed),
              width: 8,
              align: 'right',
            },
            { header: 'total', value: (row) => String(row.total), width: 7, align: 'right' },
          ]}
        />
      </Box>
    </Box>
  );
}

/**
 * The one view the web viewer does not have yet: the open count over time.
 *
 * A terminal is a good place for it — a bar per day needs no chart library,
 * and the shape of a month is what the question is actually about.
 */
export function History({ store, width, height }: ViewProps): ReactNode {
  const rows = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 29 * 86_400_000);
    return historyQueries.openByDay(store.db, {
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }, [store]);

  const peak = Math.max(...rows.map((row) => row.open), 1);
  const barWidth = Math.max(4, Math.min(40, width - 34));
  const visible = rows.slice(-Math.max(1, height - 4));

  return (
    <Box flexDirection="column">
      <Text bold>Open over the last 30 days</Text>
      <Box marginTop={1}>
        <Table
          width={width}
          rows={visible}
          emptyMessage='No history yet. Run a sync, or "devcontext history --rebuild".'
          columns={[
            { header: 'day', value: (row) => row.day, width: 11 },
            { header: 'open', value: (row) => String(row.open), width: 6, align: 'right' },
            {
              header: 'opened',
              value: (row) => (row.opened === 0 ? '' : `+${String(row.opened)}`),
              width: 7,
              align: 'right',
              colour: () => 'green',
            },
            {
              header: 'closed',
              value: (row) => (row.closed === 0 ? '' : `-${String(row.closed)}`),
              width: 7,
              align: 'right',
              colour: () => 'red',
            },
            { header: '', value: (row) => bar(row.open, peak, barWidth), colour: () => 'cyan' },
          ]}
        />
      </Box>
    </Box>
  );
}
