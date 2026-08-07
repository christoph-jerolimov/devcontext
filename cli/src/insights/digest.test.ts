import { afterEach, beforeEach, describe as suite, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import { buildDigest } from './digest.js';

let db: Database;
const SYNCED = '2026-08-01T00:00:00.000Z';
const SINCE = '2026-07-01T00:00:00.000Z';
const UNTIL = '2026-07-08T00:00:00.000Z';

function addPull(number: number, fields: Record<string, unknown> = {}): void {
  db.upsert('gh_pull_requests', {
    host: 'github.com',
    id: 1000 + number,
    repo_id: 7,
    repo_full_name: 'acme/platform',
    number,
    title: `Pull request ${number}`,
    state: 'closed',
    assignees: '[]',
    requested_reviewers: '[]',
    labels: '[]',
    synced_at: SYNCED,
    raw: '{}',
    ...fields,
  } as Record<string, never>);
}

function addIssue(number: number, fields: Record<string, unknown> = {}): void {
  db.upsert('gh_issues', {
    host: 'github.com',
    id: 2000 + number,
    repo_id: 7,
    repo_full_name: 'acme/platform',
    number,
    title: `Issue ${number}`,
    state: 'closed',
    is_pull_request: 0,
    assignees: '[]',
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

function addStatusChange(key: string, at: string, to: string, author = 'Alice', index = 0): void {
  db.upsert('jira_changelog', {
    site: 'acme',
    uid: `${key}:${at}:${index}`,
    history_id: `${key}-${index}`,
    workitem_id: key,
    workitem_key: key,
    author,
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

suite('buildDigest', () => {
  it('reports what happened inside the window only', () => {
    addPull(1, { author: 'alice', created_at: '2026-07-02T00:00:00Z' });
    addPull(2, { author: 'bob', created_at: '2026-06-01T00:00:00Z' }); // before
    addPull(3, { author: 'cleo', created_at: '2026-07-20T00:00:00Z' }); // after

    const digest = buildDigest(db, { since: SINCE, until: UNTIL });

    expect(digest.github.pullRequestsOpened.map((entry) => entry.ref)).toEqual(['acme/platform#1']);
    expect(digest.quiet).toBe(false);
  });

  it('treats the window as half open, so a run of digests never repeats an item', () => {
    addPull(1, { author: 'alice', created_at: SINCE }); // exactly at `since`
    addPull(2, { author: 'alice', created_at: UNTIL }); // exactly at `until`

    const first = buildDigest(db, { since: SINCE, until: UNTIL });
    const second = buildDigest(db, { since: UNTIL, until: '2026-07-15T00:00:00Z' });

    expect(first.github.pullRequestsOpened.map((entry) => entry.ref)).toEqual(['acme/platform#1']);
    expect(second.github.pullRequestsOpened.map((entry) => entry.ref)).toEqual(['acme/platform#2']);
  });

  it('credits a merge to whoever pressed merge, and falls back to the author', () => {
    addPull(1, { author: 'alice', merged_by: 'bob', merged_at: '2026-07-02T00:00:00Z' });
    addPull(2, { author: 'cleo', merged_at: '2026-07-03T00:00:00Z' });

    const digest = buildDigest(db, { since: SINCE, until: UNTIL });
    const merged = digest.github.pullRequestsMerged;

    expect(merged.map((entry) => entry.who)).toEqual(['cleo', 'bob']);
  });

  it('reads started and finished from the changelog, not the current status', () => {
    // The item is Done today, but it was only started inside the window.
    addWorkitem('PLAT-1', { status: 'Done', status_category: 'Done' });
    addStatusChange('PLAT-1', '2026-07-02T00:00:00Z', 'In Progress');
    addStatusChange('PLAT-1', '2026-07-20T00:00:00Z', 'Done', 'Alice', 1);

    const digest = buildDigest(db, { since: SINCE, until: UNTIL });

    expect(digest.jira.started.map((entry) => entry.ref)).toEqual(['PLAT-1']);
    expect(digest.jira.finished).toHaveLength(0);
  });

  it('counts an item that moved to done in the window even when it was reopened later', () => {
    addWorkitem('PLAT-2', { status: 'In Progress', status_category: 'In Progress' });
    addStatusChange('PLAT-2', '2026-07-03T00:00:00Z', 'Done');
    addStatusChange('PLAT-2', '2026-07-30T00:00:00Z', 'In Progress', 'Alice', 1);

    const digest = buildDigest(db, { since: SINCE, until: UNTIL });

    expect(digest.jira.finished.map((entry) => entry.ref)).toEqual(['PLAT-2']);
  });

  it('lists an item once even when it bounced between statuses', () => {
    addWorkitem('PLAT-3');
    addStatusChange('PLAT-3', '2026-07-02T00:00:00Z', 'In Progress', 'Alice', 0);
    addStatusChange('PLAT-3', '2026-07-03T00:00:00Z', 'To Do', 'Alice', 1);
    addStatusChange('PLAT-3', '2026-07-04T00:00:00Z', 'In Progress', 'Alice', 2);

    const digest = buildDigest(db, { since: SINCE, until: UNTIL });

    expect(digest.jira.started).toHaveLength(1);
    expect(digest.jira.started[0]?.at).toBe('2026-07-04T00:00:00Z');
  });

  it('rolls activity up per person, most active first', () => {
    addPull(1, { author: 'alice', created_at: '2026-07-02T00:00:00Z' });
    addPull(2, {
      author: 'alice',
      merged_by: 'alice',
      created_at: '2026-07-02T00:00:00Z',
      merged_at: '2026-07-03T00:00:00Z',
    });
    addIssue(9, { author: 'bob', closed_by: 'bob', closed_at: '2026-07-04T00:00:00Z' });

    const digest = buildDigest(db, { since: SINCE, until: UNTIL });

    expect(digest.people.map((person) => person.person)).toEqual(['alice', 'bob']);
    expect(digest.people[0]).toMatchObject({
      pullRequestsOpened: 2,
      pullRequestsMerged: 1,
      total: 3,
    });
    expect(digest.people[1]).toMatchObject({ issuesClosed: 1, total: 1 });
  });

  it('restricts everything to the requested people', () => {
    addPull(1, { author: 'alice', created_at: '2026-07-02T00:00:00Z' });
    addPull(2, { author: 'bob', created_at: '2026-07-02T00:00:00Z' });
    addWorkitem('PLAT-1');
    addStatusChange('PLAT-1', '2026-07-02T00:00:00Z', 'In Progress', 'Bob');
    addReview(1, 1, 'bob', '2026-07-03T00:00:00Z');
    addReview(2, 1, 'alice', '2026-07-03T00:00:00Z');

    const digest = buildDigest(db, { since: SINCE, until: UNTIL, people: ['ALICE'] });

    expect(digest.github.pullRequestsOpened.map((entry) => entry.who)).toEqual(['alice']);
    expect(digest.jira.started).toHaveLength(0);
    expect(digest.people.map((person) => person.person)).toEqual(['alice']);
    // The headline counts describe the same set of activity as the table.
    expect(digest.github.reviews).toBe(1);
  });

  it('restricts to the requested repositories and projects', () => {
    addPull(1, { author: 'alice', created_at: '2026-07-02T00:00:00Z' });
    addWorkitem('PLAT-1');
    addWorkitem('OPS-1', { project_key: 'OPS' });
    addStatusChange('PLAT-1', '2026-07-02T00:00:00Z', 'In Progress');
    addStatusChange('OPS-1', '2026-07-02T00:00:00Z', 'In Progress');

    const digest = buildDigest(db, {
      since: SINCE,
      until: UNTIL,
      repos: ['acme/other'],
      projects: ['plat'],
    });

    expect(digest.github.pullRequestsOpened).toHaveLength(0);
    expect(digest.jira.started.map((entry) => entry.ref)).toEqual(['PLAT-1']);
  });

  it('caps each section at the limit but keeps the counts honest', () => {
    for (let number = 1; number <= 5; number += 1) {
      addPull(number, { author: 'alice', created_at: '2026-07-02T00:00:00Z' });
    }

    const digest = buildDigest(db, { since: SINCE, until: UNTIL, limit: 2 });

    expect(digest.github.pullRequestsOpened).toHaveLength(2);
    expect(digest.people[0]?.pullRequestsOpened).toBe(5);
  });

  it('says so when nothing happened', () => {
    const digest = buildDigest(db, { since: SINCE, until: UNTIL });

    expect(digest.quiet).toBe(true);
    expect(digest.people).toEqual([]);
    expect(digest.stale).toEqual([]);
  });

  it('reports failed workflow runs with their branch', () => {
    db.upsert('gh_workflow_runs', {
      host: 'github.com',
      id: 55,
      repo_id: 7,
      repo_full_name: 'acme/platform',
      workflow_id: 1,
      workflow_name: 'CI',
      conclusion: 'failure',
      head_branch: 'main',
      created_at: '2026-07-02T00:00:00Z',
      synced_at: SYNCED,
      raw: '{}',
    });

    const digest = buildDigest(db, { since: SINCE, until: UNTIL });

    expect(digest.github.failedRuns).toHaveLength(1);
    expect(digest.github.failedRuns[0]).toMatchObject({ ref: '55', title: 'CI', detail: 'main' });
  });

  it('includes stale work only when a threshold is given', () => {
    addWorkitem('PLAT-9', {
      status: 'In Progress',
      status_category: 'In Progress',
      updated_at: '2026-01-01T00:00:00Z',
    });

    expect(buildDigest(db, { since: SINCE, until: UNTIL }).stale).toEqual([]);

    const withStale = buildDigest(db, {
      since: SINCE,
      until: UNTIL,
      staleAfter: '2026-06-01T00:00:00Z',
    });
    expect(withStale.stale.map((item) => item.ref)).toEqual(['PLAT-9']);
  });
});
