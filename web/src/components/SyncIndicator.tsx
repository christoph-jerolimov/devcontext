import type { ReactNode } from 'react';
import { useState, useSyncExternalStore } from 'react';

import type { StatusResponse } from '../api.ts';
import { formatRelative } from '../api.ts';
import { liveSyncState, requestSync, subscribeLive } from '../live.ts';

/**
 * What the background sync is doing, and the button to kick one off.
 *
 * Renders nothing at all until there is something to say: the server is not
 * in watch mode and no sync has run while this page was open. That silence is
 * deliberate — on a plain `devcontext serve` the viewer looks exactly as it
 * always did.
 */
export function SyncIndicator({ watch }: { watch: StatusResponse['watch'] }): ReactNode {
  const sync = useSyncExternalStore(subscribeLive, liveSyncState);
  const [refused, setRefused] = useState(false);

  if (!watch && !sync.running && sync.lastFinishedAt === null) return null;

  const label = sync.running
    ? 'Syncing…'
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
      <span className={sync.lastError !== null && !sync.running ? 'state-error' : 'muted'}>
        {sync.running ? <span className="sync-spinner" aria-hidden="true" /> : null}
        {label}
      </span>
      {watch ? (
        <button type="button" onClick={syncNow} disabled={sync.running}>
          Sync now
        </button>
      ) : null}
      {refused ? <span className="muted small">already running</span> : null}
    </div>
  );
}
