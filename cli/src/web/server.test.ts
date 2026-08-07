/**
 * Tests for the JSON API behind `devcontext serve`.
 *
 * They start the real server against a seeded database and speak HTTP to it,
 * because the bugs worth catching here live in the path handling rather than
 * in the queries — which have their own tests. The first one it caught: a
 * GitHub reference arrives percent-encoded (`acme/platform%2342`), and the
 * segments were never decoded, so the `#` never reappeared.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseConfig } from '../config/load.js';
import { Database } from '../db/database.js';
import { nullLogger } from '../util/logger.js';
import { startWebServer } from './server.js';

let workspace: string;
let server: Server;
let base: string;

const NOW = '2026-08-01T10:00:00Z';

function seed(databasePath: string): void {
  const db = Database.openAndMigrate(databasePath);
  try {
    const workitem = (key: string, extra: Record<string, string | number | null> = {}): void => {
      const row: Record<string, string | number | null> = {
        site: 'acme',
        id: key,
        key,
        project_key: 'PLAT',
        summary: `Summary of ${key}`,
        type: 'Story',
        status: 'To Do',
        status_category: 'To Do',
        parent_key: null,
        epic_key: null,
        story_points: null,
        resolved_at: null,
        url: `https://acme.atlassian.net/browse/${key}`,
        synced_at: NOW,
        raw: '{}',
        ...extra,
      };
      const columns = Object.keys(row);
      db.run(
        `INSERT INTO jira_workitems (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((column) => row[column] as never),
      );
    };

    workitem('PLAT-1', { type: 'Epic', summary: 'Rate limiting' });
    workitem('PLAT-2', { parent_key: 'PLAT-1', story_points: 5 });
    // Attached by the classic epic-link field rather than a real parent.
    workitem('PLAT-3', { epic_key: 'PLAT-1', story_points: 3 });
    workitem('PLAT-9', { summary: 'Stands alone' });

    db.run(
      `INSERT INTO cross_links
         (uid, from_source, from_kind, from_ref, to_source, to_kind, to_ref, via, detail,
          confidence, synced_at)
       VALUES (?, 'github', 'pull_request', 'acme/platform#42', 'jira', 'workitem', 'PLAT-2',
               'branch', 'PLAT-2', 'high', ?)`,
      ['acme/platform#42|PLAT-2|branch', NOW],
    );
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'devcontext-server-'));
  const databasePath = join(workspace, 'test.db');
  seed(databasePath);

  const config = parseConfig(
    `
version: 1
projects:
  - key: platform
    github:
      - repo: acme/platform
`,
    { configPath: join(workspace, 'devcontext.yaml') },
  );

  server = await startWebServer({
    config,
    logger: nullLogger,
    // Port 0 means "whatever is free", so the suite cannot collide with a
    // viewer somebody already has running.
    port: 0,
    host: '127.0.0.1',
    databasePath,
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workspace, { recursive: true, force: true });
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

describe('GET /api/links/:ref', () => {
  it('finds a Jira key from the GitHub side of an encoded reference', async () => {
    /*
     * The regression: the path segments were not percent-decoded, so `%23`
     * stayed literal, `normaliseRef` saw no `#` and uppercased the lot into
     * "ACME/PLATFORM%2342" — which matches nothing.
     */
    const { status, body } = await get('/api/links/acme/platform%2342');

    expect(status).toBe(200);
    expect(body).toEqual({
      ref: 'acme/platform#42',
      links: [
        { ref: 'PLAT-2', source: 'jira', kind: 'workitem', via: 'branch', confidence: 'high' },
      ],
    });
  });

  it('finds the same link from the Jira side', async () => {
    const { body } = await get('/api/links/PLAT-2');

    expect(body).toEqual({
      ref: 'PLAT-2',
      links: [
        {
          ref: 'acme/platform#42',
          source: 'github',
          kind: 'pull_request',
          via: 'branch',
          confidence: 'high',
        },
      ],
    });
  });

  it('normalises a lowercase Jira key', async () => {
    const { body } = await get('/api/links/plat-2');
    expect((body as { ref: string }).ref).toBe('PLAT-2');
  });

  it('returns an empty list rather than an error for an unlinked item', async () => {
    expect(await get('/api/links/PLAT-9')).toEqual({
      status: 200,
      body: { ref: 'PLAT-9', links: [] },
    });
  });

  it('survives a malformed escape instead of returning a 500', async () => {
    // `%zz` is somebody's typo; it should find nothing, not crash the request.
    const { status } = await get('/api/links/acme/platform%zz');
    expect(status).toBe(200);
  });
});

describe('GET /api/jira/tree/:key', () => {
  it('returns ancestors, children and the roll-up', async () => {
    const { status, body } = await get('/api/jira/tree/PLAT-1');
    const tree = body as {
      root: { key: string; children: Array<{ key: string; relation: string }> };
      ancestors: unknown[];
      summary: { total: number; storyPoints: number };
    };

    expect(status).toBe(200);
    expect(tree.root.key).toBe('PLAT-1');
    expect(tree.ancestors).toEqual([]);
    expect(tree.root.children.map((child) => [child.key, child.relation])).toEqual([
      ['PLAT-2', 'child'],
      // Reached through the epic link field, which the viewer tags differently.
      ['PLAT-3', 'epic-child'],
    ]);
    expect(tree.summary.total).toBe(3);
    expect(tree.summary.storyPoints).toBe(8);
  });

  it('climbs to the parent when asked for a leaf', async () => {
    const { body } = await get('/api/jira/tree/PLAT-2');
    const tree = body as { ancestors: Array<{ key: string }> };
    expect(tree.ancestors.map((node) => node.key)).toEqual(['PLAT-1']);
  });

  it('drops the ancestors when told to', async () => {
    const { body } = await get('/api/jira/tree/PLAT-2?ancestors=false');
    expect((body as { ancestors: unknown[] }).ancestors).toEqual([]);
  });

  it('404s on an unknown key and on no key at all', async () => {
    expect((await get('/api/jira/tree/PLAT-404')).status).toBe(404);
    expect((await get('/api/jira/tree')).status).toBe(404);
  });
});
