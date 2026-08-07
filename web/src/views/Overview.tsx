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
