import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import { openByAssignee, openByDay } from '../db/queries/history.js';
import { buildStateHistory } from './build.js';

let workspace: string;
let db: Database;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'devcontext-history-'));
  db = Database.openAndMigrate(join(workspace, 'devcontext.db'));
});

afterEach(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
});

let nextEvent = 0;

function issue(row: {
  number: number;
  id: number;
  state: string;
  createdAt: string;
  closedAt?: string;
  assignees?: string[];
  isPull?: boolean;
}): void {
  db.upsert('gh_issues', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: row.number,
    title: `Issue ${String(row.number)}`,
    state: row.state,
    author: 'alice',
    assignees: JSON.stringify(row.assignees ?? []),
    created_at: row.createdAt,
    updated_at: row.createdAt,
    closed_at: row.closedAt ?? null,
    is_pull_request: row.isPull ?? false,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

function event(issueId: number, name: string, at: string, assignee?: string): void {
  nextEvent += 1;
  db.upsert('gh_events', {
    host: 'github.com',
    uid: `e${String(nextEvent)}`,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    issue_id: issueId,
    issue_number: 1,
    event: name,
    actor: 'alice',
    assignee: assignee ?? null,
    created_at: at,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

/**
 * The property the whole table rests on: an item is either in a set or out of
 * it, so the running sum of any series must stay within {0, 1} at *every*
 * point — not merely end there.
 *
 * Checking only the final sum would miss the case this is really guarding: a
 * transition recorded out of order sends the running total to 2 for a while
 * and comes back to 1, and every count taken during that window is wrong.
 */
function seriesBounds(): { lowest: number; highest: number } {
  const row = db.get<{ lowest: number; highest: number }>(
    `SELECT MIN(running) AS lowest, MAX(running) AS highest FROM (
       SELECT SUM(delta) OVER (
                PARTITION BY source, ref, dimension, value ORDER BY at, seq
              ) AS running
         FROM state_changes
     )`,
  );
  return { lowest: row?.lowest ?? 0, highest: row?.highest ?? 0 };
}

describe('buildStateHistory', () => {
  it('turns an open, a close and a reopen into a series that sums to the truth', () => {
    issue({ number: 1, id: 101, state: 'open', createdAt: '2024-03-01T00:00:00.000Z' });
    event(101, 'closed', '2024-03-05T00:00:00.000Z');
    event(101, 'reopened', '2024-03-09T00:00:00.000Z');

    buildStateHistory(db);

    const days = openByDay(db, { from: '2024-03-01', to: '2024-03-10' });
    const open = Object.fromEntries(days.map((day) => [day.day, day.open]));

    expect(open['2024-02-29']).toBeUndefined();
    expect(open['2024-03-01']).toBe(1); // opened
    expect(open['2024-03-04']).toBe(1);
    expect(open['2024-03-05']).toBe(0); // closed
    expect(open['2024-03-08']).toBe(0);
    expect(open['2024-03-09']).toBe(1); // reopened
    expect(open['2024-03-10']).toBe(1);
  });

  it('counts what moved on each day separately from the balance', () => {
    issue({ number: 1, id: 101, state: 'open', createdAt: '2024-03-01T00:00:00.000Z' });
    issue({
      number: 2,
      id: 102,
      state: 'closed',
      createdAt: '2024-03-01T00:00:00.000Z',
      closedAt: '2024-03-04T00:00:00.000Z',
    });
    event(102, 'closed', '2024-03-04T00:00:00.000Z');

    buildStateHistory(db);

    const days = openByDay(db, { from: '2024-03-01', to: '2024-03-05' });
    const byDay = Object.fromEntries(days.map((day) => [day.day, day]));

    expect(byDay['2024-03-01']).toMatchObject({ open: 2, opened: 2, closed: 0 });
    expect(byDay['2024-03-04']).toMatchObject({ open: 1, opened: 0, closed: 1 });
    // The balance carried in from before, with nothing moving on the day.
    expect(byDay['2024-03-05']).toMatchObject({ open: 1, opened: 0, closed: 0 });
  });

  it('follows an item as it is reassigned', () => {
    issue({
      number: 1,
      id: 101,
      state: 'open',
      createdAt: '2024-03-01T00:00:00.000Z',
      assignees: ['bob'],
    });
    event(101, 'assigned', '2024-03-02T00:00:00.000Z', 'alice');
    event(101, 'unassigned', '2024-03-06T00:00:00.000Z', 'alice');
    event(101, 'assigned', '2024-03-06T00:00:00.000Z', 'bob');

    buildStateHistory(db);

    expect(openByAssignee(db, { at: '2024-03-03T00:00:00.000Z' })).toEqual([
      { assignee: 'alice', open: 1 },
    ]);
    expect(openByAssignee(db, { at: '2024-03-07T00:00:00.000Z' })).toEqual([
      { assignee: 'bob', open: 1 },
    ]);
  });

  it('stops counting a closed item against the person who held it', () => {
    issue({
      number: 1,
      id: 101,
      state: 'closed',
      createdAt: '2024-03-01T00:00:00.000Z',
      closedAt: '2024-03-05T00:00:00.000Z',
      assignees: ['alice'],
    });
    event(101, 'assigned', '2024-03-01T00:00:00.000Z', 'alice');
    event(101, 'closed', '2024-03-05T00:00:00.000Z');

    buildStateHistory(db);

    expect(openByAssignee(db, { at: '2024-03-03T00:00:00.000Z' })).toEqual([
      { assignee: 'alice', open: 1 },
    ]);
    // Still assigned to her, no longer open, so it counts against nobody.
    expect(openByAssignee(db, { at: '2024-03-06T00:00:00.000Z' })).toEqual([]);
  });

  it('is unmoved by a timeline that contradicts itself', () => {
    /*
     * The reason the builder replays rather than translates. GitHub emits both
     * `closed` and `merged` for a merged pull request, a timeline can be
     * fetched twice across a rename, and events sharing a timestamp arrive in
     * whatever order. Translating each to a row would drift the sum; replaying
     * against the state cannot.
     */
    issue({
      number: 42,
      id: 142,
      state: 'closed',
      createdAt: '2024-03-01T00:00:00.000Z',
      closedAt: '2024-03-05T00:00:00.000Z',
      isPull: true,
    });
    event(142, 'closed', '2024-03-05T00:00:00.000Z');
    event(142, 'merged', '2024-03-05T00:00:00.000Z');
    event(142, 'closed', '2024-03-05T00:00:00.000Z');
    event(142, 'assigned', '2024-03-02T00:00:00.000Z', 'alice');
    event(142, 'assigned', '2024-03-03T00:00:00.000Z', 'alice');

    buildStateHistory(db);

    expect(seriesBounds()).toEqual({ lowest: 0, highest: 1 });

    const days = openByDay(db, { from: '2024-03-04', to: '2024-03-06' });
    expect(days.map((day) => day.open)).toEqual([1, 0, 0]);
  });

  it('trusts the row over a timeline that is missing the close', () => {
    // `issueTimeline` may be off, or the close may predate the window. The row
    // always knows where the item ended up.
    issue({
      number: 7,
      id: 107,
      state: 'closed',
      createdAt: '2024-03-01T00:00:00.000Z',
      closedAt: '2024-03-04T00:00:00.000Z',
    });

    buildStateHistory(db);

    const days = openByDay(db, { from: '2024-03-03', to: '2024-03-05' });
    expect(days.map((day) => day.open)).toEqual([1, 0, 0]);
  });

  it('never records a transition before the one it follows', () => {
    /*
     * The reconciling pass knows the final state but not always when it
     * happened, and falls back on the creation date. Recorded literally that
     * would put a +1 before the -1 preceding it, and every count taken in
     * between would read two.
     */
    issue({
      number: 8,
      id: 108,
      state: 'open',
      createdAt: '2024-03-01T00:00:00.000Z',
    });
    event(108, 'closed', '2024-03-05T00:00:00.000Z');

    buildStateHistory(db);

    expect(seriesBounds()).toEqual({ lowest: 0, highest: 1 });
    const days = openByDay(db, { from: '2024-03-01', to: '2024-03-06' });
    // Closed on the 5th and reopened by the reconciliation, which cannot land
    // earlier than the close it follows.
    expect(days.at(-1)?.open).toBe(1);
  });

  it('is a rebuild, so running it twice changes nothing', () => {
    issue({ number: 1, id: 101, state: 'open', createdAt: '2024-03-01T00:00:00.000Z' });
    event(101, 'closed', '2024-03-05T00:00:00.000Z');

    const first = buildStateHistory(db);
    const before = db.count('state_changes');
    const second = buildStateHistory(db);

    expect(second).toEqual(first);
    expect(db.count('state_changes')).toBe(before);
  });
});
