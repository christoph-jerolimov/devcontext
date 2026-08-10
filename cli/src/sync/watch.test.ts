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

  it('pause stops the run in flight and reports it as interrupted, not failed', async () => {
    /*
     * The run honours the abort signal the way the real sync honours Ctrl-C:
     * it stops at the next request. Cut short by a button press it is
     * neither done nor broken — "interrupted", with no error, so nobody
     * reads a stack trace that was really a pause.
     */
    const events: SchedulerEvent[] = [];
    const scheduler = new SyncScheduler({
      intervalMs: 60_000,
      logger: nullLogger,
      run: (ctx) =>
        new Promise<void>((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('stopped')));
        }),
    });
    scheduler.subscribe((event) => events.push(event));

    scheduler.start();
    expect(scheduler.pause()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(events.map((event) => event.event)).toEqual([
      'sync-started',
      'watch-paused',
      'sync-completed',
    ]);
    expect(events.at(-1)).toMatchObject({ status: 'interrupted', error: null });
    expect(scheduler.isPaused).toBe(true);
    scheduler.stop();
  });

  it('holds the interval while paused and refuses triggers', async () => {
    const { run, finish, calls } = controllableRun();
    const scheduler = new SyncScheduler({ intervalMs: 60_000, logger: nullLogger, run });

    scheduler.start();
    await finish();
    scheduler.pause();

    // Paused means paused: the interval is not permission to overrule it.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls()).toBe(1);
    expect(scheduler.trigger()).toBe(false);
    scheduler.stop();
  });

  it('resume continues an interrupted run with the resume flag set', async () => {
    const seen: Array<{ resume: boolean }> = [];
    let abortable: AbortSignal | null = null;
    const scheduler = new SyncScheduler({
      intervalMs: 60_000,
      logger: nullLogger,
      run: (ctx) => {
        seen.push({ resume: ctx.resume });
        abortable = ctx.signal;
        return seen.length === 1
          ? new Promise<void>((_, reject) => {
              ctx.signal.addEventListener('abort', () => reject(new Error('stopped')));
            })
          : Promise.resolve();
      },
    });
    const events: SchedulerEvent[] = [];
    scheduler.subscribe((event) => events.push(event));

    scheduler.start();
    scheduler.pause();
    await vi.advanceTimersByTimeAsync(0);
    expect(abortable?.aborted).toBe(true);

    scheduler.resume();
    await vi.advanceTimersByTimeAsync(0);

    // The second run picks up where the first left off — the journal knows
    // which resources finished, and `resume` is what makes it skip them.
    expect(seen).toEqual([{ resume: false }, { resume: true }]);
    const started = events.filter((event) => event.event === 'sync-started');
    expect(started.at(-1)).toMatchObject({ reason: 'resume' });
    scheduler.stop();
  });

  it('resume after an idle pause lifts the hold without starting a run', async () => {
    const { run, finish, calls } = controllableRun();
    const scheduler = new SyncScheduler({ intervalMs: 60_000, logger: nullLogger, run });

    scheduler.start();
    await finish();
    scheduler.pause();
    scheduler.resume();
    // Nothing was interrupted, so nothing needs continuing — the next
    // interval is soon enough.
    expect(calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);
    await finish();
    scheduler.stop();
  });

  it('passes a targeted trigger through to the run, and says so in the event', async () => {
    const contexts: Array<{ only?: string[] }> = [];
    const events: SchedulerEvent[] = [];
    const scheduler = new SyncScheduler({
      intervalMs: 60_000,
      logger: nullLogger,
      run: (ctx) => {
        contexts.push(ctx.only ? { only: ctx.only } : {});
        return Promise.resolve();
      },
    });
    scheduler.subscribe((event) => events.push(event));

    expect(scheduler.trigger({ only: ['acme/platform#42'] })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(contexts).toEqual([{ only: ['acme/platform#42'] }]);
    expect(events[0]).toMatchObject({ event: 'sync-started', only: ['acme/platform#42'] });
  });

  it('a paused targeted run resumes as the same targeted run', async () => {
    /*
     * The pause remembers what the run was asked to do. Without that, the
     * resume of an interrupted one-item sync would quietly become a full
     * sync — hours of work nobody asked for, started by a resume button.
     */
    const contexts: Array<{ resume: boolean; only?: string[] }> = [];
    const scheduler = new SyncScheduler({
      intervalMs: 60_000,
      logger: nullLogger,
      run: (ctx) => {
        contexts.push({ resume: ctx.resume, ...(ctx.only ? { only: ctx.only } : {}) });
        return contexts.length === 1
          ? new Promise<void>((_, reject) => {
              ctx.signal.addEventListener('abort', () => reject(new Error('stopped')));
            })
          : Promise.resolve();
      },
    });

    scheduler.trigger({ only: ['PLAT-7'] });
    scheduler.pause();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.resume();
    await vi.advanceTimersByTimeAsync(0);

    expect(contexts).toEqual([
      { resume: false, only: ['PLAT-7'] },
      { resume: true, only: ['PLAT-7'] },
    ]);
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
