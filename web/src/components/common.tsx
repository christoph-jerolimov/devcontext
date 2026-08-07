import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

/** Loads data whenever the dependencies change and keeps the last error. */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    loader()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
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

/** Renders the body of an issue / work item as preformatted, wrapped text. */
export function Body({ text }: { text: string | null | undefined }): ReactNode {
  if (!text) return null;
  return <pre className="body">{text}</pre>;
}
