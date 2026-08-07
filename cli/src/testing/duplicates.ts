/**
 * Test helper: find timeline events that were stored twice.
 *
 * Only `gh_events` needs this. Every other synced table is keyed on the id the
 * API gives it, so SQLite's primary key already makes a duplicate impossible —
 * asserting on it would be a tautology, not a test.
 *
 * `gh_events` is different: the timeline returns entries with no id of their
 * own, so `mapTimelineEvent` synthesises one from the issue, the event type,
 * the timestamp and **the position in the list**. That last part is the risk.
 * If a later sync returns the same timeline in a different order, or with an
 * entry inserted earlier, the position shifts, the synthesised key changes,
 * and the very same event is inserted a second time instead of updating the
 * first. Nothing in the schema can catch that — the two rows have different
 * keys. So the check has to be on what the event *is*, not on what it is
 * keyed by.
 */
import type { Database } from '../db/database.js';

/**
 * The identity of an event as a human would judge it: the same issue, the same
 * kind of event, by the same actor, about the same label or assignee, at the
 * same instant. Two rows matching on all of that are the same event twice.
 *
 * `created_at` is what makes this safe. A label really can be added, removed
 * and added again, and those are three genuine events — but they cannot share
 * a timestamp.
 */
const IDENTITY = 'host, issue_id, event, actor, created_at, label, assignee';

export interface DuplicateEvent {
  issue_id: number;
  event: string;
  created_at: string | null;
  copies: number;
}

/**
 * Timeline events stored more than once. Empty when all is well, so it can be
 * compared with `[]` directly.
 *
 * Rows with no timestamp are skipped rather than guessed at: without one there
 * is no way to tell a repeated event from a duplicated one, and a check that
 * cannot tell should not be the thing that fails a build.
 */
export function duplicateEvents(db: Database): DuplicateEvent[] {
  return db.all<DuplicateEvent>(
    `SELECT issue_id, event, created_at, COUNT(*) AS copies
       FROM gh_events
      WHERE created_at IS NOT NULL
      GROUP BY ${IDENTITY}
     HAVING COUNT(*) > 1
      ORDER BY issue_id, created_at`,
  );
}
