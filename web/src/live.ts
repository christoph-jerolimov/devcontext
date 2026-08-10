/**
 * The viewer's connection to `/api/events`.
 *
 * One EventSource for the whole app, opened lazily on the first subscriber —
 * not one per view, which would multiply the server's poll work by however
 * many components are on screen. Everything it learns is folded into two
 * numbers a `useSyncExternalStore` can read: a data version that moves when
 * the database changed, and a snapshot of what the background sync is doing.
 *
 * The version is debounced. A sync commits many times in quick succession,
 * and refetching every view on each commit would make the page flicker
 * through half-written states; one refresh a couple of seconds after the
 * burst starts shows the same end result for a fraction of the requests.
 */

import type { SyncProgress } from '@devcontext/shared';

export interface LiveSyncState {
  running: boolean;
  /** Null until the stream has said either way; /api/status fills the gap. */
  paused: boolean | null;
  /** Where the running sync has got to; null between runs. */
  progress: SyncProgress | null;
  lastFinishedAt: string | null;
  lastError: string | null;
}

const DEBOUNCE_MS = 2000;

let version = 0;
let syncState: LiveSyncState = {
  running: false,
  paused: null,
  progress: null,
  lastFinishedAt: null,
  lastError: null,
};
let source: EventSource | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function bumpSoon(): void {
  if (pending !== null) return;
  pending = setTimeout(() => {
    pending = null;
    version += 1;
    notify();
  }, DEBOUNCE_MS);
}

function connect(): void {
  if (source !== null) return;
  source = new EventSource('/api/events');

  source.addEventListener('data-changed', () => bumpSoon());
  source.addEventListener('sync-started', () => {
    syncState = { ...syncState, running: true, progress: null };
    notify();
  });
  source.addEventListener('sync-progress', (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      progress: SyncProgress;
    };
    // `running: true` as well: a page that connected mid-sync never saw the
    // start, and the progress itself is the proof one is going.
    syncState = { ...syncState, running: true, progress: payload.progress };
    notify();
  });
  source.addEventListener('watch-paused', () => {
    syncState = { ...syncState, paused: true };
    notify();
  });
  source.addEventListener('watch-resumed', () => {
    syncState = { ...syncState, paused: false };
    notify();
  });
  source.addEventListener('sync-completed', (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      at: string;
      status: 'completed' | 'failed' | 'interrupted';
      error: string | null;
    };
    syncState = {
      ...syncState,
      running: false,
      progress: null,
      // An interrupted run is a pause, not an outcome; the paused flag
      // carries that story and the last real outcome stays what it was.
      lastFinishedAt: payload.status === 'interrupted' ? syncState.lastFinishedAt : payload.at,
      lastError: payload.status === 'interrupted' ? syncState.lastError : payload.error,
    };
    notify();
    // The data poller will also have noticed, but a finished sync is the one
    // moment a person is actively waiting on — skip the debounce.
    if (pending !== null) clearTimeout(pending);
    pending = null;
    version += 1;
    notify();
  });
  // On error the browser reconnects on its own; there is nothing useful to do.
}

/** Subscribe to any live change; starts the stream on first use. */
export function subscribeLive(listener: () => void): () => void {
  listeners.add(listener);
  connect();
  return () => listeners.delete(listener);
}

/** Moves when the database changed; the value itself means nothing. */
export function liveVersion(): number {
  return version;
}

export function liveSyncState(): LiveSyncState {
  return syncState;
}

/**
 * Asks a watch-mode server to sync now — everything, or with `only` just the
 * named item, which is what "Sync this item" on an opened issue or pull
 * request sends. Resolves false on a 409.
 */
export async function requestSync(only?: string): Promise<boolean> {
  const url = only === undefined ? '/api/sync' : `/api/sync?only=${encodeURIComponent(only)}`;
  const response = await fetch(url, { method: 'POST' });
  return response.status === 202;
}

/** Holds the interval and stops the run in flight at its next request. */
export async function requestPause(): Promise<void> {
  await fetch('/api/sync/pause', { method: 'POST' });
}

/** Lifts the pause; a run cut short by it continues where it left off. */
export async function requestResume(): Promise<void> {
  await fetch('/api/sync/resume', { method: 'POST' });
}
