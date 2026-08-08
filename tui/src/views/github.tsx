import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { githubQueries as gh } from '../data.js';
import { ListView, matches } from './list.js';
import type { ViewProps } from './list.js';
import { relative } from './format.js';

type Issue = ReturnType<typeof gh.listIssues>[number];
type Pull = ReturnType<typeof gh.listPullRequests>[number];
type Run = ReturnType<typeof gh.listWorkflowRuns>[number];

export function Issues({ store, width, height, filter, detail, setDetail }: ViewProps): ReactNode {
  const all = useMemo(() => gh.listIssues(store.db, { state: 'all' }), [store]);
  const rows = useMemo(
    () => all.filter((row) => matches(filter, row.title, row.author, row.repo_full_name)),
    [all, filter],
  );

  return (
    <ListView
      rows={rows}
      width={width}
      height={height}
      detail={detail}
      setDetail={setDetail}
      refOf={(row) => `${row.repo_full_name}#${String(row.number)}`}
      columns={[
        { header: '#', value: (row) => String(row.number), width: 6, align: 'right' },
        { header: 'title', value: (row) => row.title ?? '' },
        {
          header: 'state',
          value: (row) => row.state ?? '',
          width: 7,
          colour: (row) => (row.state === 'open' ? 'green' : undefined),
          dim: (row) => row.state !== 'open',
        },
        { header: 'author', value: (row) => row.author ?? '', width: 14 },
        { header: 'updated', value: (row) => relative(row.updated_at), width: 9, align: 'right' },
      ]}
      renderDetail={(row) => <IssueDetail row={row} />}
    />
  );
}

function IssueDetail({ row }: { row: Issue }): ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{row.title ?? ''}</Text>
      <Text dimColor>
        {[row.state, row.author, row.repo_full_name].filter(Boolean).join(' · ')}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>{row.html_url ?? ''}</Text>
      </Box>
    </Box>
  );
}

export function Pulls({ store, width, height, filter, detail, setDetail }: ViewProps): ReactNode {
  // `state: 'all'` on purpose: a merged pull request is most of the history,
  // and hiding it by default is what the web viewer stopped doing too.
  const all = useMemo(() => gh.listPullRequests(store.db, { state: 'all' }), [store]);
  const rows = useMemo(
    () => all.filter((row) => matches(filter, row.title, row.author, row.head_ref)),
    [all, filter],
  );

  return (
    <ListView
      rows={rows}
      width={width}
      height={height}
      detail={detail}
      setDetail={setDetail}
      refOf={(row) => `${row.repo_full_name}#${String(row.number)}`}
      columns={[
        { header: '#', value: (row) => String(row.number), width: 6, align: 'right' },
        { header: 'title', value: (row) => row.title ?? '' },
        {
          header: 'state',
          value: (row) => pullState(row),
          width: 7,
          colour: (row) => pullColour(row),
        },
        {
          header: '+',
          value: (row) => (row.additions === null ? '' : `+${String(row.additions)}`),
          width: 7,
          align: 'right',
          colour: () => 'green',
        },
        {
          header: '-',
          value: (row) => (row.deletions === null ? '' : `-${String(row.deletions)}`),
          width: 7,
          align: 'right',
          colour: () => 'red',
        },
        { header: 'author', value: (row) => row.author ?? '', width: 14 },
        { header: 'updated', value: (row) => relative(row.updated_at), width: 9, align: 'right' },
      ]}
      renderDetail={(row) => (
        <Box flexDirection="column">
          <Text>{row.title ?? ''}</Text>
          <Text dimColor>
            {[pullState(row), row.author, `${row.head_ref ?? '?'} → ${row.base_ref ?? '?'}`]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>{row.html_url ?? ''}</Text>
          </Box>
        </Box>
      )}
    />
  );
}

/** GitHub stores merged and closed-without-merging as the same state. */
function pullState(row: Pull): string {
  return row.merged ? 'merged' : (row.state ?? '');
}

function pullColour(row: Pull): string | undefined {
  if (row.merged) return 'magenta';
  return row.state === 'closed' ? 'red' : 'green';
}

export function Runs({ store, width, height, filter, detail, setDetail }: ViewProps): ReactNode {
  const all = useMemo(() => gh.listWorkflowRuns(store.db, {}), [store]);
  const rows = useMemo(
    () => all.filter((row) => matches(filter, row.workflow_name, row.head_branch, row.actor)),
    [all, filter],
  );

  return (
    <ListView
      rows={rows}
      width={width}
      height={height}
      detail={detail}
      setDetail={setDetail}
      refOf={(row) => String(row.id)}
      columns={[
        { header: 'workflow', value: (row) => row.workflow_name ?? '' },
        { header: 'branch', value: (row) => row.head_branch ?? '', width: 18 },
        {
          header: 'conclusion',
          value: (row) => row.conclusion ?? row.status ?? '',
          width: 11,
          colour: (row) => conclusionColour(row.conclusion),
          // Cancelled is somebody stopping a run, not a failure.
          dim: (row) => row.conclusion === 'cancelled' || row.conclusion === 'skipped',
        },
        { header: 'actor', value: (row) => row.actor ?? '', width: 14 },
        { header: 'created', value: (row) => relative(row.created_at), width: 9, align: 'right' },
      ]}
      renderDetail={(row) => (
        <Box flexDirection="column">
          <Text>{row.workflow_name ?? ''}</Text>
          <Text dimColor>
            {[row.conclusion ?? row.status, row.event, row.head_branch, row.actor]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <Box marginTop={1}>
            <Text dimColor>{row.html_url ?? ''}</Text>
          </Box>
        </Box>
      )}
    />
  );
}

function conclusionColour(conclusion: string | null): string | undefined {
  if (conclusion === 'success') return 'green';
  if (conclusion === 'failure' || conclusion === 'timed_out') return 'red';
  if (conclusion === 'cancelled' || conclusion === 'skipped' || conclusion === 'neutral') {
    return undefined;
  }
  return 'yellow';
}

export type { Issue, Pull, Run };
