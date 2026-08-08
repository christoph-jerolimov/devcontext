import type { ReactNode } from 'react';

import { api } from '../api.ts';
import type { ClosedResponse, HistoryResponse, RunsResponse, StatusResponse } from '../api.ts';
import { AreaChart, StackedBarChart } from '../components/Charts.tsx';
import { Panel, StateMessage, useAsync } from '../components/common.tsx';
import { usePeopleFilter } from '../components/PeopleFilter.tsx';
import { useUrlState } from '../router.ts';

const WINDOWS = [
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 6 months' },
  { value: '365', label: 'Last year' },
];

/**
 * The shape of the work over time, as four charts.
 *
 * Three of them are balances — how many were open on each day — and no other
 * view can answer that: an item opened in January, closed in February and
 * reopened in March is one row saying "open", and that row reads the same
 * whichever month you ask about. They come from `state_changes`, which keeps
 * the transitions rather than the outcome. See docs/history.md.
 *
 * The last two are counts of events inside the window rather than balances,
 * which is a different question with a different right answer, so they come
 * from the items themselves.
 */
export function HistoryView(): ReactNode {
  const [days, setDays] = useUrlState('days', '30');
  const [container, setContainer] = useUrlState('container');
  const people = usePeopleFilter();

  const to = new Date();
  const from = new Date(to.getTime() - (Number(days) - 1) * 86_400_000);
  const window = { from: from.toISOString(), to: to.toISOString() };
  const scope = { ...window, container: container || undefined };

  const status = useAsync<StatusResponse>(() => api.status(), []);
  const repositories = status.data?.filters.containers.github ?? [];
  const projects = status.data?.filters.containers.jira ?? [];

  const tickets = useAsync<HistoryResponse>(() => api.history(scope), [days, container]);
  const issues = useAsync<HistoryResponse>(
    () => api.history({ ...scope, source: 'github', kind: 'issue' }),
    [days, container],
  );
  const pulls = useAsync<HistoryResponse>(
    () => api.history({ ...scope, source: 'github', kind: 'pull_request' }),
    [days, container],
  );
  const runs = useAsync<RunsResponse>(() => api.runsPerDay(scope), [days, container]);
  const closed = useAsync<ClosedResponse>(
    () => api.closedPerDay({ ...scope, ...people.params }),
    [days, container, people.key],
  );

  const containerControl =
    repositories.length + projects.length === 0 ? null : (
      <select
        value={container}
        aria-label="Repository or project"
        onChange={(event) => setContainer(event.target.value)}
      >
        <option value="">Everywhere</option>
        {repositories.length > 0 ? (
          <optgroup label="Repositories">
            {repositories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {projects.length > 0 ? (
          <optgroup label="Jira projects">
            {projects.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    );

  return (
    <div className="stack">
      <Panel
        title="Open tickets"
        actions={
          <>
            {containerControl}
            <select value={days} onChange={(event) => setDays(event.target.value)}>
              {WINDOWS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </>
        }
      >
        <OpenPanel
          state={tickets}
          label="Open tickets per day"
          empty='No history yet. It is built after every sync — or run "devcontext history --rebuild".'
        />
      </Panel>

      <Panel title="Open GitHub issues">
        <OpenPanel
          state={issues}
          label="Open GitHub issues per day"
          empty="No GitHub issues in this window."
        />
      </Panel>

      <Panel title="Open pull requests">
        <OpenPanel
          state={pulls}
          label="Open pull requests per day"
          empty="No pull requests in this window."
        />
      </Panel>

      <Panel title="Pull requests finished per day" actions={people.control}>
        {/*
         * Split by whether they were merged, because one number cannot say
         * whether a week of closing twelve pull requests went well. The
         * person filter is here and not on the charts above: those are
         * balances over every item, and "Ada's open pull requests on the 3rd
         * of March" needs an assignee history rather than the current row.
         */}
        <StateMessage
          loading={closed.loading}
          error={closed.error}
          empty={(closed.data?.days.length ?? 0) === 0}
          emptyMessage="Nothing finished in this window."
        />
        {closed.data && closed.data.days.length > 0 ? (
          <StackedBarChart
            label="Pull requests finished per day"
            legend={[
              { key: 'merged', className: 'bar-merged' },
              { key: 'closed unmerged', className: 'bar-discarded' },
            ]}
            bars={closed.data.days.map((day) => ({
              day: day.day,
              segments: [
                { key: 'merged', value: day.merged, className: 'bar-merged' },
                { key: 'discarded', value: day.discarded, className: 'bar-discarded' },
              ],
              title: `${day.day}: ${String(day.total)} finished — ${String(day.merged)} merged, ${String(day.discarded)} closed unmerged`,
            }))}
            caption={` · ${String(closed.data.days.reduce((sum, day) => sum + day.merged, 0))} merged and ${String(closed.data.days.reduce((sum, day) => sum + day.discarded, 0))} thrown away in the window`}
          />
        ) : null}
      </Panel>

      <Panel title="Workflow runs per day">
        <StateMessage
          loading={runs.loading}
          error={runs.error}
          empty={(runs.data?.days.length ?? 0) === 0}
          emptyMessage="No workflow runs in this window."
        />
        {runs.data && runs.data.days.length > 0 ? (
          <StackedBarChart
            label="Workflow runs per day by conclusion"
            legend={[
              { key: 'success', className: 'bar-success' },
              { key: 'failure', className: 'bar-failure' },
              { key: 'cancelled', className: 'bar-cancelled' },
              { key: 'other', className: 'bar-other' },
            ]}
            bars={runs.data.days.map((day) => ({
              day: day.day,
              segments: [
                { key: 'success', value: day.success, className: 'bar-success' },
                { key: 'failure', value: day.failure, className: 'bar-failure' },
                { key: 'cancelled', value: day.cancelled, className: 'bar-cancelled' },
                { key: 'other', value: day.other, className: 'bar-other' },
              ],
              title: `${day.day}: ${String(day.total)} run(s) — ${String(day.success)} success, ${String(day.failure)} failure, ${String(day.cancelled)} cancelled, ${String(day.other)} other`,
            }))}
            caption={` · ${String(runs.data.days.reduce((sum, day) => sum + day.failure, 0))} failed of ${String(runs.data.days.reduce((sum, day) => sum + day.total, 0))} in the window`}
          />
        ) : null}
      </Panel>

      {(tickets.data?.byAssignee.length ?? 0) > 0 ? (
        <Panel title="Open per person, now">
          <table className="table">
            <thead>
              <tr>
                <th>Assignee</th>
                <th className="right">Open</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {(tickets.data?.byAssignee ?? []).map((entry) => (
                <tr key={entry.assignee}>
                  <td>{entry.assignee}</td>
                  <td className="right">{entry.open}</td>
                  <td>
                    <Meter
                      value={entry.open}
                      peak={Math.max(...(tickets.data?.byAssignee ?? []).map((row) => row.open), 1)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
    </div>
  );
}

/** One open-over-time chart, with the loading and empty states around it. */
function OpenPanel({
  state,
  label,
  empty,
}: {
  state: { data: HistoryResponse | null; error: string | null; loading: boolean };
  label: string;
  empty: string;
}): ReactNode {
  const rows = state.data?.days ?? [];
  const opened = rows.reduce((sum, day) => sum + day.opened, 0);
  const closed = rows.reduce((sum, day) => sum + day.closed, 0);
  const peak = Math.max(...rows.map((day) => day.open), 0);

  return (
    <>
      <StateMessage
        loading={state.loading}
        error={state.error}
        empty={rows.length === 0}
        emptyMessage={empty}
      />
      {rows.length > 0 ? (
        <AreaChart
          label={label}
          points={rows.map((day) => ({
            day: day.day,
            value: day.open,
            title: `${day.day}: ${String(day.open)} open (+${String(day.opened)} / -${String(day.closed)})`,
          }))}
          caption={`${String(rows.at(-1)?.open ?? 0)} open now · peak ${String(peak)} · ${String(opened)} opened and ${String(closed)} closed in the window`}
        />
      ) : null}
    </>
  );
}

/** A proportion, as a bar. Wide enough to compare, short enough for a cell. */
function Meter({ value, peak }: { value: number; peak: number }): ReactNode {
  return (
    <span className="meter" aria-hidden="true">
      <span className="meter-fill" style={{ width: `${String((value / peak) * 100)}%` }} />
    </span>
  );
}
