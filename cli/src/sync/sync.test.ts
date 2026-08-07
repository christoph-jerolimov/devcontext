import { describe, expect, it } from 'vitest';

import { parseConfig } from '../config/load.js';
import { nullLogger } from '../util/logger.js';
import { parseReference } from './runner.js';
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

  it('fails instead of waiting out a window that is longer than the ceiling', async () => {
    const clock = createClock();
    const limiter = new RateLimiter({
      minDelayMs: 0,
      respectRateLimit: true,
      reserve: 10,
      maxWaitMs: 60_000,
      logger: nullLogger,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    limiter.observeHeaders(
      new Headers({
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '0',
        // Unauthenticated GitHub: the window is a full hour away.
        'x-ratelimit-reset': String(Math.floor(clock.nowFn() / 1000) + 3600),
      }),
    );

    await expect(limiter.acquire()).rejects.toThrow(/Rate limit reached/);
    expect(clock.waits).toEqual([]);
  });

  it('still waits when the window is within the ceiling', async () => {
    const clock = createClock();
    const limiter = new RateLimiter({
      minDelayMs: 0,
      respectRateLimit: true,
      reserve: 10,
      maxWaitMs: 600_000,
      logger: nullLogger,
      sleepFn: clock.sleepFn,
      nowFn: clock.nowFn,
    });

    limiter.observeHeaders(
      new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(clock.nowFn() / 1000) + 60),
      }),
    );

    await limiter.acquire();
    expect(clock.waits[0]).toBeGreaterThan(59_000);
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

describe('parseReference', () => {
  const projects = parseConfig(
    `
jira:
  sites:
    - name: acme
      baseUrl: https://acme.atlassian.net
      token: x
projects:
  - key: demo
    github:
      - repo: acme/platform
    jira:
      - project: PLAT
`,
    { configPath: '/workspace/devcontext.yaml' },
  ).projects;

  const twoRepos = parseConfig(
    `
projects:
  - key: demo
    github:
      - repo: acme/platform
      - repo: acme/docs
`,
    { configPath: '/workspace/devcontext.yaml' },
  ).projects;

  it('understands a qualified GitHub reference', () => {
    const parsed = parseReference('acme/platform#42', projects);
    expect(parsed.kind).toBe('github');
    expect(parsed.kind === 'github' && parsed.number).toBe(42);
  });

  it('understands a bare number when a single repository is configured', () => {
    expect(parseReference('42', projects).kind).toBe('github');
    expect(parseReference('#42', projects).kind).toBe('github');
  });

  it('refuses a bare number when it would be ambiguous', () => {
    expect(() => parseReference('42', twoRepos)).toThrow(/ambiguous/);
  });

  it('understands a Jira key, case insensitively', () => {
    const parsed = parseReference('plat-42', projects);
    expect(parsed.kind).toBe('jira');
    expect(parsed.kind === 'jira' && parsed.key).toBe('PLAT-42');
  });

  it('rejects references outside the configuration', () => {
    expect(() => parseReference('other/repo#1', projects)).toThrow(/No GitHub repository/);
    expect(() => parseReference('NOPE-1', projects)).toThrow(/No Jira project/);
    expect(() => parseReference('nonsense', projects)).toThrow(/Cannot understand/);
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

  it('replaces a named slice instead of adding to it', () => {
    /*
     * The whole point of the named form. The survey sizes a slice before the
     * sync starts and the syncer revises it once it knows the real number; if
     * that were additive, every revision would count the same work again and
     * the total would run away.
     */
    const progress = new ProgressReporter({ enabled: false, logger: nullLogger });

    progress.expectFor('repo:issues', 200);
    expect(progress.expectedApiCallCount).toBe(200);

    progress.expectFor('repo:issues', 180);
    expect(progress.expectedApiCallCount).toBe(180);

    progress.expectFor('repo:issues', 180);
    expect(progress.expectedApiCallCount).toBe(180);
  });

  it('adds up separate slices, and the unnamed expectation on top', () => {
    const progress = new ProgressReporter({ enabled: false, logger: nullLogger });

    progress.expectFor('repo:issues', 200);
    progress.expectFor('repo:pull_requests', 50);
    // Work whose size only the walk can reveal stays additive.
    progress.expect(7);

    expect(progress.expectedApiCallCount).toBe(257);
  });
});
