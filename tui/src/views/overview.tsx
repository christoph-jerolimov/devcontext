import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { githubQueries as gh, jiraQueries as jira } from '../data.js';
import { Table } from '../components/table.js';
import type { ViewProps } from './list.js';

/**
 * The same three panels as the web Overview: what is configured, how much of
 * it is here, and the same totals broken down per repository and per project.
 */
export function Overview({ store, width }: ViewProps): ReactNode {
  const data = useMemo(
    () => ({
      github: gh.githubStats(store.db),
      jira: jira.jiraStats(store.db),
      byRepository: gh.githubStatsByRepository(store.db),
      byProject: jira.jiraStatsByProject(store.db),
    }),
    [store],
  );

  /*
   * Prefixed, because both sides count `comments` and React needs the keys to
   * be distinct — otherwise one of the two cards is silently dropped.
   */
  const totals = [
    ...Object.entries(data.github).map(([key, value]) => [`github ${key}`, key, value] as const),
    ...Object.entries(data.jira).map(([key, value]) => [`jira ${key}`, key, value] as const),
  ];

  return (
    <Box flexDirection="column">
      <Text bold>Contents</Text>
      <Box flexWrap="wrap" marginBottom={1}>
        {totals.map(([id, key, value]) => (
          <Box key={id} marginRight={2}>
            <Text>
              <Text bold color={value === 0 ? undefined : 'cyan'} dimColor={value === 0}>
                {String(value)}
              </Text>
              <Text dimColor>{` ${spaced(key)}`}</Text>
            </Text>
          </Box>
        ))}
      </Box>

      {data.byRepository.length === 0 ? null : (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>GitHub repositories</Text>
          <Counts
            rows={data.byRepository.map(({ repository, ...counts }) => ({
              name: repository,
              counts,
            }))}
            keyHeader="repository"
            width={width}
          />
        </Box>
      )}

      {data.byProject.length === 0 ? null : (
        <Box flexDirection="column">
          <Text bold>Jira projects</Text>
          <Counts
            rows={data.byProject.map(({ project, ...counts }) => ({ name: project, counts }))}
            keyHeader="project"
            width={width}
          />
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{store.config.databasePath}</Text>
      </Box>
    </Box>
  );
}

/**
 * One row per repository or project, one column per kind of thing counted.
 *
 * Only the first few columns fit in a terminal, so the ones the counts are
 * actually asked about come first rather than everything being squeezed.
 */
function Counts({
  rows,
  keyHeader,
  width,
}: {
  rows: Array<{ name: string; counts: Record<string, number> }>;
  keyHeader: string;
  width: number;
}): ReactNode {
  const names = [...new Set(rows.flatMap((row) => Object.keys(row.counts)))];
  // Each count column needs about eight characters; the name takes the rest.
  const room = Math.max(1, Math.floor((width - 24) / 9));
  const shown = names.slice(0, room);

  return (
    <Box flexDirection="column">
      <Table
        width={width}
        rows={rows}
        columns={[
          { header: keyHeader, value: (row) => row.name, width: 22 },
          ...shown.map((name) => ({
            header: abbreviate(name),
            value: (row: { counts: Record<string, number> }) => String(row.counts[name] ?? 0),
            width: 8,
            align: 'right' as const,
            dim: (row: { counts: Record<string, number> }) => (row.counts[name] ?? 0) === 0,
          })),
        ]}
      />
      {shown.length < names.length ? (
        <Text
          dimColor
        >{`+${String(names.length - shown.length)} more column(s) — widen the window`}</Text>
      ) : null}
    </Box>
  );
}

function spaced(key: string): string {
  return key.replaceAll(/([A-Z])/g, ' $1').toLowerCase();
}

/** `openPullRequests` → `openPR`, so a dozen columns can share one line. */
function abbreviate(key: string): string {
  return key
    .replaceAll('pullRequests', 'PRs')
    .replaceAll('workflowRuns', 'runs')
    .replaceAll('workflowJobs', 'jobs')
    .replaceAll('changelogEntries', 'changes')
    .replaceAll('attachments', 'files')
    .replaceAll('workitems', 'items');
}
