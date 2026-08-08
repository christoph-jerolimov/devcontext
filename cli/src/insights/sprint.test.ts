/**
 * The burndown is only worth having if it disagrees with the current tables.
 *
 * Every test here is built so that a report drawn from today's membership —
 * which is what `sprintReport` and every naive burndown do — would get a
 * different, plausible, wrong answer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import { buildStateHistory } from '../history/build.js';
import { sprintBurndown, sprintVelocity } from './sprint.js';

let db: Database;

/** Day N of the sprint, at noon. */
function day(n: number): string {
  return new Date(Date.UTC(2024, 2, 1 + n, 12)).toISOString();
}

const SPRINT_START = '2024-03-01T00:00:00.000Z';
const SPRINT_END = '2024-03-08T00:00:00.000Z';
const NOW = '2024-03-10T00:00:00.000Z';

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');

  // The catalogue the sync stores. The changelog labels an estimate change with
  // whatever the site calls the field, so this is how it is recognised.
  db.upsert('jira_fields', {
    site: 'acme',
    id: 'customfield_10016',
    name: 'Story Points',
    mapped_name: 'storyPoints',
    custom: 1,
    synced_at: NOW,
    raw: '{}',
  });

  sprint({ id: 1, name: 'Sprint 7', state: 'closed', start: SPRINT_START, end: SPRINT_END });
});

afterEach(() => {
  db.close();
});

function sprint(row: {
  id: number;
  name: string;
  state: string;
  start: string | null;
  end: string | null;
  complete?: string;
  board?: number;
}): void {
  db.upsert('jira_sprints', {
    site: 'acme',
    id: row.id,
    board_id: row.board ?? 1,
    name: row.name,
    state: row.state,
    start_date: row.start,
    end_date: row.end,
    complete_date: row.complete ?? null,
    synced_at: NOW,
    raw: '{}',
  });
}

/**
 * A work item with its current row, plus the changelog that got it there.
 *
 * Both, always: the history builder reconciles one against the other, and a
 * fixture that set only the changelog would be testing something the sync
 * never produces.
 */
function workitem(row: {
  key: string;
  created: string;
  points?: number | null;
  sprintId?: number | null;
  doneAt?: string;
  history?: Array<{ field: string; fieldId?: string; from?: string; to?: string; at: string }>;
}): void {
  db.upsert('jira_workitems', {
    site: 'acme',
    id: row.key,
    key: row.key,
    project_key: 'PLAT',
    summary: row.key,
    type: 'Story',
    status: row.doneAt ? 'Done' : 'In Progress',
    status_category: row.doneAt ? 'Done' : 'In Progress',
    story_points: row.points ?? null,
    sprint_id: row.sprintId === undefined ? 1 : row.sprintId,
    created_at: row.created,
    updated_at: NOW,
    synced_at: NOW,
    raw: '{}',
  });

  let index = 0;
  for (const change of row.history ?? []) {
    index += 1;
    db.upsert('jira_changelog', {
      site: 'acme',
      uid: `${row.key}:${String(index)}`,
      history_id: `${row.key}:${String(index)}`,
      workitem_id: row.key,
      workitem_key: row.key,
      author: 'grace',
      created_at: change.at,
      field: change.field,
      field_id: change.fieldId ?? null,
      from_string: change.from ?? null,
      to_string: change.to ?? null,
      synced_at: NOW,
      raw: '{}',
    });
  }
}

/** Jira reports a status as done via its category; the builder reads that. */
function markDone(key: string, at: string): Array<{ field: string; to: string; at: string }> {
  return [{ field: 'status', to: 'Done', at }];
}

describe('the sprint burndown', () => {
  it('falls as items are finished, day by day', () => {
    workitem({
      key: 'PLAT-1',
      created: day(-5),
      doneAt: day(2),
      history: markDone('PLAT-1', day(2)),
    });
    workitem({
      key: 'PLAT-2',
      created: day(-5),
      doneAt: day(4),
      history: markDone('PLAT-2', day(4)),
    });
    workitem({ key: 'PLAT-3', created: day(-5) });
    buildStateHistory(db);

    const report = sprintBurndown(db, 1, { now: NOW })!;
    const remaining = report.days.map((entry) => entry.remaining);

    // Three on days 0 and 1, two once PLAT-1 closes, one once PLAT-2 does.
    expect(remaining).toEqual([3, 3, 2, 2, 1, 1, 1, 1]);
    expect(report.committed.items).toBe(3);
    expect(report.completed.items).toBe(2);
  });

  it('shows work pulled in mid sprint as scope, not as a team that stalled', () => {
    /*
     * The failure this whole module exists to prevent. PLAT-9 joins on day 4.
     * Drawn from the current membership it was always there, so the line reads
     * 2, 2, 2, 2, 1, 1 — four days of a team finishing nothing. Drawn from the
     * history it goes up on day 4, which is what happened.
     */
    workitem({
      key: 'PLAT-1',
      created: day(-5),
      doneAt: day(4),
      history: markDone('PLAT-1', day(4)),
    });
    workitem({
      key: 'PLAT-9',
      created: day(-5),
      history: [{ field: 'Sprint', from: '', to: 'Sprint 7', at: day(4) }],
    });
    buildStateHistory(db);

    const report = sprintBurndown(db, 1, { now: NOW })!;

    expect(report.committed.items).toBe(1);
    expect(report.days.map((entry) => entry.inSprint)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(report.scope.added).toBe(1);
    expect(report.scope.changes.map((change) => change.key)).toEqual(['PLAT-9']);
    expect(report.days[4]?.added).toBe(1);
  });

  it('shows work dropped out of the sprint as scope removed', () => {
    workitem({ key: 'PLAT-1', created: day(-5) });
    workitem({
      key: 'PLAT-2',
      created: day(-5),
      sprintId: null,
      history: [{ field: 'Sprint', from: 'Sprint 7', to: '', at: day(3) }],
    });
    buildStateHistory(db);

    const report = sprintBurndown(db, 1, { now: NOW })!;

    expect(report.committed.items).toBe(2);
    expect(report.days.map((entry) => entry.inSprint)).toEqual([2, 2, 2, 1, 1, 1, 1, 1]);
    expect(report.scope.removed).toBe(1);
    expect(report.days[3]?.removed).toBe(1);
  });

  it('burns points as well as items, and says when there are none', () => {
    workitem({
      key: 'PLAT-1',
      created: day(-5),
      points: 5,
      doneAt: day(2),
      history: markDone('PLAT-1', day(2)),
    });
    workitem({ key: 'PLAT-2', created: day(-5), points: 3 });
    buildStateHistory(db);

    const report = sprintBurndown(db, 1, { now: NOW })!;

    expect(report.hasPoints).toBe(true);
    expect(report.committed.points).toBe(8);
    expect(report.days.map((entry) => entry.remainingPoints)).toEqual([8, 8, 3, 3, 3, 3, 3, 3]);
    expect(report.days.map((entry) => entry.donePoints)).toEqual([0, 0, 5, 5, 5, 5, 5, 5]);
  });

  it('burns the estimate the item had on the day, not the one it has now', () => {
    /*
     * The caveat this dimension removes. PLAT-1 is re-estimated from 3 to 8 on
     * day 3. Read from today's number it was worth 8 all along, so the first
     * three days of the sprint are drawn 5 points heavier than they were and
     * the line does not step where the team's plan actually changed.
     */
    workitem({
      key: 'PLAT-1',
      created: day(-5),
      points: 8,
      history: [
        { field: 'Story Points', fieldId: 'customfield_10016', from: '3', to: '8', at: day(3) },
      ],
    });
    buildStateHistory(db);

    const report = sprintBurndown(db, 1, { now: NOW })!;

    expect(report.pointsAreHistorical).toBe(true);
    expect(report.committed.points).toBe(3);
    expect(report.days.map((entry) => entry.remainingPoints)).toEqual([3, 3, 3, 8, 8, 8, 8, 8]);
  });

  it('recognises the estimate change by field id whatever the site calls it', () => {
    workitem({
      key: 'PLAT-1',
      created: day(-5),
      points: 8,
      history: [
        // A site that renamed the field. The id still identifies it.
        { field: 'Complexity', fieldId: 'customfield_10016', from: '3', to: '8', at: day(3) },
      ],
    });
    buildStateHistory(db);

    expect(sprintBurndown(db, 1, { now: NOW })?.committed.points).toBe(3);
  });

  it('treats 5, 5.0 and a padded 5 as one estimate', () => {
    /*
     * Asserted on the rows rather than on the line, because the line cannot see
     * it: both spellings read back as 5 either way. What the normalising buys
     * is that an edit which changed nothing leaves no transition behind — so
     * the history says the estimate held steady, which is what happened.
     */
    workitem({
      key: 'PLAT-1',
      created: day(-5),
      points: 5,
      history: [
        { field: 'Story Points', fieldId: 'customfield_10016', from: '5', to: ' 5.0 ', at: day(3) },
      ],
    });
    buildStateHistory(db);

    const rows = db.all<{ value: string; delta: number }>(
      `SELECT value, delta FROM state_changes WHERE dimension = 'points' ORDER BY at, seq`,
    );

    expect(rows).toEqual([{ value: '5', delta: 1 }]);
    expect(sprintBurndown(db, 1, { now: NOW })?.days.map((entry) => entry.remainingPoints)).toEqual(
      [5, 5, 5, 5, 5, 5, 5, 5],
    );
  });

  it('drops an item that had its estimate cleared', () => {
    workitem({
      key: 'PLAT-1',
      created: day(-5),
      points: null,
      history: [
        { field: 'Story Points', fieldId: 'customfield_10016', from: '5', to: '', at: day(3) },
      ],
    });
    buildStateHistory(db);

    const report = sprintBurndown(db, 1, { now: NOW })!;

    expect(report.days.map((entry) => entry.remainingPoints)).toEqual([5, 5, 5, 0, 0, 0, 0, 0]);
  });

  it('falls back to today when the history was never rebuilt', () => {
    /*
     * A database written before this dimension existed. Zeroes would be a
     * wrong number told confidently; the old number is an old number, and the
     * report says which it gave.
     */
    workitem({ key: 'PLAT-1', created: day(-5), points: 5 });
    buildStateHistory(db);
    db.exec(`DELETE FROM state_changes WHERE dimension = 'points'`);

    const report = sprintBurndown(db, 1, { now: NOW })!;

    expect(report.pointsAreHistorical).toBe(false);
    expect(report.committed.points).toBe(5);
  });

  it('does not claim points a team that never estimates has', () => {
    // A flat line at zero reads as a bug rather than as a choice they made.
    workitem({ key: 'PLAT-1', created: day(-5) });
    buildStateHistory(db);

    expect(sprintBurndown(db, 1, { now: NOW })?.hasPoints).toBe(false);
  });

  it('draws the ideal line from the committed scope to zero', () => {
    workitem({ key: 'PLAT-1', created: day(-5) });
    workitem({ key: 'PLAT-2', created: day(-5) });
    workitem({ key: 'PLAT-3', created: day(-5) });
    workitem({ key: 'PLAT-4', created: day(-5) });
    buildStateHistory(db);

    const report = sprintBurndown(db, 1, { now: NOW })!;
    const ideal = report.days.map((entry) => entry.ideal);

    expect(ideal[0]).toBe(4);
    expect(ideal.at(-1)).toBe(0);
    // Monotonically down, never back up.
    expect(ideal.every((value, index) => index === 0 || value! <= ideal[index - 1]!)).toBe(true);
  });

  it('stops the actual line at today rather than drawing a future', () => {
    sprint({ id: 2, name: 'Sprint 8', state: 'active', start: day(0), end: day(9) });
    workitem({ key: 'PLAT-1', created: day(-5), sprintId: 2 });
    buildStateHistory(db);

    const report = sprintBurndown(db, 2, { now: day(3) })!;
    const actual = report.days.map((entry) => entry.actual);

    // Four days of history, and the rest ideal line only.
    expect(actual.filter(Boolean)).toHaveLength(4);
    expect(actual.at(-1)).toBe(false);
    // The ideal line still runs the full sprint, so the target stays visible.
    expect(report.days.at(-1)?.ideal).toBe(0);
  });

  it('leaves out the ideal line when the sprint has no dates to draw it from', () => {
    // Inventing one from the data it is meant to be compared against would make
    // every sprint look perfectly planned.
    sprint({ id: 3, name: 'Undated', state: 'active', start: null, end: null });
    workitem({ key: 'PLAT-1', created: day(-5), sprintId: 3 });
    buildStateHistory(db);

    const report = sprintBurndown(db, 3, { now: NOW })!;

    expect(report.days.length).toBeGreaterThan(0);
    expect(report.days.every((entry) => entry.ideal === null)).toBe(true);
  });

  it('counts an item reopened during the sprint as remaining again', () => {
    /*
     * The extra item is not decoration. The history builder learns which
     * status names mean "done" from the items currently sitting in that
     * category, so a fixture where nothing is done has no word for it and no
     * status change would ever close anything.
     */
    workitem({ key: 'PLAT-9', created: day(-5), sprintId: null, doneAt: day(1) });
    workitem({
      key: 'PLAT-1',
      created: day(-5),
      history: [
        { field: 'status', to: 'Done', at: day(2) },
        { field: 'status', to: 'In Progress', at: day(5) },
      ],
    });
    buildStateHistory(db);

    const report = sprintBurndown(db, 1, { now: NOW })!;

    expect(report.days.map((entry) => entry.remaining)).toEqual([1, 1, 0, 0, 0, 1, 1, 1]);
  });

  it('returns nothing for a sprint that does not exist', () => {
    expect(sprintBurndown(db, 999, { now: NOW })).toBeNull();
  });
});

describe('velocity across sprints', () => {
  beforeEach(() => {
    sprint({ id: 2, name: 'Sprint 8', state: 'closed', start: day(10), end: day(17) });

    // Sprint 7: two committed, one finished.
    workitem({
      key: 'PLAT-1',
      created: day(-5),
      points: 5,
      doneAt: day(2),
      history: markDone('PLAT-1', day(2)),
    });
    workitem({ key: 'PLAT-2', created: day(-5), points: 3 });

    // Sprint 8: one committed, one pulled in later, both finished.
    workitem({
      key: 'PLAT-3',
      created: day(9),
      points: 2,
      sprintId: 2,
      doneAt: day(12),
      history: markDone('PLAT-3', day(12)),
    });
    workitem({
      key: 'PLAT-4',
      created: day(9),
      points: 8,
      sprintId: 2,
      doneAt: day(16),
      history: [
        { field: 'Sprint', from: '', to: 'Sprint 8', at: day(13) },
        { field: 'status', to: 'Done', at: day(16) },
      ],
    });
    buildStateHistory(db);
  });

  it('reports committed and completed at the instants they refer to', () => {
    const velocity = sprintVelocity(db, { now: day(20) });

    expect(velocity.sprints.map((entry) => entry.name)).toEqual(['Sprint 7', 'Sprint 8']);

    const seven = velocity.sprints[0]!;
    expect(seven.committed.items).toBe(2);
    expect(seven.completed.items).toBe(1);
    expect(seven.ratio).toBe(0.5);
  });

  it('does not credit work pulled in mid sprint as work committed', () => {
    /*
     * Sprint 8 finished two items but only ever committed to one. Read from
     * the current membership both were committed and both were done — a
     * perfect 100%, reported for a sprint whose plan was doubled halfway
     * through.
     */
    const eight = sprintVelocity(db, { now: day(20) }).sprints[1]!;

    expect(eight.committed.items).toBe(1);
    expect(eight.completed.items).toBe(2);
    expect(eight.added).toBe(1);
    expect(eight.ratio).toBe(2);
  });

  it('orders oldest first, because a velocity chart is read through time', () => {
    const velocity = sprintVelocity(db, { now: day(20) });

    expect(velocity.sprints.map((entry) => entry.startDate)).toEqual(
      velocity.sprints.map((entry) => entry.startDate).toSorted(),
    );
  });

  it('averages what was completed, and carries the points', () => {
    const velocity = sprintVelocity(db, { now: day(20) });

    expect(velocity.average.items).toBe(1.5);
    expect(velocity.average.points).toBe(7.5);
    expect(velocity.hasPoints).toBe(true);
  });

  it('honours the sprint limit and the board filter', () => {
    sprint({ id: 3, name: 'Other board', state: 'closed', start: day(10), end: day(17), board: 9 });

    expect(sprintVelocity(db, { limit: 1, now: day(20) }).sprints).toHaveLength(1);
    expect(sprintVelocity(db, { board: 9, now: day(20) }).sprints.map((s) => s.id)).toEqual([3]);
  });
});
