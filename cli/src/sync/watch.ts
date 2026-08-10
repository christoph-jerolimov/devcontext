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
 * Pausing leans on machinery the sync already has for Ctrl-C: the abort
 * signal stops it politely at the next request, cursors only move when a
 * resource finishes, and `resume` skips what the interrupted run already got
 * through. Pause is therefore cheap and honest — nothing is lost, and
 * resuming does not repeat the hours that were already done.
 *
 * The sync itself is injectable so the tests can drive the scheduling with
 * fake timers and no network; `devcontext serve` hands in the real `runSync`.
 */

import { nowIso } from '../util/time.js';
import type { Logger } from '../util/logger.js';
import type { ProgressSnapshot } from './progress.js';

export type SyncReason = 'startup' | 'interval' | 'manual' | 'resume';

/** What a listener is told. `sync-completed` carries the outcome. */
export type SchedulerEvent =
  | { event: 'sync-started'; at: string; reason: SyncReason }
  | { event: 'sync-progress'; at: string; progress: ProgressSnapshot }
  | {
      event: 'sync-completed';
      at: string;
      status: 'completed' | 'failed' | 'interrupted';
      durationMs: number;
      error: string | null;
    }
  | { event: 'watch-paused'; at: string }
  | { event: 'watch-resumed'; at: string };

/** What the scheduler hands each run. */
export interface RunContext {
  /**
   * Reports how far the run has got. The scheduler forwards it to whoever is
   * listening and keeps the latest snapshot for anyone who asks in between —
   * a page opened two hours into a sync should not wait for the next event
   * to learn one is running.
   */
  report: (progress: ProgressSnapshot) => void;
  /** Fires when the run should stop at the next request (pause, shutdown). */
  signal: AbortSignal;
  /** True when the previous run was paused: skip what it already finished. */
  resume: boolean;
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
  private paused = false;
  /** True when a pause cut a run short; the next run picks up where it left off. */
  private resumeNext = false;
  private current: AbortController | null = null;
  private pauseAsked = false;
  private latestProgress: ProgressSnapshot | null = null;
  private readonly listeners = new Set<(event: SchedulerEvent) => void>();

  constructor(private readonly options: SchedulerOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
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
      if (this.running || this.paused) {
        // Running: the run in flight is already fetching what this tick
        // would have. Paused: the person said not now, and an interval is
        // not permission to overrule them.
        this.options.logger.debug('Skipping a scheduled sync.');
        return;
      }
      void this.runOnce('interval');
    }, this.options.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.current?.abort();
  }

  /**
   * Starts a sync now, for the "Sync now" button. Refused — not queued —
   * while one is running or while paused, so the caller can answer honestly.
   */
  trigger(): boolean {
    if (this.running || this.stopped || this.paused) return false;
    void this.runOnce('manual');
    return true;
  }

  /**
   * Stops the run in flight at its next request and holds the interval.
   *
   * The half-finished run is not wasted: cursors moved for every resource
   * that completed, and the journal knows which those were, so resuming
   * skips them instead of repeating them.
   */
  pause(): boolean {
    if (this.paused || this.stopped) return false;
    this.paused = true;
    if (this.running) {
      this.pauseAsked = true;
      this.resumeNext = true;
      this.current?.abort();
    }
    this.emit({ event: 'watch-paused', at: nowIso() });
    return true;
  }

  /**
   * Lifts the pause and, when a run was cut short by it, continues that run
   * now — with `resume`, so the hours already done stay done.
   */
  resume(): boolean {
    if (!this.paused || this.stopped) return false;
    this.paused = false;
    this.emit({ event: 'watch-resumed', at: nowIso() });
    if (this.resumeNext) {
      this.resumeNext = false;
      void this.runOnce('resume', true);
    }
    return true;
  }

  subscribe(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async runOnce(reason: SyncReason, resume = false): Promise<void> {
    this.running = true;
    this.pauseAsked = false;
    this.current = new AbortController();
    const startedAt = Date.now();
    this.emit({ event: 'sync-started', at: nowIso(), reason });

    const report = (progress: ProgressSnapshot): void => {
      this.latestProgress = progress;
      this.emit({ event: 'sync-progress', at: nowIso(), progress });
    };

    let error: string | null = null;
    try {
      await this.options.run({ report, signal: this.current.signal, resume });
    } catch (cause) {
      // A failed sync is an event, not the end of watching: the network comes
      // back, the token gets fixed, and the next interval tries again.
      error = cause instanceof Error ? cause.message : String(cause);
      if (!this.pauseAsked) this.options.logger.warn(`Background sync failed: ${error}`);
    } finally {
      this.running = false;
      this.current = null;
      // A finished run's last snapshot would otherwise read as a sync stuck
      // at 100% to anyone asking between runs.
      this.latestProgress = null;
    }

    this.emit({
      event: 'sync-completed',
      at: nowIso(),
      // A run cut short by pause is neither done nor broken, and calling it
      // either would mislead: "completed" hides that work remains,
      // "failed" sends somebody reading logs after an error that was a
      // button press.
      status: this.pauseAsked ? 'interrupted' : error === null ? 'completed' : 'failed',
      durationMs: Date.now() - startedAt,
      error: this.pauseAsked ? null : error,
    });
    this.pauseAsked = false;
  }
}
