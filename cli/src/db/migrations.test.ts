/**
 * Upgrading a database that already holds data.
 *
 * The failure mode here is expensive rather than wrong: get the backfill
 * wrong and the first sync after upgrading refetches the comments and
 * timeline of every issue in the window — on a large repository, tens of
 * thousands of requests nobody asked for, to rebuild rows that were already
 * correct. Nothing about that looks like a bug while it is happening.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from './database.js';
import { backfillDetailParts, ensureColumn, migrateFrom } from './migrations.js';
import { SCHEMA_VERSION } from './schema.js';

let db: Database;

const SYNCED = '2026-06-01T00:00:00.000Z';

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
});

afterEach(() => {
  db.close();
});

function issue(row: { id: number; number: number; pull?: boolean; repo?: string }): void {
  db.upsert('gh_issues', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: row.repo ?? 'acme/platform',
    number: row.number,
    title: `Item ${String(row.number)}`,
    state: 'open',
    author: 'ada',
    assignees: '[]',
    is_pull_request: row.pull ?? false,
    created_at: '2026-03-01T09:00:00Z',
    updated_at: '2026-03-05T09:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
  });
}

/** Puts a row back the way an older devcontext left it. */
function asBeforeUpgrade(): void {
  db.run('UPDATE gh_issues SET details_parts = NULL, details_synced_at = NULL');
}

function partsOf(number: number): { parts: string | null; when: string | null } {
  const row = db.get<{ details_parts: string | null; details_synced_at: string | null }>(
    'SELECT details_parts, details_synced_at FROM gh_issues WHERE number = ?',
    [number],
  );
  return { parts: row?.details_parts ?? null, when: row?.details_synced_at ?? null };
}

describe('adding a column', () => {
  it('does nothing when it is already there', () => {
    expect(ensureColumn(db, 'gh_issues', 'details_parts', 'TEXT')).toBe(false);
  });

  it('says nothing about a table that does not exist', () => {
    // A step running against a database built by an older schema, before the
    // table it names was introduced. Throwing there would strand the upgrade.
    expect(ensureColumn(db, 'gh_not_a_table', 'whatever', 'TEXT')).toBe(false);
  });
});

describe('backfilling what was already fetched', () => {
  it('infers the resources from what the repository actually holds', () => {
    /*
     * Per repository, not per item. These are repository-level settings: if
     * any issue has a stored comment then comments were being fetched, however
     * many any individual issue happens to have.
     */
    issue({ id: 1, number: 1 });
    db.upsert('gh_comments', {
      host: 'github.com',
      id: 10,
      repo_id: 1,
      repo_full_name: 'acme/platform',
      issue_id: 1,
      issue_number: 1,
      author: 'ada',
      body: 'hello',
      created_at: '2026-03-02T09:00:00Z',
      synced_at: SYNCED,
      raw: '{}',
    });
    asBeforeUpgrade();

    backfillDetailParts(db);

    expect(partsOf(1).parts).toBe(JSON.stringify(['comments']));
    expect(partsOf(1).when).toBe(SYNCED);
  });

  it('does not credit an issue with a timeline the repository never fetched', () => {
    /*
     * The half that matters. If this claimed 'timeline', turning
     * issueTimeline on afterwards would still never fetch one — which is the
     * exact bug the parts column exists to close.
     */
    issue({ id: 1, number: 1 });
    asBeforeUpgrade();

    backfillDetailParts(db);

    expect(partsOf(1).parts).toBe(JSON.stringify([]));
  });

  it('gives a pull request the larger set it needs', () => {
    // A pull request wants everything an issue does and its own resources on
    // top, so stamping it with the issue set would refetch every one of them.
    issue({ id: 2, number: 2, pull: true });
    db.upsert('gh_reviews', {
      host: 'github.com',
      id: 20,
      repo_id: 1,
      repo_full_name: 'acme/platform',
      pr_id: 2,
      pr_number: 2,
      author: 'ghopper',
      state: 'APPROVED',
      submitted_at: '2026-03-04T10:00:00Z',
      synced_at: SYNCED,
      raw: '{}',
    });
    asBeforeUpgrade();

    backfillDetailParts(db);

    expect(partsOf(2).parts).toBe(JSON.stringify(['reviews']));
  });

  it('leaves alone anything already stamped', () => {
    // It runs inside a migration that is safe to repeat, and a second pass
    // must not overwrite what a real sync has since recorded.
    issue({ id: 1, number: 1 });
    db.run(
      `UPDATE gh_issues SET details_parts = '["comments","timeline"]', details_synced_at = ?`,
      ['2026-07-01T00:00:00.000Z'],
    );

    backfillDetailParts(db);

    expect(partsOf(1).parts).toBe('["comments","timeline"]');
    expect(partsOf(1).when).toBe('2026-07-01T00:00:00.000Z');
  });

  it('keeps repositories apart', () => {
    // One repository fetching comments says nothing about another.
    issue({ id: 1, number: 1 });
    issue({ id: 3, number: 3, repo: 'acme/other' });
    db.upsert('gh_comments', {
      host: 'github.com',
      id: 10,
      repo_id: 1,
      repo_full_name: 'acme/platform',
      issue_id: 1,
      issue_number: 1,
      author: 'ada',
      body: 'hello',
      created_at: '2026-03-02T09:00:00Z',
      synced_at: SYNCED,
      raw: '{}',
    });
    asBeforeUpgrade();

    backfillDetailParts(db);

    expect(partsOf(1).parts).toBe(JSON.stringify(['comments']));
    expect(partsOf(3).parts).toBe(JSON.stringify([]));
  });
});

describe('dropping worklogs', () => {
  it('removes the table from a database that still has it', () => {
    /*
     * Nothing writes to it and nothing reads it. Left behind it is worse than
     * no table: rows that get older and more wrong every day while still
     * answering a hand-written query as though they were current.
     */
    db.exec(`CREATE TABLE IF NOT EXISTS jira_worklogs (site TEXT, id TEXT, author TEXT)`);
    db.run(`INSERT INTO jira_worklogs VALUES ('acme', '1', 'ada')`);

    migrateFrom(db, 4);

    expect(db.all(`SELECT name FROM sqlite_master WHERE name = 'jira_worklogs'`)).toEqual([]);
  });

  it('says nothing when it was never there', () => {
    // A fresh database has never had the table, and a migration that threw on
    // that would strand every new install.
    expect(() => migrateFrom(db, 1)).not.toThrow();
  });

  it('is not recreated by the schema', () => {
    // The DDL is gone too, so opening the database again must not bring it
    // back — which is exactly what would happen if only the migration changed.
    db.migrate();

    expect(db.all(`SELECT name FROM sqlite_master WHERE name = 'jira_worklogs'`)).toEqual([]);
  });
});

describe('a fresh database', () => {
  it('is stamped with the current schema and needs no migration', () => {
    expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
  });
});
