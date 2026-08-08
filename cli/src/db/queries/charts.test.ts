/**
 * The two per-day series behind the charts.
 *
 * Both fail quietly when they are wrong. A chart with a gap where a day should
 * be reads as a quiet Tuesday; a chart that counts every close as a success
 * reads as a productive week. Neither announces itself, so both are asserted
 * here rather than looked at.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../database.js';
import { closedByDay, runsByDay } from './github.js';

let db: Database;

const SYNCED = '2026-06-01T00:00:00.000Z';

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
});

afterEach(() => {
  db.close();
});

function pull(row: {
  id: number;
  author: string;
  assignees?: string[];
  closedAt?: string | null;
  merged?: boolean;
  repo?: string;
}): void {
  db.upsert('gh_pull_requests', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: row.repo ?? 'acme/platform',
    number: row.id,
    title: `Pull ${String(row.id)}`,
    state: row.closedAt ? 'closed' : 'open',
    author: row.author,
    assignees: JSON.stringify(row.assignees ?? []),
    merged: row.merged === true ? 1 : 0,
    created_at: '2026-03-01T09:00:00Z',
    updated_at: '2026-03-05T09:00:00Z',
    closed_at: row.closedAt ?? null,
    merged_at: row.merged === true ? row.closedAt : null,
    synced_at: SYNCED,
    raw: '{}',
  });
}

function run(row: { id: number; createdAt: string; conclusion: string | null }): void {
  db.upsert('gh_workflow_runs', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    workflow_name: 'CI',
    name: 'CI',
    status: row.conclusion === null ? 'in_progress' : 'completed',
    conclusion: row.conclusion,
    created_at: row.createdAt,
    updated_at: row.createdAt,
    synced_at: SYNCED,
    raw: '{}',
  });
}

describe('pull requests finished per day', () => {
  beforeEach(() => {
    pull({ id: 1, author: 'ada', closedAt: '2026-03-02T10:00:00Z', merged: true });
    pull({ id: 2, author: 'ada', closedAt: '2026-03-02T14:00:00Z', merged: true });
    // Closed and thrown away: the work produced nothing.
    pull({ id: 3, author: 'linus', closedAt: '2026-03-02T15:00:00Z', merged: false });
    pull({ id: 4, author: 'grace', closedAt: '2026-03-04T09:00:00Z', merged: true });
    // Still open, so it belongs on no day at all.
    pull({ id: 5, author: 'ada' });
  });

  it('splits merged from thrown away, because one number cannot tell them apart', () => {
    /*
     * Twelve pull requests closed in a week is a good week or a wasted one
     * depending entirely on how many were merged. The state dimension flattens
     * both into "closed", which is why this does not read from it.
     */
    const days = closedByDay(db, { from: '2026-03-01', to: '2026-03-05' });
    const second = days.find((day) => day.day === '2026-03-02');

    expect(second).toEqual({ day: '2026-03-02', total: 3, merged: 2, discarded: 1 });
  });

  it('keeps the empty days, so a weekend does not read as a quiet week', () => {
    // A chart that skips the gap draws Friday next to Monday and hides the
    // shape of the week entirely.
    const days = closedByDay(db, { from: '2026-03-01', to: '2026-03-05' });

    expect(days.map((day) => day.day)).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
    expect(days[0]).toEqual({ day: '2026-03-01', total: 0, merged: 0, discarded: 0 });
  });

  it('never counts a pull request that is still open', () => {
    const total = closedByDay(db, { from: '2026-03-01', to: '2026-03-05' }).reduce(
      (sum, day) => sum + day.total,
      0,
    );

    expect(total).toBe(4);
  });

  it('narrows to a person by author or assignee', () => {
    // The same rule as every other person filter here: "the platform team's
    // pull requests" means the ones they raised and the ones they were handed.
    pull({ id: 6, author: 'somebody', assignees: ['grace'], closedAt: '2026-03-03T09:00:00Z' });

    const grace = closedByDay(db, {
      from: '2026-03-01',
      to: '2026-03-05',
      people: ['grace'],
    });

    expect(grace.reduce((sum, day) => sum + day.total, 0)).toBe(2);
  });

  it('matches nothing for a person with no GitHub identity, rather than everything', () => {
    /*
     * The rule the whole people layer rests on. The inverse returns every pull
     * request in the repository attributed to somebody who has no account on
     * it, and looks entirely plausible on a chart.
     */
    const none = closedByDay(db, { from: '2026-03-01', to: '2026-03-05', people: [] });

    expect(none.reduce((sum, day) => sum + day.total, 0)).toBe(0);
  });

  it('narrows to one repository', () => {
    pull({ id: 7, author: 'ada', closedAt: '2026-03-02T10:00:00Z', repo: 'acme/other' });

    const scoped = closedByDay(db, {
      from: '2026-03-01',
      to: '2026-03-05',
      repos: ['acme/other'],
    });

    expect(scoped.reduce((sum, day) => sum + day.total, 0)).toBe(1);
  });
});

describe('workflow runs per day', () => {
  it('splits by how each run ended', () => {
    // The point of the chart: whether CI is getting worse is a failure count.
    run({ id: 1, createdAt: '2026-03-02T09:00:00Z', conclusion: 'success' });
    run({ id: 2, createdAt: '2026-03-02T10:00:00Z', conclusion: 'failure' });
    run({ id: 3, createdAt: '2026-03-02T11:00:00Z', conclusion: 'cancelled' });
    run({ id: 4, createdAt: '2026-03-02T12:00:00Z', conclusion: 'skipped' });
    // Still running: it ended in none of those ways yet, and must not be
    // silently counted as a success.
    run({ id: 5, createdAt: '2026-03-02T13:00:00Z', conclusion: null });

    const day = runsByDay(db, { from: '2026-03-01', to: '2026-03-03' }).find(
      (entry) => entry.day === '2026-03-02',
    );

    expect(day).toEqual({
      day: '2026-03-02',
      total: 5,
      success: 1,
      failure: 1,
      cancelled: 1,
      other: 2,
    });
  });

  it('adds up to the total, whatever the conclusion was', () => {
    // A conclusion nobody anticipated must land in "other" rather than
    // vanishing, or the bars stop summing to the number of runs.
    run({ id: 1, createdAt: '2026-03-02T09:00:00Z', conclusion: 'action_required' });
    run({ id: 2, createdAt: '2026-03-02T10:00:00Z', conclusion: 'neutral' });

    for (const day of runsByDay(db, { from: '2026-03-01', to: '2026-03-03' })) {
      expect([day.day, day.success + day.failure + day.cancelled + day.other]).toEqual([
        day.day,
        day.total,
      ]);
    }
  });

  it('keeps the empty days', () => {
    run({ id: 1, createdAt: '2026-03-03T09:00:00Z', conclusion: 'success' });

    expect(runsByDay(db, { from: '2026-03-01', to: '2026-03-03' }).map((day) => day.total)).toEqual(
      [0, 0, 1],
    );
  });
});
