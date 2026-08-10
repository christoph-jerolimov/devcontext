/**
 * The scheduling, not the syncing. The sync is injected as a controllable
 * promise so the clock can be driven; what is under test is the property the
 * database depends on: there is never more than one run in flight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nullLogger } from '../util/logger.js';
import type { ProgressSnapshot as SyncProgressSample } from './progress.js';
import { SyncScheduler } from './watch.js';
import type { SchedulerEvent } from './watch.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A run whose completion the test decides. */
function controllableRun(): {
  run: () => Promise<void>;
  finish: () => Promise<void>;
  calls: () => number;
} {
  let resolve: (() => void) | null = null;
  let calls = 0;
  return {
    run: () => {
      calls += 1;
      return new Promise<void>((r) => {
        resolve = r;
      });
    },
    finish: async () => {
      resolve?.();
      resolve = null;
      // Let the awaiting runOnce continue.
      await vi.advanceTimersByTimeAsync(0);
    },
    calls: () => calls,
  };
}

describe('the scheduler', () => {
  it('syncs immediately on start, then once per interval', async () => {
    const { run, finish, calls } = controllableRun();
    const scheduler = new SyncScheduler({ intervalMs: 60_000, logger: nullLogger, run });

    scheduler.start();
    expect(calls()).toBe(1);
    await finish();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);
    await finish();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(3);
    await finish();
    scheduler.stop();
  });

  it('skips a tick rather than starting a second run', async () => {
    const { run, finish, calls } = controllableRun();
    const scheduler = new SyncScheduler({ intervalMs: 60_000, logger: nullLogger, run });

    scheduler.start();
    expect(calls()).toBe(1);

    // Two whole intervals pass while the first run is still going: nothing
    // new may start, and nothing is owed afterwards either — the next tick
    // syncs strictly newer data than a queued one would have.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(1);

    await finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);
    await finish();
    scheduler.stop();
  });

  it('refuses a manual trigger while running, accepts one while idle', async () => {
    const { run, finish } = controllableRun();
    const scheduler = new SyncScheduler({ intervalMs: 60_000, logger: nullLogger, run });

    scheduler.start();
    expect(scheduler.trigger()).toBe(false); // startup run still in flight
    await finish();

    expect(scheduler.trigger()).toBe(true);
    expect(scheduler.isRunning).toBe(true);
    await finish();
    scheduler.stop();
  });

  it('reports a failed run and keeps watching', async () => {
    const events: SchedulerEvent[] = [];
    let attempts = 0;
    const scheduler = new SyncScheduler({
      intervalMs: 60_000,
      logger: nullLogger,
      run: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error('rate limited')) : Promise.resolve();
      },
    });
    scheduler.subscribe((event) => events.push(event));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    const failed = events.find((event) => event.event === 'sync-completed');
    expect(failed).toMatchObject({ status: 'failed', error: 'rate limited' });

    // The network comes back; the next interval succeeds.
    await vi.advanceTimersByTimeAsync(60_000);
    const outcomes = events.filter((event) => event.event === 'sync-completed');
    expect(outcomes.map((event) => event.status)).toEqual(['failed', 'completed']);
    scheduler.stop();
  });

  it('forwards progress while running and forgets it afterwards', async () => {
    /*
     * The snapshot is kept, not only forwarded, because most viewers arrive
     * in the middle: a page opened two hours into a sync asks /api/status
     * and must learn a run is going without waiting for the next event. And
     * it is dropped when the run ends, because a stale snapshot reads as a
     * sync stuck at 100%.
     */
    const events: SchedulerEvent[] = [];
    let report: ((snapshot: SyncProgressSample) => void) | null = null;
    let finish: (() => void) | null = null;
    const scheduler = new SyncScheduler({
      intervalMs: 60_000,
      logger: nullLogger,
      run: (ctx) => {
        report = ctx.report;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    scheduler.subscribe((event) => events.push(event));

    scheduler.start();
    const snapshot: SyncProgressSample = {
      phase: 'issues',
      position: '#42, 5 of 231',
      apiCalls: 50,
      apiCallsExpected: 200,
      items: 40,
      elapsedMs: 60_000,
      etaMs: 180_000,
    };
    report!(snapshot);

    expect(scheduler.progress).toEqual(snapshot);
    expect(events.at(-1)).toMatchObject({ event: 'sync-progress', progress: snapshot });

    finish!();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.progress).toBeNull();
    scheduler.stop();
  });

  it('does nothing after stop', async () => {
    const { run, finish, calls } = controllableRun();
    const scheduler = new SyncScheduler({ intervalMs: 60_000, logger: nullLogger, run });

    scheduler.start();
    await finish();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls()).toBe(1);
    expect(scheduler.trigger()).toBe(false);
  });
});
