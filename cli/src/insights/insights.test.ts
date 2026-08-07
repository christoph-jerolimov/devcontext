import { afterEach, beforeEach, describe as suite, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import { cycleTime, flakySteps, reviewLatency, sprintReport, staleItems, wip } from './index.js';
import { describe, formatHours, percentile } from './stats.js';

let db: Database;
const SYNCED = '2026-08-01T00:00:00.000Z';

function addWorkitem(key: string, fields: Record<string, unknown> = {}): void {
  db.upsert('jira_workitems', {
    site: 'acme',
    id: key,
    key,
    project_key: 'PLAT',
    summary: `Summary of ${key}`,
    labels: '[]',
    components: '[]',
    fix_versions: '[]',
    custom_fields: '{}',
    synced_at: SYNCED,
    raw: '{}',
    ...fields,
  } as Record<string, never>);
}

function addStatusChange(key: string, at: string, to: string, index = 0): void {
  db.upsert('jira_changelog', {
    site: 'acme',
    uid: `${key}:${at}:${index}`,
    history_id: `${key}-${index}`,
    workitem_id: key,
    workitem_key: key,
    author: 'Alice',
    created_at: at,
    field: 'status',
    to_string: to,
    synced_at: SYNCED,
    raw: '{}',
  });
}

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
});

afterEach(() => db.close());

suite('stats', () => {
  it('computes nearest-rank percentiles', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.85)).toBe(9);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('describes a sample', () => {
    const stats = describe([2, 4, 6]);
    expect(stats).toMatchObject({ count: 3, min: 2, max: 6, average: 4, total: 12, p50: 4 });
  });

  it('formats hours readably', () => {
    expect(formatHours(0.5)).toBe('30m');
    expect(formatHours(5)).toBe('5.0h');
    expect(formatHours(48)).toBe('2d');
    expect(formatHours(36)).toBe('36.0h');
    expect(formatHours(60)).toBe('2d 12h');
    expect(formatHours(null)).toBe('');
  });
});

suite('cycleTime', () => {
  it('measures from the first in-progress move to the last done move', () => {
    addWorkitem('PLAT-1', { type: 'Story', status: 'Done', status_category: 'Done' });
    addStatusChange('PLAT-1', '2026-06-01T00:00:00.000Z', 'In Progress', 0);
    addStatusChange('PLAT-1', '2026-06-03T00:00:00.000Z', 'Done', 1);

    const report = cycleTime(db, { since: '2026-01-01T00:00:00.000Z' });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.hours).toBe(48);
    expect(report.overall.p50).toBe(48);
  });

  it('ignores the time a ticket sat in the backlog', () => {
    // Created long before it was started; only the working time counts.
    addWorkitem('PLAT-2', {
      type: 'Story',
      created_at: '2026-01-01T00:00:00.000Z',
      status_category: 'Done',
    });
    addStatusChange('PLAT-2', '2026-06-01T00:00:00.000Z', 'In Progress', 0);
    addStatusChange('PLAT-2', '2026-06-01T12:00:00.000Z', 'Done', 1);

    expect(cycleTime(db).items[0]?.hours).toBe(12);
  });

  it('uses the last completion when a ticket was reopened', () => {
    addWorkitem('PLAT-3', { type: 'Bug', status_category: 'Done' });
    addStatusChange('PLAT-3', '2026-06-01T00:00:00.000Z', 'In Progress', 0);
    addStatusChange('PLAT-3', '2026-06-02T00:00:00.000Z', 'Done', 1);
    addStatusChange('PLAT-3', '2026-06-03T00:00:00.000Z', 'Reopened', 2);
    addStatusChange('PLAT-3', '2026-06-05T00:00:00.000Z', 'Done', 3);

    expect(cycleTime(db).items[0]?.hours).toBe(96);
  });

  it('counts items that never started separately instead of reporting nonsense', () => {
    addWorkitem('PLAT-4', { type: 'Task', status_category: 'Done' });
    addStatusChange('PLAT-4', '2026-06-02T00:00:00.000Z', 'Done', 0);

    const report = cycleTime(db);
    expect(report.items).toHaveLength(0);
    expect(report.withoutStart).toBe(1);
  });

  it('groups by type and honours the window', () => {
    addWorkitem('PLAT-5', { type: 'Story', status_category: 'Done' });
    addStatusChange('PLAT-5', '2026-01-01T00:00:00.000Z', 'In Progress', 0);
    addStatusChange('PLAT-5', '2026-01-02T00:00:00.000Z', 'Done', 1);

    expect(cycleTime(db, { since: '2026-06-01T00:00:00.000Z' }).items).toHaveLength(0);
    expect(cycleTime(db).byType.map((entry) => entry.type)).toEqual(['Story']);
  });
});

suite('reviewLatency', () => {
  function addPull(number: number, fields: Record<string, unknown>): void {
    db.upsert('gh_pull_requests', {
      host: 'github.com',
      id: 1000 + number,
      repo_id: 7,
      repo_full_name: 'acme/platform',
      number,
      state: 'closed',
      assignees: '[]',
      requested_reviewers: '[]',
      labels: '[]',
      synced_at: SYNCED,
      raw: '{}',
      ...fields,
    } as Record<string, never>);
  }

  function addReview(id: number, prNumber: number, author: string, at: string): void {
    db.upsert('gh_reviews', {
      host: 'github.com',
      id,
      repo_id: 7,
      repo_full_name: 'acme/platform',
      pr_id: 1000 + prNumber,
      pr_number: prNumber,
      author,
      state: 'APPROVED',
      submitted_at: at,
      synced_at: SYNCED,
      raw: '{}',
    });
  }

  it('measures time to first review and to merge', () => {
    addPull(1, {
      author: 'alice',
      created_at: '2026-06-01T00:00:00Z',
      merged_at: '2026-06-03T00:00:00Z',
    });
    addReview(1, 1, 'bob', '2026-06-01T06:00:00Z');

    const report = reviewLatency(db, { since: '2026-01-01T00:00:00Z' });
    expect(report.items[0]?.hoursToFirstReview).toBe(6);
    expect(report.items[0]?.hoursToMerge).toBe(48);
    expect(report.toFirstReview.p50).toBe(6);
  });

  it('does not count a self review as a review', () => {
    addPull(2, { author: 'alice', created_at: '2026-06-01T00:00:00Z' });
    addReview(2, 2, 'alice', '2026-06-01T01:00:00Z');

    const report = reviewLatency(db);
    const item = report.items.find((entry) => entry.number === 2);
    expect(item?.hoursToFirstReview).toBeNull();
  });

  it('counts pull requests merged without any review', () => {
    addPull(3, {
      author: 'alice',
      created_at: '2026-06-01T00:00:00Z',
      merged_at: '2026-06-01T02:00:00Z',
    });

    expect(reviewLatency(db).mergedWithoutReview).toBe(1);
  });

  it('reports the median response time per reviewer', () => {
    addPull(4, { author: 'alice', created_at: '2026-06-01T00:00:00Z' });
    addReview(4, 4, 'bob', '2026-06-01T04:00:00Z');

    const bob = reviewLatency(db).byReviewer.find((entry) => entry.reviewer === 'bob');
    expect(bob?.reviews).toBeGreaterThan(0);
    expect(bob?.medianResponseHours).not.toBeNull();
  });
});

suite('wip and stale', () => {
  beforeEach(() => {
    addWorkitem('PLAT-10', {
      status: 'In Progress',
      status_category: 'In Progress',
      assignee: 'Alice',
      updated_at: '2026-07-01T00:00:00.000Z',
    });
    addWorkitem('PLAT-11', {
      status: 'To Do',
      status_category: 'To Do',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    db.upsert('gh_pull_requests', {
      host: 'github.com',
      id: 1,
      repo_id: 7,
      repo_full_name: 'acme/platform',
      number: 1,
      state: 'open',
      draft: true,
      author: 'alice',
      assignees: '[]',
      requested_reviewers: '[]',
      labels: '[]',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      synced_at: SYNCED,
      raw: '{}',
    });
  });

  it('reports what is in flight and who carries it', () => {
    const report = wip(db);
    expect(report.workitems).toBe(1);
    expect(report.openPullRequests).toBe(1);
    expect(report.draftPullRequests).toBe(1);

    const alice = report.byAssignee.find((entry) => entry.assignee === 'Alice');
    expect(alice?.workitems).toBe(1);
  });

  it('finds open work nobody has touched', () => {
    const report = staleItems(db, '2026-06-01T00:00:00.000Z');

    expect(report.items.map((item) => item.ref)).toEqual(
      expect.arrayContaining(['PLAT-11', 'acme/platform#1']),
    );
    // The recently updated in-progress item is not stale.
    expect(report.items.map((item) => item.ref)).not.toContain('PLAT-10');
    expect(report.counts.pullRequests).toBe(1);
    expect(report.counts.workitems).toBe(1);
  });
});

suite('flakySteps', () => {
  function addStep(jobId: number, runId: number, name: string, conclusion: string): void {
    db.upsert('gh_workflow_jobs', {
      host: 'github.com',
      id: jobId,
      repo_id: 7,
      repo_full_name: 'acme/platform',
      run_id: runId,
      name: 'build',
      started_at: '2026-07-01T00:00:00Z',
      labels: '[]',
      synced_at: SYNCED,
      raw: '{}',
    });
    db.upsert('gh_workflow_steps', {
      host: 'github.com',
      job_id: jobId,
      number: 1,
      run_id: runId,
      name,
      status: 'completed',
      conclusion,
      synced_at: SYNCED,
      raw: '{}',
    });
  }

  it('ranks steps by failure rate once they have enough runs', () => {
    for (let index = 0; index < 6; index += 1) {
      addStep(100 + index, 200 + index, 'Test', index < 3 ? 'failure' : 'success');
    }
    for (let index = 0; index < 6; index += 1) {
      addStep(200 + index, 300 + index, 'Checkout', 'success');
    }

    const report = flakySteps(db, { minRuns: 5 });
    expect(report.steps.map((step) => step.step)).toEqual(['Test']);
    expect(report.steps[0]?.failureRate).toBe(50);
  });

  it('ignores steps with too few runs', () => {
    addStep(1, 1, 'Rare', 'failure');
    expect(flakySteps(db, { minRuns: 5 }).steps).toEqual([]);
  });

  it('counts a step that failed and passed in the same run as retried green', () => {
    // Two attempts of the same run: one failed, one succeeded.
    addStep(10, 500, 'Test', 'failure');
    addStep(11, 500, 'Test', 'success');
    for (let index = 0; index < 4; index += 1) {
      addStep(20 + index, 600 + index, 'Test', 'success');
    }

    const report = flakySteps(db, { minRuns: 5 });
    expect(report.steps[0]?.retriedGreen).toBe(1);
  });
});

suite('sprintReport', () => {
  beforeEach(() => {
    db.upsert('jira_sprints', {
      site: 'acme',
      id: 33,
      board_id: 1,
      name: 'Sprint 7',
      state: 'active',
      goal: 'Ship the sync',
      start_date: '2026-07-01T00:00:00.000Z',
      end_date: '2026-07-15T00:00:00.000Z',
      synced_at: SYNCED,
      raw: '{}',
    });
    for (const [key, category, points] of [
      ['PLAT-20', 'Done', 5],
      ['PLAT-21', 'In Progress', 3],
    ] as const) {
      addWorkitem(key, {
        status: category,
        status_category: category,
        story_points: points,
        assignee: 'Alice',
      });
      db.upsert('jira_sprint_workitems', {
        site: 'acme',
        sprint_id: 33,
        workitem_id: key,
        workitem_key: key,
      });
    }
  });

  it('summarises what the sprint contains and how much is done', () => {
    const report = sprintReport(db, 33)!;

    expect(report.items).toBe(2);
    expect(report.done).toBe(1);
    expect(report.storyPoints).toBe(8);
    expect(report.storyPointsDone).toBe(5);
    expect(report.completionRate).toBe(50);
    expect(report.byAssignee[0]).toMatchObject({ assignee: 'Alice', items: 2, done: 1 });
  });

  it('reports work moved in or out after the sprint started', () => {
    db.upsert('jira_changelog', {
      site: 'acme',
      uid: 'scope:0',
      history_id: 'scope',
      workitem_id: 'PLAT-21',
      workitem_key: 'PLAT-21',
      created_at: '2026-07-05T00:00:00.000Z',
      field: 'Sprint',
      from_string: '',
      to_string: 'Sprint 7',
      synced_at: SYNCED,
      raw: '{}',
    });

    expect(sprintReport(db, 33)?.scopeChanges).toEqual([
      { key: 'PLAT-21', when: '2026-07-05T00:00:00.000Z', from: '', to: 'Sprint 7' },
    ]);
  });

  it('returns null for an unknown sprint', () => {
    expect(sprintReport(db, 999)).toBeNull();
  });
});
