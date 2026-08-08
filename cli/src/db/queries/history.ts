/**
 * Reading the `state_changes` table.
 *
 * Every question here is the same shape: sum the deltas up to a moment, keep
 * the items whose sum is positive, count them. Two dimensions intersect by
 * doing that twice and joining on the item, which is why the table stores one
 * row per transition rather than one row per state.
 */

import type { Database } from '../database.js';

export interface HistoryFilters {
  /** `github` or `jira`; both when omitted. */
  source?: string;
  /** Repository full name or Jira project key. */
  container?: string;
  kind?: string;
  /** Only items assigned to this person at the moment being counted. */
  assignee?: string;
  /** Only items in this sprint at the moment being counted. */
  sprint?: string;
}

export interface OpenOnDay {
  day: string;
  open: number;
  opened: number;
  closed: number;
}

interface Clause {
  sql: string;
  params: string[];
}

function scope(filters: HistoryFilters): Clause {
  const sql: string[] = [];
  const params: string[] = [];
  if (filters.source) {
    sql.push('AND source = ?');
    params.push(filters.source);
  }
  if (filters.container) {
    sql.push('AND container = ?');
    params.push(filters.container);
  }
  if (filters.kind) {
    sql.push('AND kind = ?');
    params.push(filters.kind);
  }
  return { sql: sql.join(' '), params };
}

/**
 * An item is in a dimension at time T when its deltas up to T sum above zero.
 *
 * Written as a correlated EXISTS rather than a join so the caller can add as
 * many of these as it likes without the row count multiplying.
 */
function memberAt(dimension: string, value: string, at: string): Clause {
  return {
    sql: `AND (SELECT COALESCE(SUM(delta), 0) FROM state_changes m
                WHERE m.source = c.source AND m.ref = c.ref
                  AND m.dimension = ? AND m.value = ? AND m.at <= ?) > 0`,
    params: [dimension, value, at],
  };
}

/**
 * How many items were open at the end of each day in the window, and how many
 * crossed in or out on that day.
 *
 * The running total is deliberately not derived from `opened - closed` inside
 * the window: an item opened before the window still counts, and that balance
 * is the whole reason the table exists.
 */
export function openByDay(
  db: Database,
  options: { from: string; to: string } & HistoryFilters,
): OpenOnDay[] {
  const where = scope(options);
  const days = eachDay(options.from, options.to);
  const out: OpenOnDay[] = [];

  for (const day of days) {
    const endOfDay = `${day}T23:59:59.999Z`;
    const startOfDay = `${day}T00:00:00.000Z`;

    const extra: Clause[] = [];
    if (options.assignee) extra.push(memberAt('assignee', options.assignee, endOfDay));
    if (options.sprint) extra.push(memberAt('sprint', options.sprint, endOfDay));

    const openRow = db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM (
         SELECT c.source, c.ref FROM state_changes c
          WHERE c.dimension = 'state' AND c.value = 'open' AND c.at <= ?
                ${where.sql}
                ${extra.map((clause) => clause.sql).join(' ')}
          GROUP BY c.source, c.ref
         HAVING SUM(c.delta) > 0
       )`,
      [endOfDay, ...where.params, ...extra.flatMap((clause) => clause.params)],
    );

    const moved = db.get<{ opened: number; closed: number }>(
      `SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN 1 ELSE 0 END), 0) AS opened,
              COALESCE(SUM(CASE WHEN delta < 0 THEN 1 ELSE 0 END), 0) AS closed
         FROM state_changes c
        WHERE c.dimension = 'state' AND c.value = 'open'
          AND c.at >= ? AND c.at <= ? ${where.sql}`,
      [startOfDay, endOfDay, ...where.params],
    );

    out.push({
      day,
      open: openRow?.total ?? 0,
      opened: moved?.opened ?? 0,
      closed: moved?.closed ?? 0,
    });
  }

  return out;
}

/** How many open items each person held at a moment. */
export function openByAssignee(
  db: Database,
  options: { at: string } & HistoryFilters,
): Array<{ assignee: string; open: number }> {
  const where = scope(options);
  return db.all<{ assignee: string; open: number }>(
    `SELECT a.value AS assignee, COUNT(*) AS open FROM (
       SELECT c.source, c.ref, c.value FROM state_changes c
        WHERE c.dimension = 'assignee' AND c.at <= ? ${where.sql}
        GROUP BY c.source, c.ref, c.value
       HAVING SUM(c.delta) > 0
     ) a
     JOIN (
       SELECT c.source, c.ref FROM state_changes c
        WHERE c.dimension = 'state' AND c.value = 'open' AND c.at <= ? ${where.sql}
        GROUP BY c.source, c.ref
       HAVING SUM(c.delta) > 0
     ) o ON o.source = a.source AND o.ref = a.ref
     GROUP BY a.value
     ORDER BY open DESC, assignee`,
    [options.at, ...where.params, options.at, ...where.params],
  );
}

/** The days from `from` to `to` inclusive, as `YYYY-MM-DD`. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const end = new Date(`${to.slice(0, 10)}T00:00:00.000Z`).getTime();
  let cursor = new Date(`${from.slice(0, 10)}T00:00:00.000Z`).getTime();
  if (Number.isNaN(cursor) || Number.isNaN(end)) return days;

  // A sanity bound rather than a limit anyone should hit: ten years of days.
  for (let guard = 0; cursor <= end && guard < 3700; guard += 1) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return days;
}
