/**
 * Stopping a sync without corrupting what it has already done.
 *
 * A sync is a long sequence of writes with cursors advancing behind it, and
 * Ctrl-C used to kill the process wherever it happened to be. Nothing was lost
 * — every write is an upsert and cursors only move when a resource finishes —
 * but the run was left `running` in the journal until the next sync noticed it
 * was stale, and the person was told nothing about what had been done.
 *
 * So the interrupt is caught and turned into an ordinary stop: the work in
 * flight is abandoned at the next request, the journal records the run as
 * interrupted, and the summary says which targets finished.
 */

/**
 * Thrown at the first request after a stop was asked for.
 *
 * A distinct type because the runner has to tell it apart from a target that
 * genuinely failed: one is a person pressing a key, the other is something to
 * report and investigate.
 */
export class SyncStopped extends Error {
  constructor() {
    super('The sync was stopped.');
    this.name = 'SyncStopped';
  }
}

export function isSyncStopped(error: unknown): boolean {
  return error instanceof SyncStopped || (error instanceof Error && error.name === 'SyncStopped');
}

/**
 * Turns the first interrupt into a request to stop, and the second into an
 * immediate exit.
 *
 * The second one matters: stopping politely still means finishing the request
 * in flight and writing the journal, and somebody who has decided the sync
 * should end now should not have to wait for a slow API to answer.
 */
export function installStopHandler(options: {
  onStop: () => void;
  onSecond: () => void;
}): () => void {
  let asked = false;

  const handle = (): void => {
    if (asked) {
      options.onSecond();
      return;
    }
    asked = true;
    options.onStop();
  };

  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);

  return () => {
    process.off('SIGINT', handle);
    process.off('SIGTERM', handle);
  };
}
