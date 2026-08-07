import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import * as links from '../db/queries/links.js';
import { buildCrossLinks } from './build.js';
import { confidenceFor, extractGithubReferences, extractJiraKeys } from './extract.js';

const PROJECTS = ['PLAT', 'INFRA'];

describe('extractJiraKeys', () => {
  it('finds keys of known projects', () => {
    expect(extractJiraKeys('Fixes PLAT-42 and INFRA-7', PROJECTS).map((r) => r.key)).toEqual([
      'PLAT-42',
      'INFRA-7',
    ]);
  });

  it('ignores keys of unknown projects', () => {
    expect(extractJiraKeys('See OTHER-1', PROJECTS)).toEqual([]);
  });

  it('does not mistake common upper case tokens for Jira keys', () => {
    const text = 'Encode as UTF-8, hash with SHA-256, during COVID-19, over HTTP-2, RFC-7231.';
    expect(extractJiraKeys(text, PROJECTS)).toEqual([]);
    // Without the project restriction all of those would match, which is why
    // the restriction exists.
    expect(extractJiraKeys(text, ['UTF', 'SHA']).map((r) => r.key)).toEqual(['UTF-8', 'SHA-256']);
  });

  it('reads keys out of branch names in the shapes people actually use', () => {
    const cases: Array<[string, string]> = [
      ['feature/PLAT-42-speed-up', 'PLAT-42'],
      ['feature/plat-42-speed-up', 'PLAT-42'],
      ['bugfix/plat42', 'PLAT-42'],
      ['PLAT_42_hotfix', 'PLAT-42'],
      ['chore/plat 42', 'PLAT-42'],
    ];
    for (const [branch, expected] of cases) {
      expect({ branch, keys: extractJiraKeys(branch, PROJECTS).map((r) => r.key) }).toEqual({
        branch,
        keys: [expected],
      });
    }
  });

  it('deduplicates repeated mentions but keeps distinct keys', () => {
    const keys = extractJiraKeys('PLAT-1 again PLAT-1 and PLAT-2', PROJECTS).map((r) => r.key);
    expect(keys).toEqual(['PLAT-1', 'PLAT-2']);
  });

  it('is empty for empty input or no known projects', () => {
    expect(extractJiraKeys(null, PROJECTS)).toEqual([]);
    expect(extractJiraKeys('PLAT-1', [])).toEqual([]);
  });
});

describe('extractGithubReferences', () => {
  it('finds qualified references and URLs', () => {
    const text =
      'See acme/platform#42 and https://github.com/acme/platform/pull/43 and ' +
      'https://github.acme.com/acme/docs/issues/7';
    expect(extractGithubReferences(text)).toEqual([
      { repo: 'acme/platform', number: 43, match: 'https://github.com/acme/platform/pull/43' },
      { repo: 'acme/docs', number: 7, match: 'https://github.acme.com/acme/docs/issues/7' },
      { repo: 'acme/platform', number: 42, match: 'acme/platform#42' },
    ]);
  });

  it('ignores bare issue numbers, which are too ambiguous to attribute', () => {
    expect(extractGithubReferences('fixed in #42')).toEqual([]);
  });
});

describe('confidenceFor', () => {
  it('trusts branches and titles more than prose', () => {
    expect(confidenceFor('branch')).toBe('high');
    expect(confidenceFor('title')).toBe('high');
    expect(confidenceFor('comment')).toBe('medium');
    expect(confidenceFor('anything-else')).toBe('medium');
  });
});

describe('buildCrossLinks', () => {
  let db: Database;
  const syncedAt = '2026-08-01T00:00:00.000Z';

  const addPull = (number: number, fields: Record<string, unknown>): void => {
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
      synced_at: syncedAt,
      raw: '{}',
      ...fields,
    } as Record<string, never>);
  };

  const addWorkitem = (key: string, fields: Record<string, unknown> = {}): void => {
    db.upsert('jira_workitems', {
      site: 'acme',
      id: key,
      key,
      project_key: key.split('-')[0],
      labels: '[]',
      components: '[]',
      fix_versions: '[]',
      custom_fields: '{}',
      synced_at: syncedAt,
      raw: '{}',
      ...fields,
    } as Record<string, never>);
  };

  beforeEach(() => {
    db = Database.openAndMigrate(':memory:');
    db.upsert('jira_projects', {
      site: 'acme',
      id: '1',
      key: 'PLAT',
      name: 'Platform',
      synced_at: syncedAt,
      raw: '{}',
    });
    addWorkitem('PLAT-7', { summary: 'Speed up the sync' });
    addWorkitem('PLAT-8', { summary: 'Docs' });
  });

  afterEach(() => db.close());

  it('links a pull request to a work item through its branch name', () => {
    addPull(42, { title: 'Speed up the sync', head_ref: 'feature/PLAT-7-speed' });

    const result = buildCrossLinks(db);
    expect(result.links).toBe(1);

    const [link] = links.listLinks(db);
    expect(link?.from_ref).toBe('acme/platform#42');
    expect(link?.to_ref).toBe('PLAT-7');
    expect(link?.via).toBe('branch');
    expect(link?.confidence).toBe('high');
  });

  it('records every place a reference was found', () => {
    addPull(42, {
      title: 'PLAT-7: speed up the sync',
      body: 'Also touches PLAT-8.',
      head_ref: 'feature/plat-7',
    });

    buildCrossLinks(db);
    const vias = links.listLinks(db, { ref: 'PLAT-7' }).map((row) => row.via);
    expect(vias.toSorted()).toEqual(['branch', 'title']);
    expect(links.listLinks(db, { ref: 'PLAT-8' }).map((row) => row.via)).toEqual(['body']);
  });

  it('links through commit messages', () => {
    addPull(42, { title: 'Speed up', head_ref: 'feature/speed' });
    db.upsert('gh_commits', {
      host: 'github.com',
      repo_id: 7,
      repo_full_name: 'acme/platform',
      sha: 'c0ffee',
      pr_id: 1042,
      pr_number: 42,
      message: 'PLAT-7 batch the calls',
      synced_at: syncedAt,
      raw: '{}',
    });

    buildCrossLinks(db);
    expect(links.listLinks(db).map((row) => row.via)).toEqual(['commit']);
  });

  it('links a work item back to a pull request it mentions', () => {
    addPull(42, { title: 'Speed up', head_ref: 'feature/speed' });
    addWorkitem('PLAT-9', {
      summary: 'Tracked in acme/platform#42',
      description: 'See https://github.com/acme/platform/pull/42',
    });

    buildCrossLinks(db);
    const rows = links.listLinks(db, { fromSource: 'jira' });
    expect(rows.map((row) => [row.from_ref, row.to_ref, row.via])).toEqual([
      ['PLAT-9', 'acme/platform#42', 'title'],
      ['PLAT-9', 'acme/platform#42', 'body'],
    ]);
    expect(rows[0]?.to_kind).toBe('pull_request');
  });

  it('does not invent links to things that are not synced', () => {
    addPull(42, { title: 'Fixes PLAT-999', head_ref: 'feature/plat-999' });

    const result = buildCrossLinks(db);
    expect(result.links).toBe(0);
    expect(result.danglingJiraKeys).toEqual(['PLAT-999']);
  });

  it('is idempotent and drops links whose text changed', () => {
    addPull(42, { title: 'PLAT-7 speed', head_ref: 'main' });
    buildCrossLinks(db);
    expect(links.listLinks(db)).toHaveLength(1);

    // Same input again must not duplicate.
    buildCrossLinks(db);
    expect(links.listLinks(db)).toHaveLength(1);

    // The title was edited: the stale link has to disappear.
    addPull(42, { title: 'speed', head_ref: 'main' });
    buildCrossLinks(db);
    expect(links.listLinks(db)).toHaveLength(0);
  });

  it('answers "what is linked to this" from either side', () => {
    addPull(42, { title: 'PLAT-7 speed', head_ref: 'feature/plat-7' });
    buildCrossLinks(db);

    expect(links.jiraKeysFor(db, 'acme/platform', 42)).toEqual(['PLAT-7']);
    expect(links.githubRefsFor(db, 'PLAT-7')).toEqual([
      { ref: 'acme/platform#42', kind: 'pull_request', via: 'branch' },
    ]);
    // Lower case keys are normalised.
    expect(links.githubRefsFor(db, 'plat-7')).toHaveLength(1);
  });

  it('filters by confidence and by where the reference was found', () => {
    addPull(42, { title: 'speed', body: 'refs PLAT-7', head_ref: 'main' });
    addPull(43, { title: 'PLAT-8 docs', head_ref: 'main' });
    buildCrossLinks(db);

    expect(links.listLinks(db, { minConfidence: 'high' }).map((row) => row.to_ref)).toEqual([
      'PLAT-8',
    ]);
    expect(links.listLinks(db, { via: ['body'] }).map((row) => row.to_ref)).toEqual(['PLAT-7']);
  });
});
