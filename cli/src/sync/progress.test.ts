/**
 * The observer half of the reporter: the terminal bar has been proven by use,
 * but `onSnapshot` feeds the serve process and through it every connected
 * viewer, and its contract — throttled while running, exact at the end,
 * independent of whether a terminal bar is drawn at all — is what these pin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nullLogger } from '../util/logger.js';
import { ProgressReporter } from './progress.js';
import type { ProgressSnapshot } from './progress.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function reporterWith(snapshots: ProgressSnapshot[]): ProgressReporter {
  return new ProgressReporter({
    // The serve case: no terminal bar, but somebody is still watching.
    enabled: false,
    logger: nullLogger,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    snapshotThrottleMs: 1000,
  });
}

describe('observing progress', () => {
  it('reports without a terminal bar, throttled', () => {
    const snapshots: ProgressSnapshot[] = [];
    const reporter = reporterWith(snapshots);

    reporter.recordApiCall();
    // A burst of calls within the throttle window is one report, not fifty.
    for (let call = 0; call < 50; call += 1) reporter.recordApiCall();
    expect(snapshots).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    reporter.recordApiCall();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.apiCalls).toBe(52);
  });

  it('reports the final state on finish, throttle or not', () => {
    const snapshots: ProgressSnapshot[] = [];
    const reporter = reporterWith(snapshots);

    reporter.recordApiCall();
    reporter.recordItems(3);
    reporter.finish();

    const last = snapshots.at(-1);
    expect(last?.items).toBe(3);
  });

  it('carries what each API said about its budget', () => {
    const snapshots: ProgressSnapshot[] = [];
    const reporter = reporterWith(snapshots);

    reporter.setRateLimit('GitHub', { limit: 5000, remaining: 4321, resetAt: null });
    reporter.setRateLimit('Jira (acme)', { limit: null, remaining: 99, resetAt: null });
    reporter.finish();

    const last = snapshots.at(-1);
    expect(last?.rateLimits['GitHub']).toMatchObject({ limit: 5000, remaining: 4321 });
    expect(last?.rateLimits['Jira (acme)']).toMatchObject({ remaining: 99 });
    expect(last?.rateLimits['GitHub']?.observedAt).toBeTruthy();
  });

  it('a response without rate limit headers does not erase the numbers', () => {
    // A proxy that strips the headers is a missing observation, not a reset.
    const snapshots: ProgressSnapshot[] = [];
    const reporter = reporterWith(snapshots);

    reporter.setRateLimit('GitHub', { limit: 5000, remaining: 4321, resetAt: null });
    reporter.setRateLimit('GitHub', { limit: null, remaining: null, resetAt: null });
    reporter.finish();

    expect(snapshots.at(-1)?.rateLimits['GitHub']).toMatchObject({ remaining: 4321 });
  });

  it('carries the phase and the item being fetched', () => {
    const snapshots: ProgressSnapshot[] = [];
    const reporter = reporterWith(snapshots);

    reporter.setPhase('issues');
    reporter.setPosition({ label: '#42', index: 5, total: 231 });
    reporter.finish();

    const last = snapshots.at(-1);
    expect(last?.phase).toBe('issues');
    expect(last?.position).toBe('#42, 5 of 231');
  });
});
