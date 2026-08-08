/**
 * Sprint reports read off the state history.
 *
 * `sprintReport` in this package answers what a sprint looks like *now*: how
 * many items it holds, how many are done, who has what. That is the question
 * the current tables can answer, and it is not the question anybody asks
 * during a sprint. "Are we going to finish" needs the shape the sprint took
 * getting here, and the shape is not in the current tables — an item finished
 * on day two and one finished an hour ago are the same row.
 *
 * `state_changes` is where that shape lives. Two of its dimensions are all
 * this module needs:
 *
 * - `sprint` — one ±1 row each time an item joins or leaves a sprint, so the
 *   membership at any instant is a prefix sum. This is what makes scope change
 *   visible rather than inferred, and it is the half a burndown drawn from the
 *   current membership silently gets wrong: an item pulled in on day eight is
 *   drawn as if it had been there since day one, and the line that should have
 *   jumped upwards instead looks like a team that simply stopped finishing
 *   things.
 * - `state` / `open` — the same shape for whether the item was still somebody's
 *   problem.
 *
 * Both series are replayed here rather than queried per day. A fortnight of
 * per-day queries is 28 round trips to answer something two ordered scans
 * already contain, and the replay is the same prefix sum either way.
 */

import type { Database } from '../db/database.js';
import { eachDay } from '../db/queries/history.js';

export interface SprintMeta {
  id: number;
  name: string | null;
  state: string | null;
  startDate: string | null;
  endDate: string | null;
  completeDate: string | null;
  goal: string | null;
}

export interface BurndownDay {
  day: string;
  /** Items in the sprint at the end of this day, done or not. */
  inSprint: number;
  /** Of those, still open. The line that is supposed to fall. */
  remaining: number;
  done: number;
  remainingPoints: number;
  donePoints: number;
  /** Items that joined or left the sprint on this day. */
  added: number;
  removed: number;
  /** Where an evenly burning sprint would be; null outside the sprint dates. */
  ideal: number | null;
  idealPoints: number | null;
  /**
   * False once the day is in the future.
   *
   * A sprint with three days left has three days of ideal line and no actual
   * one. Drawing zero there would say the work is finished; drawing the last
   * known value would say nothing changed. Neither is true, so the actual
   * series stops and says so.
   */
  actual: boolean;
}

export interface ScopeChange {
  key: string;
  at: string;
  direction: 'added' | 'removed';
  points: number;
}

export interface SprintBurndown {
  kind: 'burndown';
  sprint: SprintMeta;
  /** In the sprint at the instant it started. */
  committed: { items: number; points: number };
  /** In it at the end (or now, for a sprint still running). */
  finalScope: { items: number; points: number };
  completed: { items: number; points: number };
  /** Joined or left after the start — the two numbers a burndown alone hides. */
  scope: { added: number; removed: number; changes: ScopeChange[] };
  days: BurndownDay[];
  /**
   * True when story points were found on at least one item.
   *
   * A points burndown of a team that does not estimate is a flat line at zero,
   * which reads as a bug rather than as a choice they made.
   */
  hasPoints: boolean;
  /**
   * True when the estimates come from the history rather than from today.
   *
   * False only on a database written before the `points` dimension existed and
   * not yet rebuilt. The next sync rebuilds it; `history --rebuild` does it now.
   */
  pointsAreHistorical: boolean;
}

export interface VelocitySprint {
  id: number;
  name: string | null;
  state: string | null;
  startDate: string | null;
  endDate: string | null;
  committed: { items: number; points: number };
  completed: { items: number; points: number };
  added: number;
  removed: number;
  /** Completed over committed, or null when nothing was committed. */
  ratio: number | null;
}

export interface Velocity {
  kind: 'velocity';
  sprints: VelocitySprint[];
  /** Mean completed items and points over the sprints listed. */
  average: { items: number; points: number };
  hasPoints: boolean;
  /** See `SprintBurndown.pointsAreHistorical`. */
  pointsAreHistorical: boolean;
}

interface Transition {
  ref: string;
  at: string;
  delta: number;
}

/** Every ±1 row of one series, in order. */
function transitions(db: Database, dimension: string, value: string): Transition[] {
  return db.all<Transition>(
    `SELECT ref, at, delta FROM state_changes
      WHERE source = 'jira' AND dimension = ? AND value = ?
      ORDER BY at, seq`,
    [dimension, value],
  );
}

/**
 * The refs whose prefix sum is above zero at `at`.
 *
 * One pass per instant over an already ordered list. Callers walk instants
 * forwards, so this is linear overall in practice; written independently
 * because the committed and completed figures ask about instants that are not
 * on the daily grid.
 */
function membersAt(rows: readonly Transition[], at: string): Set<string> {
  const sums = new Map<string, number>();
  for (const row of rows) {
    if (row.at > at) break;
    sums.set(row.ref, (sums.get(row.ref) ?? 0) + row.delta);
  }
  const members = new Set<string>();
  for (const [ref, sum] of sums) if (sum > 0) members.add(ref);
  return members;
}

function sprintMeta(db: Database, sprintId: number): SprintMeta | null {
  const row = db.get<{
    id: number;
    name: string | null;
    state: string | null;
    start_date: string | null;
    end_date: string | null;
    complete_date: string | null;
    goal: string | null;
  }>(
    `SELECT id, name, state, start_date, end_date, complete_date, goal
       FROM jira_sprints WHERE id = ?`,
    [sprintId],
  );
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    startDate: row.start_date,
    endDate: row.end_date,
    completeDate: row.complete_date,
    goal: row.goal,
  };
}

/** One ±1 row of the points dimension: which estimate an item held, and when. */
interface PointsTransition {
  ref: string;
  value: string;
  at: string;
  delta: number;
}

/**
 * Every estimate change, or nothing when the history has none.
 *
 * `points` is a dimension like the others — an item is a member of exactly one
 * estimate at a time — so what an item was worth on a given day is the same
 * prefix sum every other figure here is.
 */
function pointsHistory(db: Database): PointsTransition[] {
  return db.all<PointsTransition>(
    `SELECT ref, value, at, delta FROM state_changes
      WHERE source = 'jira' AND dimension = 'points'
      ORDER BY at, seq`,
  );
}

/** Today's estimates, for a database whose history has not been rebuilt yet. */
function currentPoints(db: Database): Map<string, number> {
  const rows = db.all<{ key: string; story_points: number | null }>(
    'SELECT key, story_points FROM jira_workitems WHERE story_points IS NOT NULL',
  );
  return new Map(rows.map((row) => [row.key, row.story_points ?? 0]));
}

/**
 * What each item was estimated at, at one instant.
 *
 * Falls back to today's estimates when the history has no points rows at all,
 * which is a database written before the dimension existed and not yet rebuilt.
 * The alternative is a burndown of zeroes, and a wrong number told confidently
 * is worse than an old one told plainly — so the report carries
 * `pointsAreHistorical: false` and every surface says which it got.
 */
class Points {
  private readonly fallback: Map<string, number>;

  constructor(
    private readonly rows: readonly PointsTransition[],
    fallback: Map<string, number>,
  ) {
    this.fallback = fallback;
  }

  static from(db: Database): Points {
    return new Points(pointsHistory(db), currentPoints(db));
  }

  get historical(): boolean {
    return this.rows.length > 0;
  }

  /** Whether anything at all carries an estimate. */
  get any(): boolean {
    return this.rows.length > 0 || this.fallback.size > 0;
  }

  at(refs: Iterable<string>, when: string): number {
    if (!this.historical) {
      let total = 0;
      for (const ref of refs) total += this.fallback.get(ref) ?? 0;
      return total;
    }

    const wanted = new Set(refs);
    const sums = new Map<string, number>();
    for (const row of this.rows) {
      if (row.at > when) break;
      if (!wanted.has(row.ref)) continue;
      const key = `${row.ref} ${row.value}`;
      sums.set(key, (sums.get(key) ?? 0) + row.delta);
    }

    let total = 0;
    for (const [key, sum] of sums) {
      if (sum <= 0) continue;
      const value = Number(key.slice(key.indexOf(' ') + 1));
      if (Number.isFinite(value)) total += value;
    }
    return total;
  }
}

/** One decimal place, because a mean of whole items is not a whole number. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

/** `a` minus `b`, as sets of refs. */
function without(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const ref of a) if (!b.has(ref)) out.add(ref);
  return out;
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const ref of a) if (b.has(ref)) out.add(ref);
  return out;
}

const DAY_LIMIT = 400;

export function sprintBurndown(
  db: Database,
  sprintId: number,
  options: { now?: string } = {},
): SprintBurndown | null {
  const sprint = sprintMeta(db, sprintId);
  if (!sprint) return null;

  const now = options.now ?? new Date().toISOString();
  const membership = transitions(db, 'sprint', String(sprintId));
  const openness = transitions(db, 'state', 'open');
  const points = Points.from(db);

  /*
   * The window.
   *
   * A sprint that never had dates still has a history, and falling back to the
   * first and last time anything joined it is more useful than refusing to
   * draw. The ideal line is what needs the real dates, and it is left out when
   * they are missing rather than invented from the data it is supposed to be
   * compared against.
   */
  const firstTouch = membership[0]?.at ?? null;
  const lastTouch = membership.at(-1)?.at ?? null;
  const from = sprint.startDate ?? firstTouch;
  const plannedEnd = sprint.completeDate ?? sprint.endDate;
  const to = plannedEnd ?? lastTouch ?? now;

  if (!from) {
    return {
      kind: 'burndown',
      sprint,
      committed: { items: 0, points: 0 },
      finalScope: { items: 0, points: 0 },
      completed: { items: 0, points: 0 },
      scope: { added: 0, removed: 0, changes: [] },
      days: [],
      hasPoints: false,
      pointsAreHistorical: points.historical,
    };
  }

  const startedAt = sprint.startDate ?? from;
  const committedRefs = membersAt(membership, startedAt);

  const grid = eachDay(from, to).slice(0, DAY_LIMIT);
  const today = now.slice(0, 10);
  // Whether the ideal line can be drawn at all, and over which days.
  const idealDays = sprint.startDate && plannedEnd ? grid.length : 0;
  const committedPoints = points.at(committedRefs, startedAt);

  const days: BurndownDay[] = grid.map((day, index) => {
    const endOfDay = `${day}T23:59:59.999Z`;
    const startOfDay = `${day}T00:00:00.000Z`;

    const inSprint = membersAt(membership, endOfDay);
    const open = membersAt(openness, endOfDay);
    const remaining = intersect(inSprint, open);
    const done = without(inSprint, open);

    let added = 0;
    let removed = 0;
    for (const row of membership) {
      if (row.at < startOfDay) continue;
      if (row.at > endOfDay) break;
      if (row.delta > 0) added += 1;
      else removed += 1;
    }

    // Straight from the committed scope on the first day to zero on the last.
    const slope = idealDays > 1 ? 1 - index / (idealDays - 1) : null;

    return {
      day,
      inSprint: inSprint.size,
      remaining: remaining.size,
      done: done.size,
      remainingPoints: points.at(remaining, endOfDay),
      donePoints: points.at(done, endOfDay),
      added,
      removed,
      ideal: slope === null ? null : Math.round(committedRefs.size * slope * 100) / 100,
      idealPoints: slope === null ? null : Math.round(committedPoints * slope * 100) / 100,
      actual: day <= today,
    };
  });

  const endInstant = plannedEnd && plannedEnd < now ? plannedEnd : now;
  const finalRefs = membersAt(membership, endInstant);
  const openAtEnd = membersAt(openness, endInstant);
  const completedRefs = without(finalRefs, openAtEnd);

  const changes: ScopeChange[] = membership
    .filter((row) => row.at > startedAt)
    .map((row) => ({
      key: row.ref,
      at: row.at,
      direction: row.delta > 0 ? ('added' as const) : ('removed' as const),
      points: points.at([row.ref], row.at),
    }));

  return {
    kind: 'burndown',
    sprint,
    committed: { items: committedRefs.size, points: committedPoints },
    finalScope: { items: finalRefs.size, points: points.at(finalRefs, endInstant) },
    completed: { items: completedRefs.size, points: points.at(completedRefs, endInstant) },
    scope: {
      added: changes.filter((change) => change.direction === 'added').length,
      removed: changes.filter((change) => change.direction === 'removed').length,
      changes,
    },
    days,
    hasPoints: points.at(new Set([...finalRefs, ...committedRefs]), endInstant) > 0,
    pointsAreHistorical: points.historical,
  };
}

/**
 * Committed against completed, sprint by sprint.
 *
 * The number teams plan with, and the one most often taken from the current
 * membership — which counts everything pulled in mid-sprint as if it had been
 * committed, and so reports a team that finished exactly what it promised
 * whatever actually happened. Both figures here are read at the instant they
 * refer to, so the gap between them is the real one.
 */
export function sprintVelocity(
  db: Database,
  options: { limit?: number; board?: number; now?: string } = {},
): Velocity {
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit && options.limit > 0 ? options.limit : 10;

  const rows = db.all<{
    id: number;
    name: string | null;
    state: string | null;
    start_date: string | null;
    end_date: string | null;
    complete_date: string | null;
  }>(
    `SELECT id, name, state, start_date, end_date, complete_date
       FROM jira_sprints
      WHERE start_date IS NOT NULL ${options.board === undefined ? '' : 'AND board_id = ?'}
      ORDER BY start_date DESC, id DESC
      LIMIT ?`,
    options.board === undefined ? [limit] : [options.board, limit],
  );

  const openness = transitions(db, 'state', 'open');
  const points = Points.from(db);

  const sprints: VelocitySprint[] = rows.map((row) => {
    const membership = transitions(db, 'sprint', String(row.id));
    const startedAt = row.start_date ?? now;
    const plannedEnd = row.complete_date ?? row.end_date;
    const endInstant = plannedEnd && plannedEnd < now ? plannedEnd : now;

    const committed = membersAt(membership, startedAt);
    const finalRefs = membersAt(membership, endInstant);
    const completed = without(finalRefs, membersAt(openness, endInstant));
    const changes = membership.filter((change) => change.at > startedAt);

    return {
      id: row.id,
      name: row.name,
      state: row.state,
      startDate: row.start_date,
      endDate: row.end_date,
      committed: { items: committed.size, points: points.at(committed, startedAt) },
      completed: { items: completed.size, points: points.at(completed, endInstant) },
      added: changes.filter((change) => change.delta > 0).length,
      removed: changes.filter((change) => change.delta < 0).length,
      ratio: committed.size > 0 ? Math.round((completed.size / committed.size) * 100) / 100 : null,
    };
  });

  // Oldest first, because a velocity chart is read left to right through time.
  sprints.reverse();

  return {
    kind: 'velocity',
    sprints,
    average: {
      items: mean(sprints.map((sprint) => sprint.completed.items)),
      points: mean(sprints.map((sprint) => sprint.completed.points)),
    },
    hasPoints: sprints.some((sprint) => sprint.completed.points > 0 || sprint.committed.points > 0),
    pointsAreHistorical: points.historical,
  };
}
