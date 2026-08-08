/**
 * Two questions the `status` dimension makes answerable.
 *
 * **Where is the work sitting** — a cumulative flow diagram: how many items
 * were in each status on each day. `state` only ever knew open and closed, so
 * a backlog of forty and a code review queue of forty looked identical, which
 * is the difference between a team that needs more reviewers and one that needs
 * fewer meetings.
 *
 * **How long it sits there** — the time an item spends in each status before
 * moving on. `insights cycle-time` already measures the whole journey from
 * in-progress to done; this is the same measurement per stop, which is what
 * says *which* stop is the slow one.
 *
 * Both read `state_changes` and nothing else. The current tables cannot answer
 * either: they know which status an item is in now, not which it was in on
 * Tuesday or how long it stayed.
 */

import type { Database } from '../db/database.js';
import { eachDay } from '../db/queries/history.js';
import { describe as describeValues } from './stats.js';
import type { Distribution } from './stats.js';

export interface FlowFilter {
  from?: string | undefined;
  to?: string | undefined;
  /** Jira project keys; all of them when omitted. */
  containers?: string[] | undefined;
  /** Only these statuses, in this order. Every status present when omitted. */
  statuses?: string[] | undefined;
  limit?: number | undefined;
}

export interface FlowDay {
  day: string;
  /** Items per status, keyed by status name. Absent statuses are simply zero. */
  counts: Record<string, number>;
  total: number;
}

export interface CumulativeFlow {
  kind: 'flow';
  from: string;
  to: string;
  /**
   * The statuses in board order — To Do, then In Progress, then Done.
   *
   * Ordered by category first because a flow diagram read out of order says
   * nothing: the whole point is watching a band swell before the one after it.
   * Within a category the busiest comes first, which is the best available
   * guess at a board nobody described to us.
   */
  statuses: Array<{ status: string; category: string | null }>;
  days: FlowDay[];
}

export interface StatusDuration {
  status: string;
  category: string | null;
  /** How many *completed* stays were measured, not how many items exist. */
  stays: number;
  hours: Distribution;
}

export interface StatusTimes {
  kind: 'status-time';
  statuses: StatusDuration[];
  /**
   * Stays that had not ended when the window did.
   *
   * Excluded from the numbers, and counted here instead: an item sitting in
   * review right now has been there for an unknown time, not a short one, and
   * averaging it in as "so far" quietly drags every median down.
   */
  ongoing: number;
}

interface Transition {
  ref: string;
  container: string;
  value: string;
  at: string;
  delta: number;
}

/**
 * Which category each status belongs to, learned from the items themselves.
 *
 * Jira reports the category on the item and never in the changelog, so a status
 * no item currently sits in has no known category here. That is a real gap and
 * not worth guessing at: such a status simply sorts after the ones that are
 * placed, rather than being put somewhere plausible and wrong.
 */
function categories(db: Database): Map<string, string | null> {
  const rows = db.all<{ status: string; status_category: string | null }>(
    `SELECT DISTINCT status, status_category FROM jira_workitems WHERE status IS NOT NULL`,
  );
  return new Map(rows.map((row) => [row.status, row.status_category]));
}

/** Board order: To Do, then In Progress, then Done, then anything unfamiliar. */
function categoryRank(category: string | null): number {
  switch ((category ?? '').toLowerCase()) {
    case 'to do':
    case 'new':
      return 0;
    case 'in progress':
    case 'indeterminate':
      return 1;
    case 'done':
    case 'complete':
      return 2;
    default:
      return 3;
  }
}

function transitions(db: Database, filter: FlowFilter): Transition[] {
  const params: string[] = [];
  let where = `WHERE source = 'jira' AND dimension = 'status'`;

  if (filter.containers?.length) {
    where += ` AND container IN (${filter.containers.map(() => '?').join(', ')})`;
    params.push(...filter.containers);
  }

  return db.all<Transition>(
    `SELECT ref, container, value, at, delta FROM state_changes ${where} ORDER BY at, seq`,
    params,
  );
}

export function cumulativeFlow(db: Database, filter: FlowFilter = {}): CumulativeFlow {
  const to = filter.to ?? new Date().toISOString();
  const from = filter.from ?? new Date(Date.parse(to) - 29 * 86_400_000).toISOString();
  const rows = transitions(db, filter);
  const category = categories(db);

  const wanted = filter.statuses?.length ? new Set(filter.statuses) : null;
  const present = new Set(rows.map((row) => row.value).filter((v) => !wanted || wanted.has(v)));

  // Busiest first within a category, so a board nobody described still reads
  // roughly left to right.
  const busyness = new Map<string, number>();
  for (const row of rows) busyness.set(row.value, (busyness.get(row.value) ?? 0) + 1);

  const statuses = [...present]
    .map((status) => ({ status, category: category.get(status) ?? null }))
    .toSorted(
      (a, b) =>
        categoryRank(a.category) - categoryRank(b.category) ||
        (busyness.get(b.status) ?? 0) - (busyness.get(a.status) ?? 0) ||
        a.status.localeCompare(b.status),
    );

  const days: FlowDay[] = eachDay(from, to).map((day) => {
    const endOfDay = `${day}T23:59:59.999Z`;
    const sums = new Map<string, number>();

    for (const row of rows) {
      if (row.at > endOfDay) break;
      const key = `${row.ref} ${row.value}`;
      sums.set(key, (sums.get(key) ?? 0) + row.delta);
    }

    const counts: Record<string, number> = {};
    let total = 0;
    for (const [key, sum] of sums) {
      if (sum <= 0) continue;
      const status = key.slice(key.indexOf(' ') + 1);
      if (wanted && !wanted.has(status)) continue;
      counts[status] = (counts[status] ?? 0) + 1;
      total += 1;
    }

    return { day, counts, total };
  });

  return { kind: 'flow', from, to, statuses, days };
}

/**
 * How long a stay in each status lasts.
 *
 * A stay is the span between an item entering a status and leaving it, which
 * the ±1 rows give directly. Reopened work produces several stays in the same
 * status, and all of them count — a ticket that went back to review twice
 * really did spend two stretches there.
 */
export function statusTimes(db: Database, filter: FlowFilter = {}): StatusTimes {
  const rows = transitions(db, filter);
  const category = categories(db);
  const from = filter.from ?? null;

  const openedAt = new Map<string, string>();
  const stays = new Map<string, number[]>();
  let ongoing = 0;

  for (const row of rows) {
    const key = `${row.ref} ${row.value}`;
    if (row.delta > 0) {
      openedAt.set(key, row.at);
      continue;
    }

    const started = openedAt.get(key);
    openedAt.delete(key);
    if (started === undefined) continue;
    // A stay that ended before the window began is not this window's business.
    if (from !== null && row.at < from) continue;

    const hours = (Date.parse(row.at) - Date.parse(started)) / 3_600_000;
    if (!Number.isFinite(hours) || hours < 0) continue;

    const list = stays.get(row.value);
    if (list) list.push(hours);
    else stays.set(row.value, [hours]);
  }

  // Whatever is still open at the end of the walk has no duration yet.
  ongoing = openedAt.size;

  const statuses: StatusDuration[] = [...stays]
    .map(([status, hours]) => ({
      status,
      category: category.get(status) ?? null,
      stays: hours.length,
      hours: describeValues(hours),
    }))
    .toSorted(
      (a, b) => (b.hours.p50 ?? 0) - (a.hours.p50 ?? 0) || a.status.localeCompare(b.status),
    );

  const limit = filter.limit && filter.limit > 0 ? filter.limit : statuses.length;
  return { kind: 'status-time', statuses: statuses.slice(0, limit), ongoing };
}
