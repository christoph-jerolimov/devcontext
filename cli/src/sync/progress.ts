import type { Logger } from '../util/logger.js';
import { formatDuration } from '../util/time.js';

export interface ProgressSnapshot {
  phase: string;
  /** `#4021, 5 of 231`, or empty when the phase is not walking a list. */
  position: string;
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
/** Where a phase has got to, when it is walking a list one item at a time. */
export interface ProgressPosition {
  /** The item's own name — `#4021`, `PLAT-7`. Omitted when it has none. */
  label?: string | undefined;
  /** One based, so the first item reads "1 of 231" rather than "0 of 231". */
  index: number;
  total: number;
}

/**
 * A loop index turned into the position a person reads.
 *
 * Zero based going in, one based coming out: the first item of a walk is being
 * fetched, not yet to be fetched, and "0 of 231" says the opposite. Shared by
 * both syncers so the two cannot disagree about it.
 */
export function positionOf(label: string, index: number, total: number): ProgressPosition {
  return { label, index: index + 1, total };
}

export class ProgressReporter {
  private phase = '';
  private position: ProgressPosition | null = null;
  private apiCalls = 0;
  private apiCallsExpected = 0;
  /** Per-slice expectations, set by the survey and revised by the syncers. */
  private readonly expectedByKey = new Map<string, number>();
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
      position: this.formatPosition(),
      apiCalls: this.apiCalls,
      apiCallsExpected: this.expectedApiCallCount,
      items: this.items,
      elapsedMs,
      etaMs: this.estimateEta(elapsedMs),
    };
  }

  get apiCallCount(): number {
    return this.apiCalls;
  }

  /**
   * Never below the calls already made: a survey that guessed low should stop
   * the bar at full rather than let it run past the end.
   */
  get expectedApiCallCount(): number {
    let total = this.apiCallsExpected;
    for (const count of this.expectedByKey.values()) total += count;
    return Math.max(total, this.apiCalls);
  }

  get itemCount(): number {
    return this.items;
  }

  /**
   * Starts a phase. Clears any position, because the old one belongs to the
   * list the previous phase was walking.
   */
  setPhase(phase: string): void {
    this.phase = phase;
    this.position = null;
    this.render(true);
  }

  /**
   * Says which item of the current list is being fetched.
   *
   * The percentage and the estimate already say how much is left overall, and
   * on a repository with two thousand pull requests they say it in a number
   * that barely moves for twenty minutes. This is the other half: something
   * that visibly ticks, and names the thing being waited on.
   *
   * Cheap by construction — `render` is throttled, and the string is only
   * built when a line is actually drawn.
   */
  setPosition(position: ProgressPosition | null): void {
    this.position = position;
    this.render();
  }

  /**
   * Adds `count` calls to the expectation.
   *
   * For work whose size only becomes apparent as it is discovered — the job
   * logs of a workflow run, say, where the job count is not known until the run
   * has been fetched. Anything a survey can size up front should use
   * `expectFor` instead, so the two do not both count it.
   */
  expect(count: number): void {
    if (count <= 0) return;
    this.apiCallsExpected += count;
    this.render();
  }

  /**
   * Sets the expectation for one named slice of the work, replacing whatever
   * that slice expected before.
   *
   * The survey seeds each slice before the sync starts, and the syncer revises
   * it with the real number once it knows. Because a slice is set rather than
   * added to, the two cannot double count, and a survey that guessed high or
   * low is corrected rather than compounded.
   */
  expectFor(key: string, count: number): void {
    const next = Math.max(0, count);
    if (this.expectedByKey.get(key) === next) return;
    this.expectedByKey.set(key, next);
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

  /** The same, at warning level, for something worth stopping to read. */
  warn(message: string): void {
    this.clearLine();
    this.options.logger.warn(message);
    this.render(true);
  }

  finish(summary?: string): void {
    this.clearLine();
    if (summary) this.options.logger.info(summary);
  }

  private estimateEta(elapsedMs: number): number | null {
    if (this.apiCalls === 0) return null;
    const remaining = this.expectedApiCallCount - this.apiCalls;
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
    if (this.phase) {
      const position = this.formatPosition();
      parts.push(position ? `${this.phase} (currently on ${position})` : this.phase);
    }
    return parts.join(' | ');
  }

  private formatPosition(): string {
    if (!this.position || this.position.total <= 0) return '';
    const { label, index, total } = this.position;
    const counted = `${String(index)} of ${String(total)}`;
    return label ? `${label}, ${counted}` : counted;
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
