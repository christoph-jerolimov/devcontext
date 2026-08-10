import type { ReactNode } from 'react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { IssueDocument } from '../api.ts';
import type { Contributor } from '../api.ts';
import { liveVersion, subscribeLive } from '../live.ts';
import { Markdown } from '../markdown/Markdown.tsx';
import { useUrlState } from '../router.ts';

interface AsyncResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Loads data whenever the dependencies change — or the database does.
 *
 * The result is stored together with the dependency key it belongs to, so
 * "loading" is derived during render instead of being set from the effect, and
 * a response that arrives after the filters changed cannot overwrite the newer
 * one.
 *
 * Every consumer is also subscribed to the live data version from
 * `/api/events`. When a sync commits, the version moves and the effect runs
 * again — but only a change of the *dependencies* shows "Loading…". A live
 * refresh keeps the old rows on screen until the new ones arrive, because a
 * page that blanks itself every few minutes is worse than a page that is a
 * request behind.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncResult<T> {
  const key = JSON.stringify(deps);
  const live = useSyncExternalStore(subscribeLive, liveVersion);
  const [settled, setSettled] = useState<{ key: string | null } & Omit<AsyncResult<T>, 'loading'>>({
    key: null,
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    loader()
      .then((result) => {
        if (!cancelled) setSettled({ key, data: result, error: null });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setSettled({
          key,
          data: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });

    return () => {
      cancelled = true;
    };
    // `loader` is recreated on every render; the dependency key is what matters.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live]);

  if (settled.key !== key) return { data: null, error: null, loading: true };
  return { data: settled.data, error: settled.error, loading: false };
}

export interface Selection {
  document: IssueDocument | null;
  error: string | null;
  loading: boolean;
  open: (reference: string) => void;
  close: () => void;
}

/**
 * Which item is open is part of the URL, so a link somebody shares opens the
 * same ticket rather than the same list. `load` turns the reference back into
 * a request, which is the only part each view has to supply.
 */
export function useSelection(load: (reference: string) => Promise<IssueDocument>): Selection {
  const [reference, setReference] = useUrlState('open');
  const { data, error, loading } = useAsync<IssueDocument | null>(
    () => (reference === '' ? Promise.resolve(null) : load(reference)),
    [reference],
  );

  return {
    document: reference === '' ? null : data,
    error,
    loading: reference !== '' && loading,
    open: setReference,
    close: () => setReference(''),
  };
}

export function Panel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="panel">
      <header className="panel-header">
        <h2>{title}</h2>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function StateMessage({
  loading,
  error,
  empty,
  emptyMessage,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyMessage: string;
}): ReactNode {
  if (loading) return <p className="state">Loading…</p>;
  if (error) return <p className="state state-error">{error}</p>;
  if (empty) return <p className="state">{emptyMessage}</p>;
  return null;
}

export function Badge({ value, kind }: { value: string | null; kind?: string }): ReactNode {
  if (!value) return null;
  return (
    <span className={`badge badge-${kind ?? value.toLowerCase().replace(/\W+/g, '-')}`}>
      {value}
    </span>
  );
}

export function Labels({ values }: { values: string[] }): ReactNode {
  if (values.length === 0) return null;
  return (
    <span className="labels">
      {values.map((value) => (
        <span className="label" key={value}>
          {value}
        </span>
      ))}
    </span>
  );
}

/**
 * Renders the body of an issue, pull request, review or work item.
 *
 * Both platforms end up as markdown: GitHub returns GitHub flavoured markdown,
 * and the CLI converts Jira's Atlassian Document Format and wiki markup during
 * sync, so one renderer serves both.
 */
export function Body({ text }: { text: string | null | undefined }): ReactNode {
  return <Markdown text={text} />;
}

/**
 * The people who touched an item, as a table cell.
 *
 * Two names and a count of the rest, rather than all of them. A busy pull
 * request has eight people on it and a column listing all eight is a column
 * nobody reads — but one that silently shows the first two is worse, because
 * it looks like the whole answer. The hover carries everybody, with what each
 * of them did.
 *
 * The names arrive resolved: the server has the identities behind them, the
 * viewer only has the display names. A bare login here is somebody nobody has
 * mapped yet, which is worth seeing rather than hiding.
 */
export function Contributors({
  people,
  show = 2,
}: {
  people: Contributor[] | undefined;
  show?: number;
}): ReactNode {
  if (!people || people.length === 0) return null;

  const names = people.map((person) => person.name);
  const shown = names.slice(0, show);
  const rest = names.length - shown.length;
  const full = people.map((person) => `${person.name} — ${person.roles.join(', ')}`).join('\n');

  return (
    <span className="muted" title={full}>
      {shown.join(', ')}
      {rest > 0 ? <span className="contributors-rest"> +{rest}</span> : null}
    </span>
  );
}
