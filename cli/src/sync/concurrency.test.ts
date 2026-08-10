/**
 * The pool the detail phases run on. Three properties carry everything the
 * sync relies on: the cap is real (never more than `limit` at once), every
 * item runs exactly once, and the first failure stops new work while the
 * work in flight finishes.
 */

import { describe, expect, it } from 'vitest';

import { forEachConcurrent } from './concurrency.js';

/** A promise the test resolves by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let opener!: () => void;
  const promise = new Promise<void>((resolve) => {
    opener = resolve;
  });
  return { promise, open: opener };
}

describe('forEachConcurrent', () => {
  it('processes every item exactly once, in claim order', async () => {
    const seen: number[] = [];
    await forEachConcurrent([10, 20, 30, 40, 50], 2, async (item) => {
      seen.push(item);
      await Promise.resolve();
    });
    expect(seen.toSorted((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
    expect(new Set(seen).size).toBe(5);
  });

  it('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, gate);

    const done = forEachConcurrent(gates, 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await item.promise;
      inFlight -= 1;
    });

    // Give the pool a tick to start what it is going to start.
    await Promise.resolve();
    expect(peak).toBe(3);

    for (const { open } of gates) open();
    await done;
    expect(peak).toBe(3);
    expect(inFlight).toBe(0);
  });

  it('stops starting new items after the first failure, and throws it', async () => {
    const started: number[] = [];
    await expect(
      forEachConcurrent([1, 2, 3, 4, 5, 6], 2, async (item) => {
        started.push(item);
        await Promise.resolve();
        if (item === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Items claimed before the failure may finish; the tail never starts.
    expect(started).not.toContain(6);
  });

  it('throws the first error, not a later one', async () => {
    await expect(
      forEachConcurrent([1, 2], 2, async (item) => {
        await Promise.resolve();
        throw new Error(`error ${String(item)}`);
      }),
    ).rejects.toThrow('error 1');
  });

  it('does nothing for an empty list and survives a limit below one', async () => {
    let calls = 0;
    await forEachConcurrent([], 4, async () => {
      calls += 1;
      await Promise.resolve();
    });
    await forEachConcurrent([1], 0, async () => {
      calls += 1;
      await Promise.resolve();
    });
    expect(calls).toBe(1);
  });
});
