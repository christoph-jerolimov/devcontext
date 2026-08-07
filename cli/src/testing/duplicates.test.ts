/**
 * The duplicate detector is the thing the end to end test now leans on, so it
 * gets pinned down here — offline, and without waiting on the GitHub API.
 *
 * Both directions matter. A check that never fires would pass every build
 * while proving nothing, and a check that fires on ordinary data would fail
 * builds for no reason.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import { SCHEMA_SQL } from '../db/schema.js';
import { duplicateEvents } from './duplicates.js';

let workspace: string;
let db: Database;

/** One timeline event, defaulting to "ada labelled issue 7 'bug' on new year". */
function insertEvent(uid: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    host: 'github.com',
    uid,
    id: null,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    issue_id: 7,
    issue_number: 7,
    event: 'labeled',
    actor: 'ada',
    created_at: '2026-01-01T00:00:00Z',
    label: 'bug',
    assignee: null,
    synced_at: '2026-01-01T00:00:00Z',
    raw: '{}',
    ...overrides,
  };

  const columns = Object.keys(row);
  db.run(
    `INSERT INTO gh_events (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((column) => row[column] as never),
  );
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'devcontext-duplicates-'));
  db = Database.open(join(workspace, 'test.db'), { create: true });
  db.exec(SCHEMA_SQL);
});

beforeEach(() => {
  db.run('DELETE FROM gh_events');
});

afterAll(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
});

describe('duplicateEvents', () => {
  it('stays quiet on events that only look alike', () => {
    // All four have no API id, so all four carry a synthesised key — and all
    // four are genuinely different events.
    insertEvent('7:labeled:2026-01-01T00:00:00Z:0');
    insertEvent('7:labeled:2026-01-02T00:00:00Z:1', { created_at: '2026-01-02T00:00:00Z' });
    insertEvent('7:unlabeled:2026-01-01T00:00:00Z:2', { event: 'unlabeled' });
    insertEvent('7:labeled:2026-01-01T00:00:00Z:3', { label: 'docs' });

    expect(duplicateEvents(db)).toEqual([]);
  });

  it('catches the same event stored again under a shifted position', () => {
    /*
     * The failure it exists for: the synthesised key ends in the event's index
     * in the timeline. An entry arriving earlier on a later sync shifts that
     * index, so the identical event is inserted beside itself instead of
     * replacing it. The primary key cannot notice — the two keys differ.
     */
    insertEvent('7:labeled:2026-01-01T00:00:00Z:0');
    insertEvent('7:labeled:2026-01-01T00:00:00Z:9');

    expect(duplicateEvents(db)).toEqual([
      { issue_id: 7, event: 'labeled', created_at: '2026-01-01T00:00:00Z', copies: 2 },
    ]);
  });

  it('ignores events without a timestamp instead of guessing', () => {
    // With no `created_at` there is no way to tell a repeated event from a
    // duplicated one, and a check that cannot tell must not fail a build.
    insertEvent('7:mentioned:unknown:0', { event: 'mentioned', created_at: null });
    insertEvent('7:mentioned:unknown:1', { event: 'mentioned', created_at: null });

    expect(duplicateEvents(db)).toEqual([]);
  });
});
