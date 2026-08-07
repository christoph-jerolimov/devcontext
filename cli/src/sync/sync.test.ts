import { describe, expect, it } from 'vitest';

import { nullLogger } from '../util/logger.js';
import { ProgressReporter } from './progress.js';
import { RateLimiter } from './rateLimiter.js';

function createClock() {
  let now = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    nowFn: () => now,
    sleepFn: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('keeps the configured minimum delay between two calls', async () => {
    const clock = createClock();
    const limiter = new RateLimiter({
      minDelayMs: 250,
      respectRateLimit: true,
      reserve: 10,
      logger: nullLogger,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    await limiter.acquire();
    await limiter.acquire();
    expect(clock.waits).toEqual([250]);

    clock.advance(1000);
    await limiter.acquire();
    expect(clock.waits).toEqual([250]);
  });

  it('waits for the window reset once the remaining budget hits the reserve', async () => {
    const clock = createClock();
    const limiter = new RateLimiter({
      minDelayMs: 0,
      respectRateLimit: true,
      reserve: 10,
      logger: nullLogger,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    const resetSeconds = Math.floor(clock.nowFn() / 1000) + 60;
    limiter.observeHeaders(
      new Headers({
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '5',
        'x-ratelimit-reset': String(resetSeconds),
      }),
    );

    expect(limiter.state.remaining).toBe(5);
    await limiter.acquire();
    expect(clock.waits[0]).toBeGreaterThan(59_000);
  });

  it('does not wait while the remaining budget is healthy', async () => {
    const clock = createClock();
    const limiter = new RateLimiter({
      minDelayMs: 0,
      respectRateLimit: true,
      reserve: 10,
      logger: nullLogger,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    limiter.observeHeaders(
      new Headers({
        'x-ratelimit-remaining': '4000',
        'x-ratelimit-reset': String(Math.floor(clock.nowFn() / 1000) + 60),
      }),
    );
    await limiter.acquire();
    expect(clock.waits).toEqual([]);
  });

  it('honours Retry-After', () => {
    const clock = createClock();
    const limiter = new RateLimiter({
      minDelayMs: 0,
      respectRateLimit: true,
      reserve: 0,
      logger: nullLogger,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    expect(limiter.applyRetryAfter(new Headers({ 'retry-after': '30' }))).toBe(30_000);
    expect(limiter.applyRetryAfter(new Headers())).toBeNull();
  });

  it('ignores the rate limit headers when told to', async () => {
    const clock = createClock();
    const limiter = new RateLimiter({
      minDelayMs: 0,
      respectRateLimit: false,
      reserve: 100,
      logger: nullLogger,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    limiter.observeHeaders(
      new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(clock.nowFn() / 1000) + 600),
      }),
    );
    await limiter.acquire();
    expect(clock.waits).toEqual([]);
  });
});

describe('ProgressReporter', () => {
  it('counts calls and grows the expectation while the sync learns more', () => {
    const progress = new ProgressReporter({ enabled: false, logger: nullLogger });

    progress.expect(1);
    progress.recordApiCall();
    progress.recordItems(100);
    // 100 issues need two follow up calls each.
    progress.expect(200);

    const snapshot = progress.snapshot;
    expect(snapshot.apiCalls).toBe(1);
    expect(snapshot.apiCallsExpected).toBe(201);
    expect(snapshot.items).toBe(100);
    expect(snapshot.etaMs).not.toBeNull();
  });

  it('never reports fewer expected calls than were actually made', () => {
    const progress = new ProgressReporter({ enabled: false, logger: nullLogger });
    progress.expect(1);
    progress.recordApiCall(5);
    expect(progress.expectedApiCallCount).toBe(5);
  });
});
