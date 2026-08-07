import type { ReactNode } from 'react';

import { api, formatRelative } from '../api.ts';
import type { DigestEntry, DigestResponse } from '../api.ts';
import { Panel, StateMessage, useAsync } from '../components/common.tsx';
import { useUrlState } from '../router.ts';

const WINDOWS: Array<{ label: string; days: number }> = [
  { label: 'yesterday', days: 1 },
  { label: '3 days', days: 3 },
  { label: 'week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: 'month', days: 30 },
];

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function Stat({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div className="card">
      <span className="card-value">{value}</span>
      <span className="card-label">{label}</span>
    </div>
  );
}

/** One line per item — the digest is meant to be read, and pasted, as prose. */
function Entries({ title, entries }: { title: string; entries: DigestEntry[] }): ReactNode {
  if (entries.length === 0) return null;
  return (
    <Panel title={`${title} (${entries.length})`}>
      <ul className="digest-list">
        {entries.map((entry) => (
          <li key={`${title}-${entry.ref}`}>
            {entry.url ? (
              <a href={entry.url} target="_blank" rel="noreferrer">
                {entry.ref}
              </a>
            ) : (
              <span className="mono">{entry.ref}</span>
            )}{' '}
            {entry.title}
            {entry.who ? <span className="muted"> · {entry.who}</span> : null}
            {entry.at ? <span className="muted"> · {formatRelative(entry.at)}</span> : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function DigestView(): ReactNode {
  const [windowDays, setWindowDays] = useUrlState('days', '7');
  const [staleWindow, setStaleWindow] = useUrlState('stale', '30');
  const days = Number(windowDays) || 7;
  const staleDays = Number(staleWindow) || 30;

  // Computed inside the loader, not during render: a fresh timestamp on every
  // render would change the dependency key and reload the view forever.
  const { data, error, loading } = useAsync<DigestResponse>(
    () => api.digest({ since: daysAgo(days), staleAfter: daysAgo(staleDays), limit: '15' }),
    [days, staleDays],
  );

  return (
    <div className="stack">
      <Panel
        title="Digest"
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
              {[14, 30, 60, 90].map((value) => (
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
          <>
            <div className="cards">
              <Stat label="merged" value={data.github.pullRequestsMerged.length} />
              <Stat label="pull requests opened" value={data.github.pullRequestsOpened.length} />
              <Stat label="reviews" value={data.github.reviews} />
              <Stat label="work items finished" value={data.jira.finished.length} />
              <Stat label="work items started" value={data.jira.started.length} />
              <Stat label="issues closed" value={data.github.issuesClosed.length} />
              <Stat label="comments" value={data.github.comments + data.jira.comments} />
              <Stat label="failed runs" value={data.github.failedRuns.length} />
            </div>
            {data.quiet ? <p className="state">Nothing happened in this window.</p> : null}
          </>
        ) : null}
      </Panel>

      {data ? (
        <>
          <Entries title="Merged" entries={data.github.pullRequestsMerged} />
          <Entries title="Finished" entries={data.jira.finished} />
          <Entries title="Opened" entries={data.github.pullRequestsOpened} />
          <Entries title="Started" entries={data.jira.started} />
          <Entries title="New issues" entries={data.github.issuesOpened} />
          <Entries title="Closed issues" entries={data.github.issuesClosed} />

          {data.people.length > 0 ? (
            <Panel title="People">
              <table className="table">
                <thead>
                  <tr>
                    <th>Who</th>
                    <th className="right">Merged</th>
                    <th className="right">Opened</th>
                    <th className="right">Reviews</th>
                    <th className="right">Finished</th>
                    <th className="right">Comments</th>
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((person) => (
                    <tr key={person.person}>
                      <td>{person.person}</td>
                      <td className="right">{person.pullRequestsMerged}</td>
                      <td className="right">{person.pullRequestsOpened}</td>
                      <td className="right">{person.reviews}</td>
                      <td className="right">{person.workitemsFinished}</td>
                      <td className="right">{person.comments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ) : null}

          <Panel title="Still in flight">
            <div className="cards">
              <Stat label="work items in progress" value={data.inFlight.workitems} />
              <Stat label="open pull requests" value={data.inFlight.pullRequests} />
              <Stat label="drafts" value={data.inFlight.drafts} />
            </div>
          </Panel>

          {data.stale.length > 0 ? (
            <Panel title={`Still waiting (untouched for ${staleDays} days)`}>
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
                  {data.stale.map((item) => (
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
            </Panel>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
