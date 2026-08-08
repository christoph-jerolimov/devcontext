/**
 * Who worked on what, and in what capacity.
 *
 * The failure this guards against is a plausible one: a list of names that
 * looks right and attributes the work to the wrong people. Naming the author
 * as a reviewer, counting one person twice because they commented in two
 * places, or answering "who worked on this epic" with the person who created
 * the heading all produce output nobody can tell is wrong.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contributorsOf, contributionsOf, descendantsOf } from '../db/queries/contributors.js';
import { Database } from '../db/database.js';
import { buildContributors, CONTRIBUTOR_ROLES, ROLE_DESCRIPTIONS } from './build.js';

let db: Database;

const SYNCED = '2024-06-01T00:00:00.000Z';

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
});

afterEach(() => {
  db.close();
});

function issue(row: {
  id: number;
  number: number;
  author: string;
  assignees?: string[];
  pull?: boolean;
}): void {
  db.upsert('gh_issues', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: row.number,
    title: `Item ${String(row.number)}`,
    state: 'open',
    author: row.author,
    assignees: JSON.stringify(row.assignees ?? []),
    is_pull_request: row.pull ?? false,
    created_at: '2024-03-01T09:00:00Z',
    updated_at: '2024-03-05T09:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
  });
}

function pull(row: {
  id: number;
  number: number;
  author: string;
  requested?: string[];
  mergedBy?: string;
}): void {
  issue({ id: row.id, number: row.number, author: row.author, pull: true });
  db.upsert('gh_pull_requests', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: row.number,
    title: `Pull ${String(row.number)}`,
    state: 'open',
    author: row.author,
    assignees: '[]',
    requested_reviewers: JSON.stringify(row.requested ?? []),
    created_at: '2024-03-01T09:00:00Z',
    updated_at: '2024-03-05T09:00:00Z',
    merged_at: row.mergedBy ? '2024-03-05T09:00:00Z' : null,
    merged_by: row.mergedBy ?? null,
    synced_at: SYNCED,
    raw: '{}',
  });
}

function comment(row: { id: number; issueId: number; number: number; author: string; at: string }) {
  db.upsert('gh_comments', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    issue_id: row.issueId,
    issue_number: row.number,
    author: row.author,
    body: 'a word',
    created_at: row.at,
    synced_at: SYNCED,
    raw: '{}',
  });
}

function reviewComment(row: { id: number; prId: number; number: number; author: string }): void {
  db.upsert('gh_review_comments', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    pr_id: row.prId,
    pr_number: row.number,
    author: row.author,
    body: 'this line',
    created_at: '2024-03-04T09:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
  });
}

function review(row: { id: number; prId: number; number: number; author: string }): void {
  db.upsert('gh_reviews', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    pr_id: row.prId,
    pr_number: row.number,
    author: row.author,
    state: 'APPROVED',
    submitted_at: '2024-03-04T10:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
  });
}

function commit(row: {
  sha: string;
  prId: number;
  number: number;
  login?: string;
  name?: string;
}): void {
  db.upsert('gh_commits', {
    host: 'github.com',
    repo_id: 1,
    repo_full_name: 'acme/platform',
    sha: row.sha,
    pr_id: row.prId,
    pr_number: row.number,
    message: 'work',
    author_name: row.name ?? null,
    author_login: row.login ?? null,
    authored_at: '2024-03-02T09:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
  });
}

function workitem(row: {
  key: string;
  creator?: string;
  reporter?: string;
  assignee?: string;
  parent?: string;
  type?: string;
}): void {
  db.upsert('jira_workitems', {
    site: 'acme',
    id: row.key,
    key: row.key,
    project_key: 'PLAT',
    summary: row.key,
    type: row.type ?? 'Story',
    status: 'To Do',
    creator: row.creator ?? null,
    reporter: row.reporter ?? null,
    assignee: row.assignee ?? null,
    parent_key: row.parent ?? null,
    created_at: '2024-03-01T10:00:00Z',
    updated_at: '2024-03-05T10:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
  });
}

function rolesFor(ref: string, identity: string): string[] {
  return contributionsOf(db, [ref])
    .filter((row) => row.identity === identity)
    .map((row) => row.role);
}

describe('the roles', () => {
  it('explains every one of them', () => {
    // A role nobody can read is a flag nobody can act on.
    for (const role of CONTRIBUTOR_ROLES) {
      expect([role, (ROLE_DESCRIPTIONS[role] ?? '').length > 5]).toEqual([role, true]);
    }
  });
});

describe('a pull request', () => {
  beforeEach(() => {
    pull({ id: 42, number: 42, author: 'ada', requested: ['torvalds'], mergedBy: 'ghopper' });
    review({ id: 1, prId: 42, number: 42, author: 'ghopper' });
    reviewComment({ id: 2, prId: 42, number: 42, author: 'ghopper' });
    comment({ id: 3, issueId: 42, number: 42, author: 'linus', at: '2024-03-03T09:00:00Z' });
    comment({ id: 4, issueId: 42, number: 42, author: 'linus', at: '2024-03-04T09:00:00Z' });
    commit({ sha: 'aaa', prId: 42, number: 42, login: 'ada' });
    commit({ sha: 'bbb', prId: 42, number: 42, login: 'ada' });
    buildContributors(db);
  });

  it('separates writing it, reviewing it and merging it', () => {
    /*
     * The whole point of the capacity. "Involved" would flatten all three, and
     * no question anybody asks of this list treats them the same.
     */
    expect(rolesFor('acme/platform#42', 'ada').toSorted()).toEqual(['author', 'committer']);
    expect(rolesFor('acme/platform#42', 'ghopper').toSorted()).toEqual([
      'commenter',
      'merged_by',
      'reviewer',
    ]);
    expect(rolesFor('acme/platform#42', 'ghopper')).not.toContain('author');
    expect(rolesFor('acme/platform#42', 'linus')).toEqual(['commenter']);
  });

  it('does not call somebody a reviewer for having been asked', () => {
    // GitHub drops a login from requested_reviewers the moment they submit, so
    // what is left is the outstanding asks. Calling it a review would say
    // somebody looked at a pull request they have not opened.
    expect(rolesFor('acme/platform#42', 'torvalds')).toEqual(['review_requested']);
  });

  it('counts how many times, not just whether', () => {
    // The difference between having been present and having carried it.
    const rows = contributionsOf(db, ['acme/platform#42']);
    const commenter = rows.find((row) => row.identity === 'linus' && row.role === 'commenter');
    const committer = rows.find((row) => row.role === 'committer');

    expect(commenter?.events).toBe(2);
    expect(committer?.events).toBe(2);
  });

  it('adds up one person commenting in two places rather than losing one', () => {
    /*
     * A note on the diff and a note on the conversation are both comments and
     * live in different tables. Inserted separately, the second would replace
     * the first and a reviewer who said ten things would read as having said
     * one.
     */
    reviewComment({ id: 5, prId: 42, number: 42, author: 'linus' });
    buildContributors(db);

    const linus = contributionsOf(db, ['acme/platform#42']).find(
      (row) => row.identity === 'linus' && row.role === 'commenter',
    );

    expect(linus?.events).toBe(3);
  });

  it('keeps a commit from an unmatched email, under the name on it', () => {
    // GitHub could not match the address to an account. It is still work
    // somebody did, and dropping it would silently shrink the list.
    commit({ sha: 'ccc', prId: 42, number: 42, name: 'Grace Hopper' });
    buildContributors(db);

    expect(rolesFor('acme/platform#42', 'Grace Hopper')).toEqual(['committer']);
  });

  it('rolls one person up across their capacities, busiest first', () => {
    const people = contributorsOf(db, ['acme/platform#42']);

    expect(people[0]?.identity).toBe('ada');
    expect(people.map((person) => person.identity)).toEqual([
      'ada',
      'ghopper',
      'linus',
      'torvalds',
    ]);
    expect(people[0]?.roles).toEqual(['author', 'committer']);
  });
});

describe('a work item', () => {
  it('names the reporter only when it is not the creator', () => {
    /*
     * Jira sets both to the same person on most tickets, and a role that
     * repeats the author on every row says nothing. When they differ it says
     * something real: somebody filed this for somebody else.
     */
    workitem({ key: 'PLAT-1', creator: 'Grace Hopper', reporter: 'Grace Hopper' });
    workitem({ key: 'PLAT-2', creator: 'Grace Hopper', reporter: 'Ada Lovelace' });
    buildContributors(db);

    expect(rolesFor('PLAT-1', 'Grace Hopper')).toEqual(['author']);
    expect(rolesFor('PLAT-2', 'Grace Hopper')).toEqual(['author']);
    expect(rolesFor('PLAT-2', 'Ada Lovelace')).toEqual(['reporter']);
  });

  it('counts logged work, which is the only record of somebody who was not the assignee', () => {
    workitem({ key: 'PLAT-1', creator: 'Grace Hopper', assignee: 'Grace Hopper' });
    db.upsert('jira_worklogs', {
      site: 'acme',
      id: 'w1',
      workitem_id: 'PLAT-1',
      workitem_key: 'PLAT-1',
      author: 'Ada Lovelace',
      started_at: '2024-03-04T10:00:00Z',
      time_spent_seconds: 3600,
      synced_at: SYNCED,
      raw: '{}',
    });
    buildContributors(db);

    expect(rolesFor('PLAT-1', 'Ada Lovelace')).toEqual(['worked']);
  });
});

describe('an epic', () => {
  beforeEach(() => {
    // An epic nobody works on directly, a story beneath it, and the pull
    // request that actually implemented the story.
    workitem({ key: 'PLAT-100', creator: 'Product Owner', type: 'Epic' });
    workitem({
      key: 'PLAT-101',
      creator: 'Grace Hopper',
      assignee: 'Ada Lovelace',
      parent: 'PLAT-100',
    });
    pull({ id: 7, number: 7, author: 'linus' });
    review({ id: 1, prId: 7, number: 7, author: 'torvalds' });
    db.upsert('cross_links', {
      uid: 'PLAT-101|acme/platform#7|branch',
      from_source: 'jira',
      from_kind: 'workitem',
      from_ref: 'PLAT-101',
      to_source: 'github',
      to_kind: 'pull_request',
      to_ref: 'acme/platform#7',
      via: 'branch',
      confidence: 'high',
      synced_at: SYNCED,
    });
    buildContributors(db);
  });

  it('answers with the heading alone when asked about itself', () => {
    // True, and useless — which is why the rollup exists.
    expect(contributorsOf(db, ['PLAT-100']).map((row) => row.identity)).toEqual(['Product Owner']);
  });

  it('reaches the people who wrote and reviewed the code beneath it', () => {
    /*
     * Two hops: down the parent link to the story, then across the cross
     * reference to the pull request. There is no other route from a Jira key
     * to the person who reviewed the implementation.
     */
    const everyone = contributorsOf(db, descendantsOf(db, 'PLAT-100')).map((row) => row.identity);

    expect(everyone.toSorted()).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
      'Product Owner',
      'linus',
      'torvalds',
    ]);
  });

  it('stops rather than looping when a parent chain points at itself', () => {
    // Rare and entirely possible. A builder that hangs on it would be worse
    // than one that stops a level short.
    workitem({ key: 'PLAT-100', creator: 'Product Owner', type: 'Epic', parent: 'PLAT-101' });

    expect(descendantsOf(db, 'PLAT-100')).toContain('PLAT-101');
    expect(descendantsOf(db, 'PLAT-100').length).toBeLessThan(10);
  });
});

describe('rebuilding', () => {
  it('forgets a reviewer who was taken off the pull request', () => {
    /*
     * Rebuilt rather than appended to, for the same reason the state history
     * is. A table that only ever grows would keep answering with people who
     * are no longer on the work.
     */
    pull({ id: 42, number: 42, author: 'ada', requested: ['torvalds'] });
    buildContributors(db);
    expect(rolesFor('acme/platform#42', 'torvalds')).toEqual(['review_requested']);

    pull({ id: 42, number: 42, author: 'ada', requested: [] });
    buildContributors(db);

    expect(rolesFor('acme/platform#42', 'torvalds')).toEqual([]);
  });

  it('does not double the counts when it runs twice', () => {
    pull({ id: 42, number: 42, author: 'ada' });
    comment({ id: 3, issueId: 42, number: 42, author: 'linus', at: '2024-03-03T09:00:00Z' });
    buildContributors(db);
    buildContributors(db);

    const linus = contributionsOf(db, ['acme/platform#42']).find((row) => row.identity === 'linus');

    expect(linus?.events).toBe(1);
  });
});
