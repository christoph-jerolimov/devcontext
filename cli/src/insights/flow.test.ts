import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import { buildStateHistory } from '../history/build.js';
import { cumulativeFlow, statusTimes } from './flow.js';

let db: Database;

/** Day N at noon. */
function day(n: number): string {
  return new Date(Date.UTC(2024, 2, 1 + n, 12)).toISOString();
}

const NOW = '2024-03-10T00:00:00.000Z';

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
});

afterEach(() => {
  db.close();
});

function workitem(row: {
  key: string;
  status: string;
  category: string;
  created: string;
  history?: Array<{ from: string; to: string; at: string }>;
}): void {
  db.upsert('jira_workitems', {
    site: 'acme',
    id: row.key,
    key: row.key,
    project_key: 'PLAT',
    summary: row.key,
    type: 'Story',
    status: row.status,
    status_category: row.category,
    created_at: row.created,
    updated_at: NOW,
    synced_at: NOW,
    raw: '{}',
  });

  (row.history ?? []).forEach((change, index) => {
    db.upsert('jira_changelog', {
      site: 'acme',
      uid: `${row.key}:${String(index)}`,
      history_id: `${row.key}:${String(index)}`,
      workitem_id: row.key,
      workitem_key: row.key,
      author: 'grace',
      created_at: change.at,
      field: 'status',
      from_string: change.from,
      to_string: change.to,
      synced_at: NOW,
      raw: '{}',
    });
  });
}

/** One item that walks To Do -> In Progress -> Code Review -> Done. */
function walker(key: string, offset: number): void {
  workitem({
    key,
    status: 'Done',
    category: 'Done',
    created: day(offset),
    history: [
      { from: 'To Do', to: 'In Progress', at: day(offset + 1) },
      { from: 'In Progress', to: 'Code Review', at: day(offset + 2) },
      { from: 'Code Review', to: 'Done', at: day(offset + 4) },
    ],
  });
}

describe('the cumulative flow', () => {
  it('says which status the work was sitting in, day by day', () => {
    /*
     * The whole point. `state` knew only open and closed, so a backlog of one
     * and a review queue of one were the same number — and the two call for
     * completely different responses.
     */
    walker('PLAT-1', 0);
    buildStateHistory(db);

    const flow = cumulativeFlow(db, { from: day(0), to: day(5) });
    const on = (n: number): Record<string, number> => flow.days[n]?.counts ?? {};

    expect(on(0)).toEqual({ 'To Do': 1 });
    expect(on(1)).toEqual({ 'In Progress': 1 });
    expect(on(2)).toEqual({ 'Code Review': 1 });
    expect(on(4)).toEqual({ Done: 1 });
  });

  it('holds one item in exactly one status at a time', () => {
    // The invariant the whole ±1 table rests on. Two bands claiming the same
    // item would make every total larger than the number of items.
    walker('PLAT-1', 0);
    walker('PLAT-2', 1);
    buildStateHistory(db);

    const flow = cumulativeFlow(db, { from: day(0), to: day(6) });

    for (const entry of flow.days) {
      const summed = Object.values(entry.counts).reduce((a, b) => a + b, 0);
      expect([entry.day, summed]).toEqual([entry.day, entry.total]);
      expect(entry.total).toBeLessThanOrEqual(2);
    }
  });

  it('orders the bands by category, so the diagram reads left to right', () => {
    /*
     * A flow diagram read out of order says nothing: the point is watching one
     * band swell before the one after it.
     *
     * The category of a status is learned from the items currently in it —
     * Jira only reports it on the item, never in the changelog — so the parked
     * items here are not padding. A status nobody is sitting in has no known
     * category and sorts last, which is the honest place for it.
     */
    walker('PLAT-1', 0);
    workitem({ key: 'PLAT-7', status: 'To Do', category: 'To Do', created: day(0) });
    workitem({ key: 'PLAT-8', status: 'In Progress', category: 'In Progress', created: day(0) });
    workitem({ key: 'PLAT-9', status: 'Code Review', category: 'In Progress', created: day(0) });
    buildStateHistory(db);

    const ordered = cumulativeFlow(db, { from: day(0), to: day(6) }).statuses;

    expect(ordered[0]?.status).toBe('To Do');
    expect(ordered.at(-1)?.status).toBe('Done');
    expect(ordered.map((entry) => entry.status).toSorted()).toEqual([
      'Code Review',
      'Done',
      'In Progress',
      'To Do',
    ]);
  });

  it('narrows to the statuses asked for', () => {
    walker('PLAT-1', 0);
    buildStateHistory(db);

    const flow = cumulativeFlow(db, { from: day(0), to: day(6), statuses: ['Code Review'] });

    expect(flow.statuses.map((s) => s.status)).toEqual(['Code Review']);
    expect(flow.days.map((entry) => entry.total)).toEqual([0, 0, 1, 1, 0, 0, 0]);
  });
});

describe('time in each status', () => {
  it('measures a stay from entering to leaving', () => {
    walker('PLAT-1', 0);
    buildStateHistory(db);

    const times = statusTimes(db);
    const byStatus = new Map(times.statuses.map((entry) => [entry.status, entry]));

    expect(byStatus.get('In Progress')?.hours.p50).toBe(24);
    // Two days in review — the slow stop, which is the thing worth finding.
    expect(byStatus.get('Code Review')?.hours.p50).toBe(48);
  });

  it('puts the slowest status first', () => {
    walker('PLAT-1', 0);
    buildStateHistory(db);

    expect(statusTimes(db).statuses[0]?.status).toBe('Code Review');
  });

  it('counts both stays when work comes back', () => {
    // A ticket that went to review twice really did spend two stretches there.
    workitem({
      key: 'PLAT-1',
      status: 'Done',
      category: 'Done',
      created: day(0),
      history: [
        { from: 'To Do', to: 'Code Review', at: day(1) },
        { from: 'Code Review', to: 'In Progress', at: day(2) },
        { from: 'In Progress', to: 'Code Review', at: day(3) },
        { from: 'Code Review', to: 'Done', at: day(5) },
      ],
    });
    buildStateHistory(db);

    const review = statusTimes(db).statuses.find((entry) => entry.status === 'Code Review');

    expect(review?.stays).toBe(2);
    expect(review?.hours.min).toBe(24);
    expect(review?.hours.max).toBe(48);
  });

  it('counts a stay that has not ended rather than averaging it in', () => {
    /*
     * An item sitting in review right now has been there for an unknown time,
     * not a short one. Counting "so far" as a completed stay drags every
     * median down and makes a queue look healthier the longer it stalls.
     */
    workitem({
      key: 'PLAT-1',
      status: 'Code Review',
      category: 'In Progress',
      created: day(0),
      history: [{ from: 'To Do', to: 'Code Review', at: day(1) }],
    });
    buildStateHistory(db);

    const times = statusTimes(db);

    expect(times.ongoing).toBe(1);
    expect(times.statuses.map((entry) => entry.status)).toEqual(['To Do']);
  });

  it('says nothing at all about a project with no status history', () => {
    expect(statusTimes(db).statuses).toEqual([]);
    expect(cumulativeFlow(db, { from: day(0), to: day(2) }).statuses).toEqual([]);
  });
});
