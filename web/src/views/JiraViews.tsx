import type { ReactNode } from 'react';

import { api, formatRelative, parseList } from '../api.ts';
import type { Sprint, Workitem } from '../api.ts';
import {
  Badge,
  Labels,
  Panel,
  StateMessage,
  useAsync,
  useSelection,
} from '../components/common.tsx';
import { DetailPanel } from '../components/DetailPanel.tsx';
import { Hierarchy } from '../components/Hierarchy.tsx';
import { useUrlState } from '../router.ts';

export function WorkitemsView({ projects }: { projects: string[] }): ReactNode {
  const [project, setProject] = useUrlState('project');
  const [type, setType] = useUrlState('type');
  const [category, setCategory] = useUrlState('category');
  const [query, setQuery] = useUrlState('q');
  const detail = useSelection((reference) => api.workitem(reference));

  const { data, error, loading } = useAsync<Workitem[]>(
    () =>
      api.workitems({
        project: project || undefined,
        type: type || undefined,
        category: category || undefined,
        q: query || undefined,
        limit: '200',
      }),
    [project, type, category, query],
  );

  return (
    <div className="split">
      <Panel
        title="Work items"
        actions={
          <>
            <select value={project} onChange={(event) => setProject(event.target.value)}>
              <option value="">all projects</option>
              {projects.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
            <select value={type} onChange={(event) => setType(event.target.value)}>
              <option value="">any type</option>
              <option value="Epic">Epic</option>
              <option value="Feature">Feature</option>
              <option value="Story">Story</option>
              <option value="Task">Task</option>
              <option value="Bug">Bug</option>
            </select>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">any status</option>
              <option value="To Do">To Do</option>
              <option value="In Progress">In Progress</option>
              <option value="Done">Done</option>
            </select>
            <input
              type="search"
              placeholder="search summary, description, comments"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </>
        }
      >
        <StateMessage
          loading={loading}
          error={error}
          empty={(data ?? []).length === 0}
          emptyMessage="No work items match these filters."
        />
        {data && data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Type</th>
                <th>Summary</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Points</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.map((item) => (
                <tr key={item.key} onClick={() => detail.open(item.key)}>
                  <td>{item.key}</td>
                  <td className="muted">{item.type}</td>
                  <td>
                    {item.summary} <Labels values={parseList(item.labels)} />
                  </td>
                  <td>
                    <Badge
                      value={item.status}
                      kind={(item.status_category ?? '').toLowerCase().replace(/\W+/g, '-')}
                    />
                  </td>
                  <td>{item.assignee}</td>
                  <td className="right">{item.story_points ?? ''}</td>
                  <td className="muted">{formatRelative(item.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <DetailPanel
        document={detail.document}
        loading={detail.loading}
        error={detail.error}
        onClose={detail.close}
        extra={
          typeof detail.document?.key === 'string' ? (
            <Hierarchy workitemKey={detail.document.key} onOpen={detail.open} />
          ) : null
        }
      />
    </div>
  );
}

export function SprintsView(): ReactNode {
  const [state, setState] = useUrlState('state');
  const detail = useSelection((reference) => api.sprint(Number(reference)));

  const { data, error, loading } = useAsync<Sprint[]>(
    () => api.sprints({ state: state || undefined, limit: '200' }),
    [state],
  );

  return (
    <div className="split">
      <Panel
        title="Sprints"
        actions={
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">any state</option>
            <option value="active">active</option>
            <option value="future">future</option>
            <option value="closed">closed</option>
          </select>
        }
      >
        <StateMessage
          loading={loading}
          error={error}
          empty={(data ?? []).length === 0}
          emptyMessage="No sprints synced yet."
        />
        {data && data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Id</th>
                <th>Name</th>
                <th>State</th>
                <th>Start</th>
                <th>End</th>
                <th>Items</th>
              </tr>
            </thead>
            <tbody>
              {data.map((sprint) => (
                <tr key={sprint.id} onClick={() => detail.open(String(sprint.id))}>
                  <td className="right">{sprint.id}</td>
                  <td>{sprint.name}</td>
                  <td>
                    <Badge value={sprint.state} />
                  </td>
                  <td className="muted">{(sprint.start_date ?? '').slice(0, 10)}</td>
                  <td className="muted">{(sprint.end_date ?? '').slice(0, 10)}</td>
                  <td className="right">{sprint.workitem_count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <DetailPanel
        document={detail.document}
        loading={detail.loading}
        error={detail.error}
        onClose={detail.close}
      />
    </div>
  );
}
