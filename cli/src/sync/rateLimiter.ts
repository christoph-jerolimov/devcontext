import type { Logger } from '../util/logger.js';
import { formatDuration, sleep } from '../util/time.js';

export interface RateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  used: number | null;
}

export interface RateLimiterOptions {
  /** Minimum time between two requests. Set to 0 to go as fast as allowed. */
  minDelayMs: number;
  /** Whether the remote rate limit headers should be honoured. */
  respectRateLimit: boolean;
  /** Start waiting for the window reset once fewer than this many calls are left. */
  reserve: number;
  logger: Logger;
  /** Injection point for tests. */
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

/**
 * Serialises API calls: keeps a configurable pause between requests, waits out
 * `Retry-After` responses and stops before a rate limit window is exhausted.
 */
export class RateLimiter {
  private lastCallAt = 0;
  private pausedUntil = 0;
  private snapshot: RateLimitSnapshot = { limit: null, remaining: null, resetAt: null, used: null };
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;

  constructor(private readonly options: RateLimiterOptions) {
    this.sleepFn = options.sleepFn ?? sleep;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  get state(): RateLimitSnapshot {
    return { ...this.snapshot };
  }

  /** Waits until the next request may be sent. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = this.nowFn();

      if (this.pausedUntil > now) {
        const waitMs = this.pausedUntil - now;
        this.options.logger.info(
          `Rate limit reached, waiting ${formatDuration(waitMs)} for the window to reset.`,
        );
        await this.sleepFn(waitMs);
        continue;
      }

      const sinceLast = now - this.lastCallAt;
      if (this.options.minDelayMs > 0 && sinceLast < this.options.minDelayMs) {
        await this.sleepFn(this.options.minDelayMs - sinceLast);
        continue;
      }

      this.lastCallAt = this.nowFn();
      return;
    }
  }

  /** Feeds the rate limit headers of a response back into the limiter. */
  observeHeaders(headers: Headers): void {
    const limit = toNumber(headers.get('x-ratelimit-limit'));
    const remaining = toNumber(headers.get('x-ratelimit-remaining'));
    const used = toNumber(headers.get('x-ratelimit-used'));
    const resetSeconds = toNumber(headers.get('x-ratelimit-reset'));

    this.snapshot = {
      limit,
      remaining,
      used,
      resetAt: resetSeconds !== null ? new Date(resetSeconds * 1000).toISOString() : null,
    };

    if (!this.options.respectRateLimit) return;
    if (remaining === null || resetSeconds === null) return;

    if (remaining <= this.options.reserve) {
      const resetAtMs = resetSeconds * 1000;
      // +1s so the window has definitely rolled over when we continue.
      this.pauseUntil(resetAtMs + 1000);
    }
  }

  /** Honours `Retry-After` (seconds or HTTP date) from a 403/429 response. */
  applyRetryAfter(headers: Headers): number | null {
    const retryAfter = headers.get('retry-after');
    if (!retryAfter) return null;

    const seconds = Number(retryAfter);
    const untilMs = Number.isFinite(seconds)
      ? this.nowFn() + seconds * 1000
      : new Date(retryAfter).getTime();

    if (!Number.isFinite(untilMs)) return null;
    this.pauseUntil(untilMs);
    return Math.max(0, untilMs - this.nowFn());
  }

  pauseUntil(timestampMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, timestampMs);
  }

  /** Back off for a while after an unexpected server side throttle. */
  pauseFor(ms: number): void {
    this.pauseUntil(this.nowFn() + ms);
  }
}

function toNumber(value: string | null): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
