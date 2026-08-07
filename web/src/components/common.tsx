import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { Markdown } from '../markdown/Markdown.tsx';

interface AsyncResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Loads data whenever the dependencies change.
 *
 * The result is stored together with the dependency key it belongs to, so
 * "loading" is derived during render instead of being set from the effect, and
 * a response that arrives after the filters changed cannot overwrite the newer
 * one.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncResult<T> {
  const key = JSON.stringify(deps);
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
  }, [key]);

  if (settled.key !== key) return { data: null, error: null, loading: true };
  return { data: settled.data, error: settled.error, loading: false };
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
