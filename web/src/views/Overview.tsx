import type { ReactNode } from 'react';

import { formatRelative } from '../api.ts';
import type { StatusResponse } from '../api.ts';
import { Panel } from '../components/common.tsx';

export function Overview({ status }: { status: StatusResponse }): ReactNode {
  return (
    <div className="stack">
      <Panel title="Projects">
        <table className="table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>GitHub repositories</th>
              <th>Jira projects</th>
            </tr>
          </thead>
          <tbody>
            {status.config.projects.map((project) => (
              <tr key={project.key}>
                <td>{project.key}</td>
                <td>{project.name}</td>
                <td className="muted">{project.github.join(', ')}</td>
                <td className="muted">{project.jira.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          Configuration: <code>{status.config.path}</code> · Database:{' '}
          <code>{status.config.database}</code>
        </p>
      </Panel>

      <Panel title="Contents">
        <div className="cards">
          {[...Object.entries(status.github), ...Object.entries(status.jira)].map(
            ([key, value]) => (
              <div className="card" key={key}>
                <span className="card-value">{value}</span>
                <span className="card-label">{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
              </div>
            ),
          )}
        </div>
      </Panel>

      {status.githubByRepository.length > 0 ? (
        <Panel title="GitHub repositories">
          <CountsTable
            keyHeader="Repository"
            rows={status.githubByRepository.map(({ repository, ...counts }) => ({
              name: repository,
              counts,
            }))}
          />
        </Panel>
      ) : null}

      {status.jiraByProject.length > 0 ? (
        <Panel title="Jira projects">
          <CountsTable
            keyHeader="Project"
            rows={status.jiraByProject.map(({ project, ...counts }) => ({
              name: project,
              counts,
            }))}
          />
        </Panel>
      ) : null}

      <Panel title="Recent sync runs">
        <table className="table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Source</th>
              <th>Target</th>
              <th>Mode</th>
              <th>Status</th>
              <th>API calls</th>
              <th>Items</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {status.runs.map((run) => (
              <tr key={run.id} title={run.error ?? undefined}>
                <td className="right">{run.id}</td>
                <td>{run.source}</td>
                <td>{run.target}</td>
                <td>{run.mode}</td>
                <td>{run.status}</td>
                <td className="right">{run.api_calls}</td>
                <td className="right">{run.items_synced}</td>
                <td className="muted">{formatRelative(run.started_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Sync state">
        <table className="table">
          <thead>
            <tr>
              <th>Scope</th>
              <th>Cursor</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {status.state.map((entry) => (
              <tr key={entry.scope}>
                <td>{entry.scope}</td>
                <td className="muted">{entry.cursor}</td>
                <td className="muted">{formatRelative(entry.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

/**
 * One row per repository or project, one column per kind of thing counted.
 *
 * The columns come from the rows rather than being listed here, so a count
 * added to the server appears without a second edit — and cannot be forgotten.
 */
function CountsTable({
  keyHeader,
  rows,
}: {
  keyHeader: string;
  rows: Array<{ name: string; counts: Record<string, number> }>;
}): ReactNode {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row.counts)))];

  return (
    <div className="table-scroll">
      <table className="table compact">
        <thead>
          <tr>
            <th>{keyHeader}</th>
            {columns.map((column) => (
              <th className="right" key={column}>
                {column.replace(/([A-Z])/g, ' $1').toLowerCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              {columns.map((column) => (
                <td className="right" key={column}>
                  {/* Zero is dimmed: what is there matters more than what is not. */}
                  <span className={row.counts[column] ? undefined : 'muted'}>
                    {row.counts[column] ?? 0}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
