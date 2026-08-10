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

export interface LiveSyncState {
  running: boolean;
  lastFinishedAt: string | null;
  lastError: string | null;
}

const DEBOUNCE_MS = 2000;

let version = 0;
let syncState: LiveSyncState = { running: false, lastFinishedAt: null, lastError: null };
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
    syncState = { ...syncState, running: true };
    notify();
  });
  source.addEventListener('sync-completed', (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      at: string;
      status: 'completed' | 'failed';
      error: string | null;
    };
    syncState = {
      running: false,
      lastFinishedAt: payload.at,
      lastError: payload.error,
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

/** Asks a watch-mode server to sync now. Resolves false on a 409. */
export async function requestSync(): Promise<boolean> {
  const response = await fetch('/api/sync', { method: 'POST' });
  return response.status === 202;
}
