/**
 * The last rate limit numbers each API reported, kept with the data.
 *
 * The limiter's knowledge dies with the sync process, but the question "how
 * much budget is left" outlives it — the status command, the TUI's status
 * line and the web viewer all want an answer between runs. So the runner
 * writes the final observation into `meta`, and everything reads it from
 * there: one storage, three front ends, no way to disagree.
 *
 * The numbers age, which is why each entry carries `observedAt`: a reader can
 * say "as of five minutes ago" instead of presenting an hour-old snapshot as
 * the current truth — and once `resetAt` has passed, the window has rolled
 * over and the budget is full again regardless of what was stored.
 */

import type { Database } from '../db/database.js';
import { parseJsonColumn } from '../db/database.js';
import type { RateLimitState } from './progress.js';

const META_KEY = 'rate_limits';

/** Merges the run's observations over what earlier runs stored. */
export function persistRateLimits(db: Database, rateLimits: Record<string, RateLimitState>): void {
  const observed = Object.entries(rateLimits).filter(([, state]) => state.remaining !== null);
  if (observed.length === 0) return;

  // Merged, not replaced: a GitHub-only run must not erase what the last
  // run learned about Jira.
  const merged = { ...readRateLimits(db), ...Object.fromEntries(observed) };
  db.setMeta(META_KEY, JSON.stringify(merged));
}

export function readRateLimits(db: Database): Record<string, RateLimitState> {
  return parseJsonColumn<Record<string, RateLimitState>>(db.getMeta(META_KEY), {});
}
