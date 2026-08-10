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
import type { ProgressSnapshot } from './progress.js';

/** What a listener is told. `sync-completed` carries the outcome. */
export type SchedulerEvent =
  | { event: 'sync-started'; at: string; reason: 'startup' | 'interval' | 'manual' }
  | { event: 'sync-progress'; at: string; progress: ProgressSnapshot }
  | {
      event: 'sync-completed';
      at: string;
      status: 'completed' | 'failed';
      durationMs: number;
      error: string | null;
    };

/** What the scheduler hands each run. */
export interface RunContext {
  /**
   * Reports how far the run has got. The scheduler forwards it to whoever is
   * listening and keeps the latest snapshot for anyone who asks in between —
   * a page opened two hours into a sync should not wait for the next event
   * to learn one is running.
   */
  report: (progress: ProgressSnapshot) => void;
}

export interface SchedulerOptions {
  intervalMs: number;
  logger: Logger;
  /** Runs one sync. Rejections are reported as a failed run, not a crash. */
  run: (ctx: RunContext) => Promise<unknown>;
}

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private latestProgress: ProgressSnapshot | null = null;
  private readonly listeners = new Set<(event: SchedulerEvent) => void>();

  constructor(private readonly options: SchedulerOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Where the current run has got to; null between runs. */
  get progress(): ProgressSnapshot | null {
    return this.latestProgress;
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

    const report = (progress: ProgressSnapshot): void => {
      this.latestProgress = progress;
      this.emit({ event: 'sync-progress', at: nowIso(), progress });
    };

    let error: string | null = null;
    try {
      await this.options.run({ report });
    } catch (cause) {
      // A failed sync is an event, not the end of watching: the network comes
      // back, the token gets fixed, and the next interval tries again.
      error = cause instanceof Error ? cause.message : String(cause);
      this.options.logger.warn(`Background sync failed: ${error}`);
    } finally {
      this.running = false;
      // A finished run's last snapshot would otherwise read as a sync stuck
      // at 100% to anyone asking between runs.
      this.latestProgress = null;
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
