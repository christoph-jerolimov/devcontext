import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../database.js';
import * as gh from './github.js';
import * as jira from './jira.js';
import { countTickets, listTickets, ticketContainers, ticketTypes } from './tickets.js';

let workspace: string;
let db: Database;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'devcontext-tickets-'));
  db = Database.openAndMigrate(join(workspace, 'devcontext.db'));

  issue({ number: 1, id: 1, state: 'open', title: 'Sync stalls' });
  issue({ number: 2, id: 2, state: 'closed', title: 'Document the limiter' });
  // A repository that adopted GitHub's typed issues, and one that did not.
  issue({ number: 3, id: 3, state: 'open', title: 'Crash on startup', type: 'Bug' });
  // A pull request, which is not a ticket and must never appear.
  issue({ number: 4, id: 4, state: 'open', title: 'Speed it up', pull: true });

  workitem({ key: 'PLAT-1', type: 'Epic', status: 'In Progress', category: 'In Progress' });
  workitem({ key: 'PLAT-2', type: 'Story', status: 'Done', category: 'Done' });
  workitem({ key: 'PLAT-3', type: 'Bug', status: 'To Do', category: 'To Do' });
});

afterEach(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
});

function issue(row: {
  number: number;
  id: number;
  state: string;
  title: string;
  type?: string;
  pull?: boolean;
}): void {
  db.upsert('gh_issues', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: row.number,
    title: row.title,
    state: row.state,
    author: 'ada',
    assignees: JSON.stringify(['grace']),
    is_pull_request: row.pull ?? false,
    updated_at: `2024-03-0${String(row.number)}T00:00:00Z`,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: JSON.stringify(row.type ? { type: { name: row.type } } : {}),
  });
}

function workitem(row: { key: string; type: string; status: string; category: string }): void {
  db.upsert('jira_workitems', {
    site: 'acme',
    id: row.key,
    key: row.key,
    project_key: 'PLAT',
    summary: `Work item ${row.key}`,
    type: row.type,
    status: row.status,
    status_category: row.category,
    assignee: 'Ada',
    reporter: 'Grace',
    updated_at: '2024-03-10T00:00:00Z',
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

describe('listTickets', () => {
  it('puts both sources in one list, newest first', () => {
    const rows = listTickets(db);

    expect(rows.map((row) => row.ref)).toEqual([
      'PLAT-1',
      'PLAT-2',
      'PLAT-3',
      'acme/platform#3',
      'acme/platform#2',
      'acme/platform#1',
    ]);
    expect(new Set(rows.map((row) => row.source))).toEqual(new Set(['github', 'jira']));
  });

  it('leaves pull requests out, since a change is not a request for one', () => {
    expect(listTickets(db).some((row) => row.ref === 'acme/platform#4')).toBe(false);
    // ...and the pull request really is there to be excluded.
    expect(gh.listPullRequests(db, { state: 'all' })).toHaveLength(0);
    expect(gh.listIssues(db, { state: 'all' }).some((row) => row.number === 4)).toBe(false);
  });

  it('adds up to what the two separate lists hold', () => {
    /*
     * The point of the merged list is that it is the same tickets, not a
     * different selection of them. Counting each side separately is the only
     * check that survives someone rewriting the union.
     */
    const issues = gh.listIssues(db, { state: 'all' }).length;
    const workitems = jira.listWorkitems(db, {}).length;

    expect(countTickets(db)).toBe(issues + workitems);
    expect(countTickets(db, { sources: ['github'] })).toBe(issues);
    expect(countTickets(db, { sources: ['jira'] })).toBe(workitems);
  });

  it('normalises both sides to open or closed while keeping the original word', () => {
    const rows = listTickets(db);
    const byRef = Object.fromEntries(rows.map((row) => [row.ref, row]));

    // Jira has no open flag, only a status category.
    expect(byRef['PLAT-1']).toMatchObject({ state: 'open', status: 'In Progress' });
    expect(byRef['PLAT-2']).toMatchObject({ state: 'closed', status: 'Done' });
    expect(byRef['PLAT-3']).toMatchObject({ state: 'open', status: 'To Do' });
    expect(byRef['acme/platform#2']).toMatchObject({ state: 'closed', status: 'closed' });
  });

  it('filters by state across both sources at once', () => {
    const open = listTickets(db, { state: 'open' });
    expect(open.map((row) => row.ref).toSorted()).toEqual([
      'PLAT-1',
      'PLAT-3',
      'acme/platform#1',
      'acme/platform#3',
    ]);
  });

  it('filters by container, mixing repositories and projects freely', () => {
    expect(listTickets(db, { containers: ['PLAT'] }).every((row) => row.source === 'jira')).toBe(
      true,
    );
    expect(listTickets(db, { containers: ['acme/platform', 'PLAT'] })).toHaveLength(6);
  });
});

describe('ticketTypes', () => {
  it('reads the types off the data rather than a list somewhere', () => {
    expect(ticketTypes(db)).toEqual([
      { source: 'github', type: 'Issue', count: 2 },
      // Both sides have a Bug; the order between them is settled by source so
      // the list cannot reshuffle between two identical requests.
      { source: 'github', type: 'Bug', count: 1 },
      { source: 'jira', type: 'Bug', count: 1 },
      { source: 'jira', type: 'Epic', count: 1 },
      { source: 'jira', type: 'Story', count: 1 },
    ]);
  });

  it('calls an untyped GitHub issue an Issue rather than nothing', () => {
    // Most repositories never adopted GitHub's issue types. A blank entry in a
    // type filter that matches nearly everything is worse than a plain word.
    const github = ticketTypes(db, { sources: ['github'] });
    expect(github.find((row) => row.type === 'Issue')?.count).toBe(2);
    expect(github.some((row) => row.type === '')).toBe(false);
  });

  it('counts what the other filters left, so the numbers match the list', () => {
    const open = ticketTypes(db, { state: 'open' });
    const total = open.reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(countTickets(db, { state: 'open' }));
  });

  it('ignores the type filter, or every type would only ever show itself', () => {
    expect(ticketTypes(db, { types: ['Bug'] })).toEqual(ticketTypes(db));
  });
});

describe('ticketContainers', () => {
  it('lists every repository and project that has a ticket', () => {
    expect(ticketContainers(db)).toEqual([
      { source: 'github', container: 'acme/platform', count: 3 },
      { source: 'jira', container: 'PLAT', count: 3 },
    ]);
  });
});
