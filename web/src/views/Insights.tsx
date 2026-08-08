import type { ReactNode } from 'react';

import { api, formatRelative } from '../api.ts';
import type { InsightsResponse, StatusTimesResponse } from '../api.ts';
import { Panel, StateMessage, useAsync } from '../components/common.tsx';
import { useUrlState } from '../router.ts';

/** `36.5` -> `1d 12h`. Mirrors the CLI so both read the same. */
function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

function Stat({ label, value }: { label: string; value: string | number }): ReactNode {
  return (
    <div className="card">
      <span className="card-value">{value}</span>
      <span className="card-label">{label}</span>
    </div>
  );
}

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '180 days', days: 180 },
  { label: '1 year', days: 365 },
];

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function InsightsView(): ReactNode {
  const [windowDays, setWindowDays] = useUrlState('days', '90');
  const [staleWindow, setStaleWindow] = useUrlState('stale', '30');
  const days = Number(windowDays) || 90;
  const staleDays = Number(staleWindow) || 30;

  // The timestamps are computed inside the loader on purpose: deriving them
  // during render would produce a new value on every render, and useAsync keys
  // its request off the dependencies, so the view would reload forever.
  const { data, error, loading } = useAsync<InsightsResponse>(
    () => api.insights({ since: daysAgo(days), staleAfter: daysAgo(staleDays), limit: '15' }),
    [days, staleDays],
  );

  // Its own request: it reads `state_changes` rather than the current tables,
  // and the overview endpoint has no business growing a section from another.
  const statusTime = useAsync<StatusTimesResponse>(
    () => api.statusTimes({ since: daysAgo(days), limit: '15' }),
    [days],
  );

  return (
    <div className="stack">
      <Panel
        title="Insights"
        actions={
          <>
            <select value={days} onChange={(event) => setWindowDays(event.target.value)}>
              {WINDOWS.map((window) => (
                <option key={window.days} value={window.days}>
                  last {window.label}
                </option>
              ))}
            </select>
            <select value={staleDays} onChange={(event) => setStaleWindow(event.target.value)}>
              {[14, 30, 60, 90, 180].map((value) => (
                <option key={value} value={value}>
                  stale after {value}d
                </option>
              ))}
            </select>
          </>
        }
      >
        <StateMessage loading={loading} error={error} empty={false} emptyMessage="" />
        {data ? (
          <div className="cards">
            <Stat label="cycle time (median)" value={formatHours(data.cycleTime.overall.p50)} />
            <Stat label="cycle time (p85)" value={formatHours(data.cycleTime.overall.p85)} />
            <Stat
              label="to first review (median)"
              value={formatHours(data.reviewLatency.toFirstReview.p50)}
            />
            <Stat label="to merge (median)" value={formatHours(data.reviewLatency.toMerge.p50)} />
            <Stat label="work items in progress" value={data.wip.workitems} />
            <Stat label="open pull requests" value={data.wip.openPullRequests} />
            <Stat label="stale items" value={data.stale.items.length} />
            <Stat label="merged without review" value={data.reviewLatency.mergedWithoutReview} />
          </div>
        ) : null}
      </Panel>

      {data ? (
        <>
          <Panel title="Cycle time by type">
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th className="right">Items</th>
                  <th className="right">Median</th>
                  <th className="right">P85</th>
                  <th className="right">Longest</th>
                </tr>
              </thead>
              <tbody>
                {data.cycleTime.byType.map((entry) => (
                  <tr key={entry.type}>
                    <td>{entry.type}</td>
                    <td className="right">{entry.distribution.count}</td>
                    <td className="right">{formatHours(entry.distribution.p50)}</td>
                    <td className="right">{formatHours(entry.distribution.p85)}</td>
                    <td className="right">{formatHours(entry.distribution.max)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.cycleTime.byType.length === 0 ? (
              <p className="state">No completed work items with a status history in this window.</p>
            ) : null}
          </Panel>

          <Panel title="Work in progress">
            <table className="table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th className="right">Work items</th>
                  <th className="right">Pull requests</th>
                  <th className="right">Oldest</th>
                </tr>
              </thead>
              <tbody>
                {data.wip.byAssignee.map((entry) => (
                  <tr key={entry.assignee}>
                    <td>{entry.assignee}</td>
                    <td className="right">{entry.workitems}</td>
                    <td className="right">{entry.pullRequests}</td>
                    <td className="right">{formatHours(entry.oldestHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Reviewers">
            <table className="table">
              <thead>
                <tr>
                  <th>Reviewer</th>
                  <th className="right">Reviews</th>
                  <th className="right">Median response</th>
                </tr>
              </thead>
              <tbody>
                {data.reviewLatency.byReviewer.map((entry) => (
                  <tr key={entry.reviewer}>
                    <td>{entry.reviewer}</td>
                    <td className="right">{entry.reviews}</td>
                    <td className="right">{formatHours(entry.medianResponseHours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.reviewLatency.byReviewer.length === 0 ? (
              <p className="state">No reviews in this window.</p>
            ) : null}
          </Panel>

          <Panel title={`Flaky steps (at least ${data.flaky.minRuns} runs)`}>
            <table className="table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Job</th>
                  <th>Step</th>
                  <th className="right">Runs</th>
                  <th className="right">Failures</th>
                  <th className="right">Rate</th>
                  <th className="right">Retried green</th>
                </tr>
              </thead>
              <tbody>
                {data.flaky.steps.map((step) => (
                  <tr key={`${step.workflow}-${step.job}-${step.step}`}>
                    <td className="muted">{step.workflow}</td>
                    <td className="muted">{step.job}</td>
                    <td>{step.step}</td>
                    <td className="right">{step.runs}</td>
                    <td className="right">{step.failures}</td>
                    <td className="right">
                      {step.failureRate === null ? '—' : `${step.failureRate}%`}
                    </td>
                    <td className="right">{step.retriedGreen}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.flaky.steps.length === 0 ? (
              <p className="state">No step failed often enough to report.</p>
            ) : null}
          </Panel>

          <Panel title="Time in each status">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Category</th>
                  <th className="right">Stays</th>
                  <th className="right">Median</th>
                  <th className="right">P85</th>
                  <th className="right">Longest</th>
                </tr>
              </thead>
              <tbody>
                {(statusTime.data?.statuses ?? []).map((entry) => (
                  <tr key={entry.status}>
                    <td>{entry.status}</td>
                    <td className="muted">{entry.category}</td>
                    <td className="right">{entry.stays}</td>
                    <td className="right">{formatHours(entry.hours.p50)}</td>
                    <td className="right">{formatHours(entry.hours.p85)}</td>
                    <td className="right">{formatHours(entry.hours.max)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(statusTime.data?.statuses ?? []).length === 0 ? (
              <p className="state">
                No completed stay in any status in this window. Jira only; needs the changelog.
              </p>
            ) : null}
            {statusTime.data && statusTime.data.ongoing > 0 ? (
              <p className="muted small">
                {`${String(statusTime.data.ongoing)} item(s) are still sitting somewhere and are not counted — a stay that has not ended has an unknown length, not a short one.`}
              </p>
            ) : null}
          </Panel>

          <Panel title={`Stale (untouched for ${staleDays} days)`}>
            <table className="table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Reference</th>
                  <th>Title</th>
                  <th>Owner</th>
                  <th>Last touched</th>
                </tr>
              </thead>
              <tbody>
                {data.stale.items.map((item) => (
                  <tr key={`${item.kind}-${item.ref}`}>
                    <td className="muted">{item.kind}</td>
                    <td>{item.ref}</td>
                    <td>{item.title}</td>
                    <td>{item.owner}</td>
                    <td className="muted">{formatRelative(item.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.stale.items.length === 0 ? (
              <p className="state">Nothing has gone stale.</p>
            ) : null}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
