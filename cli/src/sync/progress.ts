import type { Logger } from '../util/logger.js';
import { formatDuration } from '../util/time.js';

export interface ProgressSnapshot {
  phase: string;
  apiCalls: number;
  apiCallsExpected: number;
  items: number;
  elapsedMs: number;
  etaMs: number | null;
}

export interface ProgressOptions {
  enabled: boolean;
  logger: Logger;
  stream?: NodeJS.WriteStream;
  /** Minimum time between two redraws. */
  throttleMs?: number;
}

/**
 * Tracks how many API calls are done and how many are still expected.
 *
 * The expectation grows while the sync runs: after listing 120 issues the
 * issue syncer knows it needs two more calls per issue (comments + timeline)
 * and calls `expect(240)`, so the percentage stays honest instead of jumping
 * back and forth between phases.
 */
export class ProgressReporter {
  private phase = '';
  private apiCalls = 0;
  private apiCallsExpected = 0;
  private items = 0;
  private readonly startedAt = Date.now();
  private lastRenderAt = 0;
  private lastLineLength = 0;
  private readonly stream: NodeJS.WriteStream;
  private readonly throttleMs: number;
  private readonly interactive: boolean;

  constructor(private readonly options: ProgressOptions) {
    this.stream = options.stream ?? process.stderr;
    this.throttleMs = options.throttleMs ?? 120;
    this.interactive = Boolean(this.stream.isTTY) && !process.env.NO_COLOR;
  }

  get snapshot(): ProgressSnapshot {
    const elapsedMs = Date.now() - this.startedAt;
    return {
      phase: this.phase,
      apiCalls: this.apiCalls,
      apiCallsExpected: Math.max(this.apiCallsExpected, this.apiCalls),
      items: this.items,
      elapsedMs,
      etaMs: this.estimateEta(elapsedMs),
    };
  }

  get apiCallCount(): number {
    return this.apiCalls;
  }

  get expectedApiCallCount(): number {
    return Math.max(this.apiCallsExpected, this.apiCalls);
  }

  get itemCount(): number {
    return this.items;
  }

  setPhase(phase: string): void {
    this.phase = phase;
    this.render(true);
  }

  /** Adds `count` calls to the expectation as soon as they become predictable. */
  expect(count: number): void {
    if (count <= 0) return;
    this.apiCallsExpected += count;
    this.render();
  }

  recordApiCall(count = 1): void {
    this.apiCalls += count;
    this.render();
  }

  recordItems(count = 1): void {
    this.items += count;
    this.render();
  }

  /** Prints a message above the progress line without corrupting it. */
  log(message: string): void {
    this.clearLine();
    this.options.logger.info(message);
    this.render(true);
  }

  finish(summary?: string): void {
    this.clearLine();
    if (summary) this.options.logger.info(summary);
  }

  private estimateEta(elapsedMs: number): number | null {
    if (this.apiCalls === 0) return null;
    const expected = Math.max(this.apiCallsExpected, this.apiCalls);
    const remaining = expected - this.apiCalls;
    if (remaining <= 0) return 0;
    const perCall = elapsedMs / this.apiCalls;
    return Math.round(perCall * remaining);
  }

  private render(force = false): void {
    if (!this.options.enabled) return;
    const now = Date.now();
    if (!force && now - this.lastRenderAt < this.throttleMs) return;
    this.lastRenderAt = now;

    const line = this.formatLine();

    if (!this.interactive) {
      // Non TTY output would fill logs with thousands of lines; only report
      // whenever another 10% of the expected work is done.
      if (force || this.shouldLogMilestone()) this.options.logger.info(line);
      return;
    }

    this.stream.write(`\r${line.padEnd(this.lastLineLength, ' ')}`);
    this.lastLineLength = line.length;
  }

  private lastMilestone = -1;

  private shouldLogMilestone(): boolean {
    const expected = Math.max(this.apiCallsExpected, this.apiCalls);
    if (expected === 0) return false;
    const milestone = Math.floor((this.apiCalls / expected) * 10);
    if (milestone === this.lastMilestone) return false;
    this.lastMilestone = milestone;
    return true;
  }

  private formatLine(): string {
    const { apiCalls, apiCallsExpected, items, elapsedMs, etaMs } = this.snapshot;
    const ratio = apiCallsExpected > 0 ? Math.min(1, apiCalls / apiCallsExpected) : 0;
    const percent = Math.round(ratio * 100);
    const width = 24;
    const filled = Math.round(ratio * width);
    const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;

    const parts = [
      `[${bar}] ${String(percent).padStart(3)}%`,
      `${apiCalls}/${apiCallsExpected} calls`,
      `${items} items`,
      `${formatDuration(elapsedMs)} elapsed`,
    ];
    if (etaMs !== null && etaMs > 0) parts.push(`~${formatDuration(etaMs)} left`);
    if (this.phase) parts.push(this.phase);
    return parts.join(' | ');
  }

  private clearLine(): void {
    if (!this.options.enabled || !this.interactive) return;
    if (this.lastLineLength === 0) return;
    this.stream.write(`\r${' '.repeat(this.lastLineLength)}\r`);
    this.lastLineLength = 0;
  }
}

/** A reporter that does nothing, for `--no-progress` and tests. */
export function createNoopProgress(logger: Logger): ProgressReporter {
  return new ProgressReporter({ enabled: false, logger });
}
