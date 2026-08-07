import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from './database.js';
import { SyncJournal } from './journal.js';
import * as gh from './queries/github.js';
import * as jira from './queries/jira.js';
import { buildIssueDocument } from '../documents/github.js';
import { buildWorkitemDocument } from '../documents/jira.js';

let db: Database;

const SYNCED_AT = '2024-06-15T12:00:00.000Z';

function insertIssue(overrides: Record<string, unknown> = {}): void {
  db.upsert('gh_issues', {
    host: 'github.com',
    id: 1,
    repo_id: 7,
    repo_full_name: 'acme/platform',
    number: 12,
    title: 'Sync is slow',
    body: 'It takes ages',
    state: 'open',
    author: 'alice',
    assignees: JSON.stringify(['bob']),
    labels: JSON.stringify(['bug', 'performance']),
    comment_count: 1,
    is_pull_request: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-02-01T00:00:00Z',
    html_url: 'https://github.com/acme/platform/issues/12',
    synced_at: SYNCED_AT,
    raw: '{}',
    ...overrides,
  } as Record<string, never>);
}

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
});

afterEach(() => {
  db.close();
});

describe('schema', () => {
  it('creates every table the sync writes to', () => {
    const expected = [
      'gh_repositories',
      'gh_issues',
      'gh_comments',
      'gh_events',
      'gh_pull_requests',
      'gh_reviews',
      'gh_review_comments',
      'gh_commits',
      'gh_workflow_runs',
      'gh_workflow_jobs',
      'gh_workflow_steps',
      'gh_job_logs',
      'jira_workitems',
      'jira_comments',
      'jira_changelog',
      'jira_sprints',
      'sync_runs',
      'sync_operations',
      'sync_state',
    ];

    // Asserting on the list of missing tables names all of them at once.
    expect(expected.filter((table) => !db.tableExists(table))).toEqual([]);
  });

  it('records the schema version', () => {
    expect(db.getMeta('schema_version')).toBe('1');
  });
});

describe('upsert', () => {
  it('replaces a row with the same primary key instead of duplicating it', () => {
    insertIssue();
    insertIssue({ title: 'Sync is still slow', updated_at: '2024-03-01T00:00:00Z' });

    const issues = gh.listIssues(db, { state: 'all' });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toBe('Sync is still slow');
  });

  it('converts booleans into integers for SQLite', () => {
    insertIssue({ id: 2, number: 13, is_pull_request: true });

    const row = db.get<{ is_pull_request: number }>(
      'SELECT is_pull_request FROM gh_issues WHERE number = 13',
    );
    expect(row?.is_pull_request).toBe(1);
    // The issue list only contains real issues; pull requests have their own table.
    expect(gh.listIssues(db, { state: 'all' })).toHaveLength(0);
  });
});

describe('github queries', () => {
  beforeEach(() => {
    insertIssue();
    insertIssue({
      id: 2,
      number: 13,
      title: 'Old and forgotten',
      body: 'Nothing to see here',
      state: 'closed',
      author: 'carol',
      labels: JSON.stringify(['docs']),
      assignees: '[]',
      created_at: '2022-01-01T00:00:00Z',
      updated_at: '2022-02-01T00:00:00Z',
    });
  });

  it('filters by state', () => {
    expect(gh.listIssues(db, { state: 'open' }).map((row) => row.number)).toEqual([12]);
    expect(gh.listIssues(db, { state: 'closed' }).map((row) => row.number)).toEqual([13]);
    expect(gh.listIssues(db, { state: 'all' })).toHaveLength(2);
  });

  it('filters by label, author and assignee', () => {
    expect(gh.listIssues(db, { state: 'all', labels: ['bug'] }).map((row) => row.number)).toEqual([
      12,
    ]);
    expect(gh.listIssues(db, { state: 'all', author: 'CAROL' }).map((row) => row.number)).toEqual([
      13,
    ]);
    expect(gh.listIssues(db, { state: 'all', assignee: 'bob' }).map((row) => row.number)).toEqual([
      12,
    ]);
  });

  it('filters stale items with updatedBefore', () => {
    const stale = gh.listIssues(db, { state: 'all', updatedBefore: '2023-01-01T00:00:00Z' });
    expect(stale.map((row) => row.number)).toEqual([13]);
  });

  it('searches the title and body', () => {
    expect(gh.listIssues(db, { state: 'all', search: 'AGES' }).map((row) => row.number)).toEqual([
      12,
    ]);
  });

  it('honours limit and sort order', () => {
    const rows = gh.listIssues(db, { state: 'all', sort: 'number', order: 'asc', limit: 1 });
    expect(rows.map((row) => row.number)).toEqual([12]);
  });

  it('builds an issue document with comments and events', () => {
    db.upsert('gh_comments', {
      host: 'github.com',
      id: 5,
      repo_id: 7,
      repo_full_name: 'acme/platform',
      issue_id: 1,
      issue_number: 12,
      author: 'bob',
      body: 'Confirmed',
      created_at: '2024-01-05T00:00:00Z',
      synced_at: SYNCED_AT,
      raw: '{}',
    });
    db.upsert('gh_events', {
      host: 'github.com',
      uid: '900',
      repo_id: 7,
      repo_full_name: 'acme/platform',
      issue_id: 1,
      issue_number: 12,
      event: 'labeled',
      actor: 'alice',
      label: 'bug',
      created_at: '2024-01-02T00:00:00Z',
      synced_at: SYNCED_AT,
      raw: '{}',
    });

    const issue = gh.getIssue(db, 'acme/platform', 12)!;
    const document = buildIssueDocument(db, issue);
    const data = document.data as { comments: unknown[]; events: unknown[]; labels: string[] };

    expect(data.labels).toEqual(['bug', 'performance']);
    expect(data.comments).toHaveLength(1);
    expect(data.events).toHaveLength(1);
    expect(document.title).toBe('acme/platform#12 Sync is slow');
  });
});

describe('jira queries', () => {
  beforeEach(() => {
    db.upsert('jira_workitems', {
      site: 'acme',
      id: '10001',
      key: 'PLAT-42',
      project_key: 'PLAT',
      summary: 'Improve the sync',
      description: 'Body text',
      type: 'Story',
      status: 'In Progress',
      status_category: 'In Progress',
      assignee: 'Alice',
      labels: JSON.stringify(['backend']),
      components: '[]',
      fix_versions: '[]',
      story_points: 5,
      sprint_name: 'Sprint 7',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-02-01T00:00:00.000Z',
      custom_fields: JSON.stringify({ teamName: 'Platform' }),
      synced_at: SYNCED_AT,
      raw: '{}',
    });
    db.upsert('jira_workitems', {
      site: 'acme',
      id: '10002',
      key: 'PLAT-43',
      project_key: 'PLAT',
      summary: 'Write the docs',
      type: 'Task',
      status: 'Done',
      status_category: 'Done',
      resolved_at: '2024-03-01T00:00:00.000Z',
      labels: '[]',
      components: '[]',
      fix_versions: '[]',
      created_at: '2024-01-02T00:00:00.000Z',
      updated_at: '2024-03-01T00:00:00.000Z',
      custom_fields: '{}',
      synced_at: SYNCED_AT,
      raw: '{}',
    });
    db.upsert('jira_comments', {
      site: 'acme',
      id: '1',
      workitem_id: '10001',
      workitem_key: 'PLAT-42',
      author: 'Bob',
      body: 'The rate limit is the problem',
      created_at: '2024-01-10T00:00:00.000Z',
      synced_at: SYNCED_AT,
      raw: '{}',
    });
  });

  it('filters by type, status and resolution', () => {
    expect(jira.listWorkitems(db, { types: ['story'] }).map((row) => row.key)).toEqual(['PLAT-42']);
    expect(jira.listWorkitems(db, { statusCategories: ['done'] }).map((row) => row.key)).toEqual([
      'PLAT-43',
    ]);
    expect(jira.listWorkitems(db, { resolved: false }).map((row) => row.key)).toEqual(['PLAT-42']);
  });

  it('filters by label and sprint', () => {
    expect(jira.listWorkitems(db, { labels: ['backend'] }).map((row) => row.key)).toEqual([
      'PLAT-42',
    ]);
    expect(jira.listWorkitems(db, { sprint: 'sprint 7' }).map((row) => row.key)).toEqual([
      'PLAT-42',
    ]);
  });

  it('finds work items through their comments', () => {
    expect(jira.searchWorkitems(db, 'rate limit').map((row) => row.key)).toEqual(['PLAT-42']);
    expect(jira.searchWorkitems(db, 'docs').map((row) => row.key)).toEqual(['PLAT-43']);
    expect(jira.searchWorkitems(db, 'PLAT-43').map((row) => row.key)).toEqual(['PLAT-43']);
  });

  it('builds a work item document with comments and history', () => {
    db.upsert('jira_changelog', {
      site: 'acme',
      uid: '900:0',
      history_id: '900',
      workitem_id: '10001',
      workitem_key: 'PLAT-42',
      author: 'Alice',
      created_at: '2024-01-15T00:00:00.000Z',
      field: 'status',
      from_string: 'To Do',
      to_string: 'In Progress',
      synced_at: SYNCED_AT,
      raw: '{}',
    });

    const workitem = jira.getWorkitem(db, 'plat-42')!;
    const data = buildWorkitemDocument(db, workitem).data as {
      comments: unknown[];
      history: unknown[];
      customFields: Record<string, unknown>;
    };

    expect(data.comments).toHaveLength(1);
    expect(data.history).toHaveLength(1);
    expect(data.customFields).toEqual({ teamName: 'Platform' });
  });
});

describe('SyncJournal', () => {
  it('records runs, operations and cursors', () => {
    const journal = new SyncJournal(db);
    const runId = journal.startRun({
      projectKey: 'demo',
      source: 'github',
      target: 'acme/platform',
      mode: 'initial',
    });

    const operationId = journal.startOperation({
      runId,
      resource: 'issues',
      scope: 'github:github.com/acme/platform:issues',
      cursorBefore: null,
    });
    journal.finishOperation(operationId, {
      status: 'completed',
      apiCalls: 4,
      itemsSynced: 2,
      cursorAfter: '2024-02-01T00:00:00Z',
    });
    journal.setState({
      scope: 'github:github.com/acme/platform:issues',
      source: 'github',
      target: 'acme/platform',
      resource: 'issues',
      cursor: '2024-02-01T00:00:00Z',
      runId,
      fullSync: true,
    });
    journal.finishRun(runId, {
      status: 'completed',
      apiCalls: 4,
      apiCallsExpected: 4,
      itemsSynced: 2,
    });

    expect(journal.getCursor('github:github.com/acme/platform:issues')).toBe(
      '2024-02-01T00:00:00Z',
    );
    const [run] = journal.listRuns();
    expect(run?.status).toBe('completed');
    expect(run?.items_synced).toBe(2);
    expect(journal.listOperations(runId)).toHaveLength(1);
  });

  it('marks runs of a killed process as interrupted', () => {
    const journal = new SyncJournal(db);
    journal.startRun({ projectKey: null, source: 'jira', target: 'acme/PLAT', mode: 'initial' });

    expect(journal.markStaleRunsInterrupted()).toBe(1);
    expect(journal.listRuns()[0]?.status).toBe('interrupted');
  });
});
