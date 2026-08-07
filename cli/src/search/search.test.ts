import { afterEach, beforeEach, describe as suite, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import { searchWorkitems } from '../db/queries/jira.js';
import { buildSearchIndex, searchAll, searchIndexAvailable } from './index.js';
import { toMatchQuery } from './query.js';

let db: Database;
const SYNCED = '2026-08-01T00:00:00.000Z';

function addIssue(number: number, fields: Record<string, unknown> = {}): void {
  db.upsert('gh_issues', {
    host: 'github.com',
    id: 2000 + number,
    repo_id: 7,
    repo_full_name: 'acme/platform',
    number,
    state: 'open',
    is_pull_request: 0,
    assignees: '[]',
    labels: '[]',
    updated_at: '2026-07-01T00:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
    ...fields,
  } as Record<string, never>);
}

function addPull(number: number, fields: Record<string, unknown> = {}): void {
  db.upsert('gh_pull_requests', {
    host: 'github.com',
    id: 1000 + number,
    repo_id: 7,
    repo_full_name: 'acme/platform',
    number,
    state: 'open',
    assignees: '[]',
    requested_reviewers: '[]',
    labels: '[]',
    updated_at: '2026-07-01T00:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
    ...fields,
  } as Record<string, never>);
}

function addComment(id: number, issueId: number, body: string): void {
  db.upsert('gh_comments', {
    host: 'github.com',
    id,
    repo_id: 7,
    repo_full_name: 'acme/platform',
    issue_id: issueId,
    body,
    created_at: '2026-07-02T00:00:00Z',
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
    status: 'To Do',
    status_category: 'To Do',
    labels: '[]',
    components: '[]',
    fix_versions: '[]',
    custom_fields: '{}',
    updated_at: '2026-07-01T00:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
    ...fields,
  } as Record<string, never>);
}

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
});

afterEach(() => db.close());

suite('toMatchQuery', () => {
  it('quotes terms so FTS5 operators cannot leak in', () => {
    // Unquoted, `PLAT-42` would mean "PLAT not 42" and `a:b` is a syntax error.
    expect(toMatchQuery('PLAT-42', { prefixLast: false })).toBe('"PLAT-42"');
    expect(toMatchQuery('field:value', { prefixLast: false })).toBe('"field:value"');
    expect(toMatchQuery('NEAR', { prefixLast: false })).toBe('"NEAR"');
  });

  it('requires every term', () => {
    expect(toMatchQuery('rate limit', { prefixLast: false })).toBe('"rate" AND "limit"');
  });

  it('makes the last term a prefix so results appear while typing', () => {
    expect(toMatchQuery('rate lim')).toBe('"rate" AND "lim"*');
  });

  it('keeps a quoted phrase exact', () => {
    expect(toMatchQuery('"rate limit"')).toBe('"rate limit"');
    expect(toMatchQuery('sync "rate limit"')).toBe('"sync" AND "rate limit"');
  });

  it('escapes a quote inside a term', () => {
    expect(toMatchQuery('say"hi', { prefixLast: false })).toBe('"say""hi"');
  });

  it('returns null for nothing to search for', () => {
    expect(toMatchQuery('')).toBeNull();
    expect(toMatchQuery('   ')).toBeNull();
  });
});

suite('buildSearchIndex', () => {
  it('is available on this build', () => {
    // The whole point of the fallback is that this can be false elsewhere.
    expect(searchIndexAvailable(db)).toBe(true);
  });

  it('indexes issues, pull requests and work items', () => {
    addIssue(1, { title: 'Sync is slow' });
    addPull(2, { title: 'Speed up the sync' });
    addWorkitem('PLAT-1', { summary: 'Investigate the sync' });

    expect(buildSearchIndex(db)).toMatchObject({
      rows: 3,
      issues: 1,
      pullRequests: 1,
      workitems: 1,
    });
  });

  it('replaces the previous contents rather than appending', () => {
    addIssue(1, { title: 'First' });
    buildSearchIndex(db);
    buildSearchIndex(db);

    expect(db.count('search_index')).toBe(1);
  });

  it('only touches what changed when given a timestamp', () => {
    addIssue(1, { title: 'Old and untouched', synced_at: '2026-01-01T00:00:00Z' });
    addIssue(2, { title: 'Written by this run', synced_at: '2026-08-01T00:00:00Z' });

    expect(buildSearchIndex(db, { since: '2026-07-01T00:00:00Z' })).toMatchObject({
      rows: 1,
      issues: 1,
    });
    expect(searchAll(db, 'untouched')).toHaveLength(0);
    expect(searchAll(db, 'Written').map((hit) => hit.ref)).toEqual(['acme/platform#2']);
  });

  it('reindexes an item whose comment changed, not only its own row', () => {
    addIssue(1, { title: 'Quiet issue', synced_at: '2026-01-01T00:00:00Z' });
    buildSearchIndex(db);
    addComment(50, 2001, 'A new comment about throttling.');
    db.run(`UPDATE gh_comments SET synced_at = '2026-08-01T00:00:00Z' WHERE id = 50`);

    buildSearchIndex(db, { since: '2026-07-01T00:00:00Z' });

    expect(searchAll(db, 'throttling').map((hit) => hit.ref)).toEqual(['acme/platform#1']);
  });

  it('replaces rather than duplicates an entry on an incremental pass', () => {
    addIssue(1, { title: 'First title', synced_at: '2026-08-01T00:00:00Z' });
    buildSearchIndex(db);
    addIssue(1, { title: 'Second title', synced_at: '2026-08-02T00:00:00Z' });

    buildSearchIndex(db, { since: '2026-08-02T00:00:00Z' });

    expect(db.count('search_index')).toBe(1);
    expect(searchAll(db, 'First')).toHaveLength(0);
    expect(searchAll(db, 'Second')).toHaveLength(1);
  });

  it('drops an item that is no longer in the database', () => {
    addIssue(1, { title: 'Temporary' });
    buildSearchIndex(db);
    db.run('DELETE FROM gh_issues WHERE number = 1');
    buildSearchIndex(db);

    expect(searchAll(db, 'Temporary')).toHaveLength(0);
  });
});

suite('searchAll', () => {
  beforeEach(() => {
    addIssue(1, { title: 'Sync is slow', body: 'It hangs on the rate limit.', author: 'alice' });
    addIssue(2, { title: 'Unrelated', body: 'Nothing to see.', author: 'bob' });
    addComment(50, 2002, 'The rate limit reset header is what matters here.');
    addPull(3, { title: 'Respect the rate limit', author: 'cleo', head_ref: 'fix/limiter' });
    addWorkitem('PLAT-1', {
      summary: 'Rate limiting is wrong',
      description: 'See the GitHub docs.',
      assignee: 'Alice',
    });
    buildSearchIndex(db);
  });

  it('finds items across both platforms', () => {
    const refs = searchAll(db, 'rate limit').map((hit) => hit.ref);
    expect(refs).toContain('acme/platform#1');
    expect(refs).toContain('acme/platform#3');
    expect(refs).toContain('PLAT-1');
  });

  it('finds an item through its comments', () => {
    // Issue 2 says nothing about rate limits; only its comment does.
    expect(searchAll(db, '"reset header"').map((hit) => hit.ref)).toEqual(['acme/platform#2']);
  });

  it('ranks a title hit above a comment hit', () => {
    const refs = searchAll(db, 'rate limit').map((hit) => hit.ref);
    expect(refs.indexOf('acme/platform#3')).toBeLessThan(refs.indexOf('acme/platform#2'));
  });

  it('returns the matching text', () => {
    const [hit] = searchAll(db, '"reset header"');
    expect(hit?.snippet).toContain('[reset header]');
  });

  it('finds a pull request by its branch', () => {
    expect(searchAll(db, 'limiter').map((hit) => hit.ref)).toContain('acme/platform#3');
  });

  it('finds items by the people on them', () => {
    expect(searchAll(db, 'cleo').map((hit) => hit.ref)).toEqual(['acme/platform#3']);
  });

  it('restricts to a kind', () => {
    const hits = searchAll(db, 'rate limit', { kinds: ['workitem'] });
    expect(hits.map((hit) => hit.ref)).toEqual(['PLAT-1']);
  });

  it('restricts to a repository or project', () => {
    expect(searchAll(db, 'rate limit', { containers: ['PLAT'] }).map((hit) => hit.ref)).toEqual([
      'PLAT-1',
    ]);
    expect(searchAll(db, 'rate limit', { containers: ['acme/other'] })).toEqual([]);
  });

  it('matches a prefix while typing', () => {
    expect(searchAll(db, 'limi').length).toBeGreaterThan(0);
    expect(searchAll(db, 'limi', { prefix: false })).toEqual([]);
  });

  it('treats a reference with a dash as literal text', () => {
    // Unquoted this would be "PLAT not 1" and would match nothing useful.
    expect(searchAll(db, 'PLAT-1').map((hit) => hit.ref)).toEqual(['PLAT-1']);
  });

  it('returns nothing for an empty query', () => {
    expect(searchAll(db, '   ')).toEqual([]);
  });

  it('honours the limit and offset', () => {
    const all = searchAll(db, 'rate limit');
    expect(searchAll(db, 'rate limit', { limit: 1 })).toHaveLength(1);
    expect(searchAll(db, 'rate limit', { limit: 1, offset: 1 })[0]?.ref).toBe(all[1]?.ref);
  });
});

suite('searchWorkitems', () => {
  beforeEach(() => {
    addWorkitem('PLAT-1', { summary: 'Rate limiting is wrong', status_category: 'To Do' });
    addWorkitem('PLAT-2', { summary: 'Something else', status_category: 'Done' });
    db.upsert('jira_comments', {
      site: 'acme',
      id: 'c1',
      workitem_id: 'PLAT-2',
      workitem_key: 'PLAT-2',
      body: 'This is also about the rate limit.',
      created_at: '2026-07-02T00:00:00Z',
      synced_at: SYNCED,
      raw: '{}',
    });
    buildSearchIndex(db);
  });

  it('searches summaries and comments through the index', () => {
    const keys = searchWorkitems(db, 'rate limit').map((row) => row.key);
    expect(keys).toEqual(expect.arrayContaining(['PLAT-1', 'PLAT-2']));
  });

  it('still applies the other filters', () => {
    expect(
      searchWorkitems(db, 'rate limit', { statusCategories: ['Done'] }).map((row) => row.key),
    ).toEqual(['PLAT-2']);
  });

  it('falls back to scanning when there is no index', () => {
    db.exec('DROP TABLE search_index');
    expect(searchWorkitems(db, 'rate limit').map((row) => row.key)).toEqual(
      expect.arrayContaining(['PLAT-1', 'PLAT-2']),
    );
  });
});

suite('fallback search', () => {
  it('answers without an index', () => {
    addIssue(1, { title: 'Sync is slow' });
    addWorkitem('PLAT-1', { summary: 'Sync is also slow' });
    db.exec('DROP TABLE search_index');

    const refs = searchAll(db, 'slow').map((hit) => hit.ref);
    expect(refs).toEqual(expect.arrayContaining(['acme/platform#1', 'PLAT-1']));
    expect(searchAll(db, 'slow')[0]?.score).toBeNull();
  });

  it('reports that the index is missing', () => {
    db.exec('DROP TABLE search_index');
    expect(searchIndexAvailable(db)).toBe(false);
  });

  it('is used when the index exists but has never been built', () => {
    // A database synced before the index existed has the rows but no entries;
    // answering "nothing found" from the empty index would be wrong.
    addIssue(1, { title: 'Sync is slow' });
    expect(db.count('search_index')).toBe(0);

    expect(searchAll(db, 'slow').map((hit) => hit.ref)).toEqual(['acme/platform#1']);
  });

  it('finds pull requests, which are not only rows in gh_issues', () => {
    addPull(3, { title: 'Speed up the sync' });
    db.exec('DROP TABLE search_index');

    expect(searchAll(db, 'speed').map((hit) => hit.ref)).toEqual(['acme/platform#3']);
  });

  it('still finds items through their comments and reviews', () => {
    addIssue(1, { title: 'Unrelated' });
    addComment(50, 2001, 'Actually about the rate limit.');
    addPull(3, { title: 'Also unrelated' });
    db.upsert('gh_reviews', {
      host: 'github.com',
      id: 9,
      repo_id: 7,
      repo_full_name: 'acme/platform',
      pr_id: 1003,
      pr_number: 3,
      author: 'bob',
      body: 'This changes the rate limit handling.',
      submitted_at: '2026-07-02T00:00:00Z',
      synced_at: SYNCED,
      raw: '{}',
    });
    addWorkitem('PLAT-1', { summary: 'Nothing to do with it' });
    db.upsert('jira_comments', {
      site: 'acme',
      id: 'c1',
      workitem_id: 'PLAT-1',
      workitem_key: 'PLAT-1',
      body: 'The rate limit is the cause.',
      created_at: '2026-07-02T00:00:00Z',
      synced_at: SYNCED,
      raw: '{}',
    });
    db.exec('DROP TABLE search_index');

    const refs = searchAll(db, 'rate limit').map((hit) => hit.ref);
    expect(refs).toEqual(expect.arrayContaining(['acme/platform#1', 'acme/platform#3', 'PLAT-1']));
  });
});
