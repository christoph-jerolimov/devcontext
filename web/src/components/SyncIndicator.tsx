import type { ReactNode } from 'react';
import { useState, useSyncExternalStore } from 'react';

import type { StatusResponse, SyncProgress } from '../api.ts';
import { formatRelative } from '../api.ts';
import { liveSyncState, requestPause, requestResume, requestSync, subscribeLive } from '../live.ts';

/**
 * What the background sync is doing, and the buttons to steer it.
 *
 * A sync can run for hours, and for exactly that reason it must not run
 * silently: while one is going this shows a bar, the estimate, and the item
 * being fetched right now — and a Pause button, because hours of API calls
 * somebody did not want right now should be stoppable without hunting for
 * the serving terminal. The snapshot comes from two places on purpose — the
 * event stream while the page is open, and `/api/status` for a page opened
 * two hours into a run, which would otherwise say nothing until the next
 * event happened to arrive.
 *
 * Renders nothing at all until there is something to say: the server is not
 * in watch mode and no sync has run while this page was open. That silence is
 * deliberate — on a plain `devcontext serve` the viewer looks exactly as it
 * always did.
 */
export function SyncIndicator({ watch }: { watch: StatusResponse['watch'] }): ReactNode {
  const sync = useSyncExternalStore(subscribeLive, liveSyncState);
  const [refused, setRefused] = useState(false);

  const running = sync.running || (watch?.running ?? false);
  const paused = sync.paused ?? watch?.paused ?? false;
  const progress = sync.progress ?? watch?.progress ?? null;

  if (!watch && !running && sync.lastFinishedAt === null) return null;

  const label = paused
    ? 'Sync paused'
    : running
      ? syncingLabel(progress)
      : sync.lastFinishedAt !== null
        ? sync.lastError !== null
          ? `Sync failed ${formatRelative(sync.lastFinishedAt)}`
          : `Synced ${formatRelative(sync.lastFinishedAt)}`
        : watch
          ? `Syncing every ${String(Math.round(watch.intervalMs / 1000))}s`
          : '';

  const syncNow = () => {
    setRefused(false);
    void requestSync().then((accepted) => setRefused(!accepted));
  };

  return (
    <div className="sync-indicator">
      <div className="sync-indicator-row">
        <span className={sync.lastError !== null && !running && !paused ? 'state-error' : 'muted'}>
          {running && !paused ? <span className="sync-spinner" aria-hidden="true" /> : null}
          {label}
        </span>
        {watch ? (
          paused ? (
            <button type="button" onClick={() => void requestResume()}>
              Resume
            </button>
          ) : running ? (
            <button type="button" onClick={() => void requestPause()}>
              Pause
            </button>
          ) : (
            <>
              <button type="button" onClick={syncNow}>
                Sync now
              </button>
              <button type="button" onClick={() => void requestPause()}>
                Pause
              </button>
            </>
          )
        ) : null}
        {refused ? <span className="muted small">already running</span> : null}
      </div>
      {running && !paused && progress ? <SyncProgressBar progress={progress} /> : null}
    </div>
  );
}

function SyncProgressBar({ progress }: { progress: SyncProgress }): ReactNode {
  const expected = Math.max(progress.apiCallsExpected, progress.apiCalls, 1);
  const percent = Math.min(100, Math.round((progress.apiCalls / expected) * 100));
  const detail = progress.position ? `${progress.phase}: ${progress.position}` : progress.phase;

  return (
    <>
      <div className="sync-progress-track" role="progressbar" aria-valuenow={percent}>
        <div className="sync-progress-fill" style={{ width: `${String(percent)}%` }} />
      </div>
      {detail ? <span className="muted small sync-progress-detail">{detail}</span> : null}
    </>
  );
}

function syncingLabel(progress: SyncProgress | null): string {
  if (!progress) return 'Syncing…';
  const expected = Math.max(progress.apiCallsExpected, progress.apiCalls, 1);
  const percent = Math.min(100, Math.round((progress.apiCalls / expected) * 100));
  const parts = [`Syncing… ${String(percent)}%`];
  if (progress.etaMs !== null && progress.etaMs > 0)
    parts.push(`~${formatEta(progress.etaMs)} left`);
  return parts.join(', ');
}

function formatEta(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 90) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${String(hours)}h ${String(rest)}m` : `${String(hours)}h`;
  }
  if (minutes >= 1) return `${String(minutes)}m`;
  return `${String(Math.max(1, Math.round(ms / 1000)))}s`;
}
