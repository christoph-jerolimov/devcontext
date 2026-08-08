import type { ReactNode } from 'react';

import { api, formatRelative } from '../api.ts';
import type { ActivityEvent, ActivityResponse } from '../api.ts';
import { Badge, Panel, StateMessage, useAsync } from '../components/common.tsx';
import { usePeopleFilter } from '../components/PeopleFilter.tsx';
import { useUrlState } from '../router.ts';

/**
 * What people did, newest first.
 *
 * Every other view says what the state of things is. This one says what
 * happened, and the two cannot be derived from each other: an issue that was
 * opened, argued over for a fortnight and closed looks, in the issue list,
 * exactly like one nobody ever touched.
 */
export function ActivityView(): ReactNode {
  const [days, setDays] = useUrlState('days', '14');
  const [source, setSource] = useUrlState('source');
  const [kind, setKind] = useUrlState('kind');
  const [bots, setBots] = useUrlState('bots');
  const people = usePeopleFilter();

  const since = new Date(Date.now() - Number(days || '14') * 86_400_000).toISOString();

  const params = {
    since,
    source: source || undefined,
    kind: kind || undefined,
    bots: bots || undefined,
    ...people.params,
    limit: '200',
  };

  const feed = useAsync<ActivityResponse>(
    () => api.activity(params),
    [days, source, kind, bots, people.key],
  );

  const events = feed.data?.events ?? [];

  return (
    <Panel
      title="Activity"
      actions={
        <>
          <select value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="1">Last day</option>
            <option value="7">Last week</option>
            <option value="14">Last two weeks</option>
            <option value="30">Last month</option>
            <option value="90">Last quarter</option>
          </select>

          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">Both sources</option>
            <option value="github">GitHub</option>
            <option value="jira">Jira</option>
          </select>

          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">Everything</option>
            <option value="status">Status changes</option>
            <option value="comment">Comments</option>
            <option value="review">Reviews</option>
          </select>

          {people.control}

          <select value={bots} onChange={(event) => setBots(event.target.value)}>
            <option value="">People and bots</option>
            <option value="false">People only</option>
            <option value="only">Bots only</option>
          </select>
        </>
      }
    >
      <StateMessage
        loading={feed.loading}
        error={feed.error}
        empty={events.length === 0}
        emptyMessage="Nothing happened in this window. Try a longer one."
      />

      {events.length > 0 ? (
        <>
          <ol className="feed">
            {events.map((event) => (
              <li key={`${event.source} ${event.ref} ${event.at} ${event.action}`}>
                <div className="feed-line">
                  <Badge value={event.source} />
                  <strong>{who(event)}</strong>
                  <span className={`feed-action ${actionClass(event.action)}`}>{event.action}</span>
                  {event.url ? (
                    <a href={event.url} target="_blank" rel="noreferrer">
                      {event.ref}
                    </a>
                  ) : (
                    <span>{event.ref}</span>
                  )}
                  <span className="muted">{event.title}</span>
                  <span className="muted small feed-when">{formatRelative(event.at)}</span>
                </div>
                {event.detail ? <p className="muted small feed-detail">{event.detail}</p> : null}
              </li>
            ))}
          </ol>

          {/* A page is not the answer; saying so beats implying it is. */}
          <p className="muted small">
            {feed.data && feed.data.total > events.length
              ? `Showing ${String(events.length)} of ${String(feed.data.total)} — narrow the window to see the rest.`
              : `${String(events.length)} event(s).`}
          </p>
        </>
      ) : null}
    </Panel>
  );
}

/**
 * The person's name when the mapping knows it, else the raw identity.
 *
 * Resolved by the server, which has the identities; the viewer only has the
 * names. A row showing a bare login is one nobody has mapped yet.
 */
function who(event: ActivityEvent): string {
  return event.person?.name ?? event.actor ?? 'somebody';
}

/** The same colours the pull request and ticket views use for the same words. */
function actionClass(action: string): string {
  if (action.startsWith('opened') || action === 'created' || action === 'reopened')
    return 'is-open';
  if (action === 'merged') return 'is-merged';
  if (action === 'closed') return 'is-closed';
  if (action === 'approved') return 'is-open';
  if (action === 'requested changes') return 'is-warning';
  return 'is-muted';
}
