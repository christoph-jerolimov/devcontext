/**
 * The background half of `devcontext serve --watch`: run a sync, wait, run
 * another, and tell whoever is listening.
 *
 * The scheduler is deliberately not a daemon framework. One process, one
 * writer, one timer. Overlap is the only real hazard — a sync that outlasts
 * the interval must not be joined by a second one writing to the same
 * database — so a tick that lands while a run is in flight is skipped rather
 * than queued: the next tick syncs strictly newer data anyway, and a queue
 * would only remember work that time has already made redundant.
 *
 * The sync itself is injectable so the tests can drive the scheduling with
 * fake timers and no network; `devcontext serve` hands in the real `runSync`.
 */

import { nowIso } from '../util/time.js';
import type { Logger } from '../util/logger.js';

/** What a listener is told. `sync-completed` carries the outcome. */
export type SchedulerEvent =
  | { event: 'sync-started'; at: string; reason: 'startup' | 'interval' | 'manual' }
  | {
      event: 'sync-completed';
      at: string;
      status: 'completed' | 'failed';
      durationMs: number;
      error: string | null;
    };

export interface SchedulerOptions {
  intervalMs: number;
  logger: Logger;
  /** Runs one sync. Rejections are reported as a failed run, not a crash. */
  run: () => Promise<unknown>;
}

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly listeners = new Set<(event: SchedulerEvent) => void>();

  constructor(private readonly options: SchedulerOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Syncs once right away, then on every interval. */
  start(): void {
    if (this.timer !== null || this.stopped) return;
    void this.runOnce('startup');
    this.timer = setInterval(() => {
      if (this.running) {
        // The run in flight is already fetching what this tick would have.
        this.options.logger.debug('Skipping a scheduled sync; the previous one is still running.');
        return;
      }
      void this.runOnce('interval');
    }, this.options.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Starts a sync now, for the "Sync now" button. Refused — not queued —
   * while one is running, so the caller can answer 409 honestly.
   */
  trigger(): boolean {
    if (this.running || this.stopped) return false;
    void this.runOnce('manual');
    return true;
  }

  subscribe(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async runOnce(reason: 'startup' | 'interval' | 'manual'): Promise<void> {
    this.running = true;
    const startedAt = Date.now();
    this.emit({ event: 'sync-started', at: nowIso(), reason });

    let error: string | null = null;
    try {
      await this.options.run();
    } catch (cause) {
      // A failed sync is an event, not the end of watching: the network comes
      // back, the token gets fixed, and the next interval tries again.
      error = cause instanceof Error ? cause.message : String(cause);
      this.options.logger.warn(`Background sync failed: ${error}`);
    } finally {
      this.running = false;
    }

    this.emit({
      event: 'sync-completed',
      at: nowIso(),
      status: error === null ? 'completed' : 'failed',
      durationMs: Date.now() - startedAt,
      error,
    });
  }
}
