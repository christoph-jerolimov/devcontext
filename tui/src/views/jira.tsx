import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { jiraQueries as jira } from '../data.js';
import { ListView, matches } from './list.js';
import type { ViewProps } from './list.js';
import { relative } from './format.js';

export function Workitems({
  store,
  width,
  height,
  filter,
  detail,
  setDetail,
  dataVersion,
}: ViewProps): ReactNode {
  const all = useMemo(() => jira.listWorkitems(store.db, {}), [store, dataVersion]);
  const rows = useMemo(
    () => all.filter((row) => matches(filter, row.key, row.summary, row.assignee, row.type)),
    [all, filter],
  );

  return (
    <ListView
      rows={rows}
      width={width}
      height={height}
      detail={detail}
      setDetail={setDetail}
      refOf={(row) => row.key}
      columns={[
        { header: 'key', value: (row) => row.key, width: 12 },
        { header: 'summary', value: (row) => row.summary ?? '' },
        { header: 'type', value: (row) => row.type ?? '', width: 9 },
        {
          header: 'status',
          value: (row) => row.status ?? '',
          width: 14,
          colour: (row) => statusColour(row.status_category),
          dim: (row) => row.status_category === 'Done',
        },
        { header: 'assignee', value: (row) => row.assignee ?? '', width: 14 },
        { header: 'updated', value: (row) => relative(row.updated_at), width: 9, align: 'right' },
      ]}
      renderDetail={(row) => (
        <Box flexDirection="column">
          <Text>{row.summary ?? ''}</Text>
          <Text dimColor>
            {[row.type, row.status, row.assignee, row.sprint_name].filter(Boolean).join(' · ')}
          </Text>
          {row.story_points === null ? null : <Text dimColor>{row.story_points} point(s)</Text>}
          <Box marginTop={1}>
            <Text dimColor>{row.url ?? ''}</Text>
          </Box>
        </Box>
      )}
    />
  );
}

function statusColour(category: string | null): string | undefined {
  if (category === 'Done') return undefined;
  if (category === 'In Progress') return 'yellow';
  return 'cyan';
}

export function Sprints({
  store,
  width,
  height,
  filter,
  detail,
  setDetail,
  dataVersion,
}: ViewProps): ReactNode {
  const all = useMemo(() => jira.listSprints(store.db, {}), [store, dataVersion]);
  const rows = useMemo(
    () => all.filter((row) => matches(filter, row.name, row.state)),
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
        { header: 'sprint', value: (row) => row.name ?? '' },
        {
          header: 'state',
          value: (row) => row.state ?? '',
          width: 8,
          colour: (row) => (row.state === 'active' ? 'green' : undefined),
          dim: (row) => row.state === 'closed',
        },
        {
          header: 'items',
          value: (row) => String(row.workitem_count ?? 0),
          width: 6,
          align: 'right',
        },
        { header: 'start', value: (row) => (row.start_date ?? '').slice(0, 10), width: 11 },
        { header: 'end', value: (row) => (row.end_date ?? '').slice(0, 10), width: 11 },
      ]}
      renderDetail={(row) => (
        <Box flexDirection="column">
          <Text>{row.name ?? ''}</Text>
          <Text dimColor>{[row.state, row.goal].filter(Boolean).join(' · ')}</Text>
        </Box>
      )}
    />
  );
}
