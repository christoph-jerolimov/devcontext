import type { ReactNode } from 'react';

import { api, formatRelative } from '../api.ts';
import type { ActivityEvent, ActivityResponse, StatusResponse } from '../api.ts';
import { Badge, Panel, StateMessage, useAsync } from '../components/common.tsx';
import { usePeopleFilter } from '../components/PeopleFilter.tsx';
import { useUrlState } from '../router.ts';

/**
 * The windows the feed offers, shortest first.
 *
 * Hours are here because the feed answers "what happened while I was in that
 * meeting" as often as "what happened this fortnight", and a day was the
 * finest grain available — which on a busy repository is hundreds of rows to
 * read for an answer about the last twenty minutes.
 */
export const WINDOWS = [
  { value: '1h', label: 'Last hour', hours: 1 },
  { value: '2h', label: 'Last 2 hours', hours: 2 },
  { value: '4h', label: 'Last 4 hours', hours: 4 },
  { value: '8h', label: 'Last 8 hours', hours: 8 },
  { value: '12h', label: 'Last 12 hours', hours: 12 },
  { value: '1d', label: 'Last day', hours: 24 },
  { value: '7d', label: 'Last week', hours: 7 * 24 },
  { value: '14d', label: 'Last two weeks', hours: 14 * 24 },
  { value: '30d', label: 'Last month', hours: 30 * 24 },
  { value: '90d', label: 'Last quarter', hours: 90 * 24 },
] as const;

export const DEFAULT_WINDOW = '14d';
const DEFAULT_HOURS = 14 * 24;

/**
 * How far back a window value reaches.
 *
 * An unknown value — a stale bookmark, a hand-edited URL — falls back to the
 * default rather than to nothing. Reaching back zero hours renders an empty
 * feed, and an empty feed is exactly what a quiet fortnight looks like, so the
 * mistake would be invisible in the one output that could reveal it.
 */
export function hoursFor(value: string): number {
  return WINDOWS.find((entry) => entry.value === value)?.hours ?? DEFAULT_HOURS;
}

/**
 * What people did, newest first.
 *
 * Every other view says what the state of things is. This one says what
 * happened, and the two cannot be derived from each other: an issue that was
 * opened, argued over for a fortnight and closed looks, in the issue list,
 * exactly like one nobody ever touched.
 */
export function ActivityView(): ReactNode {
  const [range, setRange] = useUrlState('window', DEFAULT_WINDOW);
  const [source, setSource] = useUrlState('source');
  const [container, setContainer] = useUrlState('container');
  const [kind, setKind] = useUrlState('kind');
  const [bots, setBots] = useUrlState('bots');
  const people = usePeopleFilter();

  const status = useAsync<StatusResponse>(() => api.status(), []);
  const repositories = status.data?.filters.containers.github ?? [];
  const projects = status.data?.filters.containers.jira ?? [];

  const since = new Date(Date.now() - hoursFor(range) * 3_600_000).toISOString();

  const params = {
    since,
    source: source || undefined,
    container: container || undefined,
    kind: kind || undefined,
    bots: bots || undefined,
    ...people.params,
    limit: '200',
  };

  const feed = useAsync<ActivityResponse>(
    () => api.activity(params),
    [range, source, container, kind, bots, people.key],
  );

  const events = feed.data?.events ?? [];

  return (
    <Panel
      title="Activity"
      actions={
        <>
          <select
            value={range}
            aria-label="Time window"
            onChange={(event) => setRange(event.target.value)}
          >
            {WINDOWS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>

          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">Both sources</option>
            <option value="github">GitHub</option>
            <option value="jira">Jira</option>
          </select>

          {/*
           * Repositories and Jira projects share one control, the way people
           * and teams do: they answer the same question, and the feed mixes
           * both platforms anyway.
           */}
          {repositories.length + projects.length > 0 ? (
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
          ) : null}

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
