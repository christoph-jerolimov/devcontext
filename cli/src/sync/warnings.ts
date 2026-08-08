/**
 * Telling somebody a sync is going to be enormous, before it is.
 *
 * The survey already asks both APIs how big every collection is, and until now
 * it used the answer only to size the progress bar. But the number that makes a
 * good estimate also makes a good warning: a repository with forty thousand
 * pull requests is not a slow sync, it is a different decision, and the moment
 * to make it is before the first request rather than an hour in.
 *
 * Deliberately a warning and not an error. It is somebody's repository and
 * their disk; the sync goes ahead. What it buys is that nobody discovers the
 * scale by watching a progress bar crawl.
 */

import type { ProgressReporter } from './progress.js';

/**
 * Where "this is a lot" starts.
 *
 * Round, and round on purpose: the point is to be noticed, and a threshold
 * derived from call counts or wall clock would move with the configuration and
 * make the warning unpredictable. Ten thousand items is roughly the scale at
 * which a sync stops being something you wait for.
 */
export const LARGE_COLLECTION = 10_000;

export interface LargeCollection {
  /** `acme/platform` or `PLAT`. */
  target: string;
  /** `pull requests`, `issues`, `workflow runs`, `work items`. */
  resource: string;
  count: number;
  /** What to do about it, in the words of the configuration. */
  hint: string;
}

/** `24318` reads as a typo; `24,318` reads as a number. */
function grouped(count: number): string {
  return count.toLocaleString('en-US');
}

export function describeLargeCollection(found: LargeCollection): string {
  return (
    `${found.target} has ${grouped(found.count)} ${found.resource}. ` +
    `The first sync will fetch all of them and may take a long time. ${found.hint}`
  );
}

/**
 * Warns when a collection is larger than `LARGE_COLLECTION`, and says nothing
 * at all otherwise.
 *
 * Routed through the progress reporter rather than the logger directly: a line
 * written straight to stderr lands in the middle of the progress bar and
 * corrupts it.
 */
export function warnIfLarge(progress: ProgressReporter, found: LargeCollection): boolean {
  if (found.count <= LARGE_COLLECTION) return false;
  progress.warn(describeLargeCollection(found));
  return true;
}

/** The hints, in one place, so two syncers cannot word the same advice differently. */
export const BOUND_BY_SINCE = 'Bound it with `since` to fetch only recent history.';
export const BOUND_BY_RUNS =
  'Bound it with `maxWorkflowRuns`, or with `since`, to fetch only recent runs.';
export const BOUND_BY_FILTER = 'Bound it with `since`, or narrow the project `filter`.';
