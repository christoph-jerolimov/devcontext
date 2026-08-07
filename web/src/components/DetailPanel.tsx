import type { ReactNode } from 'react';

import { Body, StateMessage } from './common.tsx';
import type { IssueDocument } from '../api.ts';
import { formatRelative } from '../api.ts';

interface Comment {
  id?: string | number | null;
  author?: string | null;
  createdAt?: string | null;
  body?: string | null;
}

interface HistoryEntry {
  id?: string | number | null;
  author?: string | null;
  createdAt?: string | null;
  field?: string | null;
  from?: string | null;
  to?: string | null;
  event?: string | null;
  actor?: string | null;
  label?: string | null;
}

interface Review {
  id?: string | number | null;
  author?: string | null;
  state?: string | null;
  submittedAt?: string | null;
  body?: string | null;
  comments?: Array<{
    id?: string | number | null;
    path?: string | null;
    line?: number | null;
    body?: string | null;
  }>;
}

/** Shows one issue, pull request, work item, sprint or workflow run. */
export function DetailPanel({
  document,
  loading,
  error,
  onClose,
}: {
  document: IssueDocument | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}): ReactNode {
  if (!loading && !error && !document) return null;

  const title = document?.title ?? document?.summary ?? document?.key ?? 'Details';
  const comments = (document?.comments as Comment[] | undefined) ?? [];
  const history = ((document?.history ?? document?.events) as HistoryEntry[] | undefined) ?? [];
  const reviews = (document?.reviews as Review[] | undefined) ?? [];
  const jobs = (document?.jobs as Array<Record<string, unknown>> | undefined) ?? [];
  const workitems = (document?.workitems as Array<Record<string, unknown>> | undefined) ?? [];

  return (
    <aside className="detail">
      <header className="detail-header">
        <h2>
          {document?.repository ? `${document.repository}#${document.number} ` : ''}
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>

      <StateMessage loading={loading} error={error} empty={false} emptyMessage="" />

      {document ? (
        <div className="detail-body">
          <dl className="meta">
            {metaEntries(document).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          {document.url ? (
            <p>
              <a href={String(document.url)} target="_blank" rel="noreferrer">
                Open on the platform ↗
              </a>
            </p>
          ) : null}

          <Body text={(document.body ?? document.description) as string | null} />

          {reviews.length > 0 ? (
            <section>
              <h3>Reviews ({reviews.length})</h3>
              {reviews.map((review, index) => (
                <article className="entry" key={review.id ?? `${review.author}-${index}`}>
                  <header>
                    <strong>{review.author ?? 'unknown'}</strong> {review.state}{' '}
                    <span className="muted">{formatRelative(review.submittedAt)}</span>
                  </header>
                  <Body text={review.body ?? null} />
                  {(review.comments ?? []).map((comment) => (
                    <p
                      className="review-comment"
                      key={comment.id ?? `${comment.path}-${comment.line}`}
                    >
                      <code>
                        {comment.path}
                        {comment.line ? `:${comment.line}` : ''}
                      </code>{' '}
                      {comment.body}
                    </p>
                  ))}
                </article>
              ))}
            </section>
          ) : null}

          {comments.length > 0 ? (
            <section>
              <h3>Comments ({comments.length})</h3>
              {comments.map((comment, index) => (
                <article className="entry" key={comment.id ?? `${comment.createdAt}-${index}`}>
                  <header>
                    <strong>{comment.author ?? 'unknown'}</strong>{' '}
                    <span className="muted">{formatRelative(comment.createdAt)}</span>
                  </header>
                  <Body text={comment.body ?? null} />
                </article>
              ))}
            </section>
          ) : null}

          {jobs.length > 0 ? (
            <section>
              <h3>Jobs ({jobs.length})</h3>
              {jobs.map((job, index) => (
                <article className="entry" key={String(job.id ?? index)}>
                  <header>
                    <strong>{String(job.name ?? '')}</strong>{' '}
                    <span className="muted">{String(job.conclusion ?? job.status ?? '')}</span>
                  </header>
                  <table className="table compact">
                    <tbody>
                      {((job.steps as Array<Record<string, unknown>> | undefined) ?? []).map(
                        (step, stepIndex) => (
                          <tr key={String(step.number ?? stepIndex)}>
                            <td>{String(step.number ?? '')}</td>
                            <td>{String(step.name ?? '')}</td>
                            <td>{String(step.conclusion ?? step.status ?? '')}</td>
                            <td className="right">
                              {step.durationMs
                                ? `${Math.round(Number(step.durationMs) / 1000)}s`
                                : ''}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </article>
              ))}
            </section>
          ) : null}

          {workitems.length > 0 ? (
            <section>
              <h3>Work items ({workitems.length})</h3>
              <table className="table compact">
                <tbody>
                  {workitems.map((item, index) => (
                    <tr key={String(item.key ?? index)}>
                      <td>{String(item.key ?? '')}</td>
                      <td>{String(item.status ?? '')}</td>
                      <td>{String(item.summary ?? '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {history.length > 0 ? (
            <section>
              <h3>History ({history.length})</h3>
              <table className="table compact">
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id ?? `${entry.createdAt}-${entry.field ?? entry.event}`}>
                      <td className="muted">{formatRelative(entry.createdAt)}</td>
                      <td>{entry.author ?? entry.actor ?? ''}</td>
                      <td>{entry.field ?? entry.event ?? ''}</td>
                      <td>
                        {entry.from ? `${entry.from} → ` : ''}
                        {entry.to ?? entry.label ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function metaEntries(document: IssueDocument): Array<[string, string]> {
  const keys = [
    'state',
    'status',
    'statusCategory',
    'type',
    'priority',
    'author',
    'assignee',
    'reporter',
    'draft',
    'head',
    'base',
    'storyPoints',
    'sprint',
    'epic',
    'parent',
    'conclusion',
    'event',
    'branch',
    'createdAt',
    'updatedAt',
    'closedAt',
    'mergedAt',
    'resolvedAt',
  ];

  const entries: Array<[string, string]> = [];
  for (const key of keys) {
    const value = document[key];
    if (value === undefined || value === null || value === '') continue;
    entries.push([key, String(value)]);
  }

  const labels = document.labels as string[] | undefined;
  if (labels && labels.length > 0) entries.push(['labels', labels.join(', ')]);

  const custom = document.customFields as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(custom ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    entries.push([key, Array.isArray(value) ? value.join(', ') : String(value)]);
  }

  return entries;
}
