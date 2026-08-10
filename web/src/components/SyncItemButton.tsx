import type { ReactNode } from 'react';
import { useState, useSyncExternalStore } from 'react';

import { liveSyncState, requestSync, subscribeLive } from '../live.ts';
import { useWatch } from '../watch.ts';

/**
 * "Sync this item": refresh the one issue, pull request or work item that is
 * open right now, without waiting for the next full run.
 *
 * Only rendered when the server can sync at all (watch mode); on a plain
 * `devcontext serve` the viewer stays read-only and this renders nothing —
 * which also keeps the screenshots of the detail panel unchanged there.
 * Disabled while any sync runs: one writer is the rule, and the server would
 * answer 409 anyway.
 */
export function SyncItemButton({ reference }: { reference: string }): ReactNode {
  const watch = useWatch();
  const sync = useSyncExternalStore(subscribeLive, liveSyncState);
  const [refused, setRefused] = useState(false);

  if (!watch) return null;

  const busy = sync.running || (sync.paused ?? false);
  const syncItem = () => {
    setRefused(false);
    void requestSync(reference).then((accepted) => setRefused(!accepted));
  };

  return (
    <span className="sync-item">
      <button type="button" onClick={syncItem} disabled={busy} title={`Sync ${reference} now`}>
        Sync
      </button>
      {refused ? <span className="muted small">busy</span> : null}
    </span>
  );
}
