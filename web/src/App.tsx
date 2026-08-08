import type { ReactNode } from 'react';

import { api } from './api.ts';
import type { Repository, StatusResponse } from './api.ts';
import { StateMessage, useAsync } from './components/common.tsx';
import { Palette } from './components/Palette.tsx';
import { useLocation } from './router.ts';
import { ActivityView } from './views/Activity.tsx';
import { DigestView } from './views/Digest.tsx';
import { IssuesView, PullRequestsView, WorkflowRunsView } from './views/GithubViews.tsx';
import { InsightsView } from './views/Insights.tsx';
import { SprintsView, WorkitemsView } from './views/JiraViews.tsx';
import { HistoryView } from './views/History.tsx';
import { Overview } from './views/Overview.tsx';
import { TicketsView } from './views/Tickets.tsx';

const ROUTES = [
  { id: 'overview', label: 'Overview' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'issues', label: 'GitHub issues' },
  { id: 'pulls', label: 'Pull requests' },
  { id: 'runs', label: 'Workflow runs' },
  { id: 'workitems', label: 'Jira work items' },
  { id: 'sprints', label: 'Sprints' },
  { id: 'activity', label: 'Activity' },
  { id: 'history', label: 'History' },
  { id: 'insights', label: 'Insights' },
  { id: 'digest', label: 'Digest' },
] as const;

type RouteId = (typeof ROUTES)[number]['id'];

export function App(): ReactNode {
  const { view } = useLocation();
  const route = (ROUTES.find((entry) => entry.id === view)?.id ?? 'overview') as RouteId;

  const status = useAsync<StatusResponse>(() => api.status(), []);
  const repos = useAsync<Repository[]>(() => api.repos(), []);

  return (
    <div className="app">
      <Palette />

      <nav className="sidebar">
        <h1>devcontext</h1>
        <p className="sidebar-shortcut">
          Search <kbd>{navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}</kbd>
          <kbd>K</kbd>
        </p>
        <ul>
          {ROUTES.map((entry) => (
            <li key={entry.id}>
              <a href={`#/${entry.id}`} className={entry.id === route ? 'active' : undefined}>
                {entry.label}
              </a>
            </li>
          ))}
        </ul>
        {status.data ? (
          <p className="sidebar-footer">
            {status.data.github.repositories} repositories · {status.data.jira.workitems} work items
          </p>
        ) : null}
      </nav>

      <main className="content">
        <StateMessage loading={status.loading} error={status.error} empty={false} emptyMessage="" />

        {status.data ? (
          <>
            {route === 'overview' ? <Overview status={status.data} /> : null}
            {route === 'tickets' ? <TicketsView /> : null}
            {route === 'issues' ? <IssuesView repos={repos.data ?? []} /> : null}
            {route === 'pulls' ? <PullRequestsView repos={repos.data ?? []} /> : null}
            {route === 'runs' ? <WorkflowRunsView repos={repos.data ?? []} /> : null}
            {route === 'workitems' ? (
              <WorkitemsView
                projects={[
                  ...new Set(status.data.config.projects.flatMap((project) => project.jira)),
                ].map((entry) => entry.split('/').pop() ?? entry)}
                types={status.data.filters.workitemTypes}
              />
            ) : null}
            {route === 'sprints' ? <SprintsView /> : null}
            {route === 'activity' ? <ActivityView /> : null}
            {route === 'history' ? <HistoryView /> : null}
            {route === 'insights' ? <InsightsView /> : null}
            {route === 'digest' ? <DigestView /> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
