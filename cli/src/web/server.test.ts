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
import type { ProgressSnapshot } from '../sync/progress.js';
import { SyncScheduler } from '../sync/watch.js';
import { nullLogger } from '../util/logger.js';
import { startWebServer } from './server.js';
import type { WebServerOptions } from './server.js';

let workspace: string;
let server: Server;
let base: string;
let databasePath: string;
let serverOptions: Omit<WebServerOptions, 'watch'>;

const NOW = '2026-08-01T10:00:00Z';

function seed(path: string): void {
  const db = Database.openAndMigrate(path);
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

    db.setMeta(
      'rate_limits',
      JSON.stringify({
        GitHub: {
          limit: 5000,
          remaining: 4321,
          resetAt: '2026-08-01T11:00:00.000Z',
          observedAt: '2026-08-01T09:59:00.000Z',
        },
      }),
    );

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
  databasePath = join(workspace, 'test.db');
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

  serverOptions = {
    config,
    logger: nullLogger,
    // Port 0 means "whatever is free", so the suite cannot collide with a
    // viewer somebody already has running.
    port: 0,
    host: '127.0.0.1',
    databasePath,
    // Fast enough that a test can wait for a data-changed event.
    dataPollMs: 50,
  };

  server = await startWebServer(serverOptions);
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

/** Parses a server-sent event stream into `{event, data}` pairs. */
async function* sseEvents(response: Response): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        if (line.startsWith('data: ')) data = line.slice('data: '.length);
      }
      // Blocks without data are the retry hint and keep-alive comments.
      if (data !== '') yield { event, data: JSON.parse(data) };
      index = buffer.indexOf('\n\n');
    }
  }
}

async function nextEvent(
  events: AsyncGenerator<{ event: string; data: unknown }>,
): Promise<{ event: string; data: unknown }> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('No event arrived within 5s.')), 5000).unref();
  });
  const next = await Promise.race([events.next(), timeout]);
  if (next.done) throw new Error('The event stream ended unexpectedly.');
  return next.value;
}

describe('GET /api/events', () => {
  it('announces a write from another connection as data-changed', async () => {
    /*
     * The write below is, as far as the server can tell, a plain
     * `devcontext sync` running in another terminal: a different connection
     * committing to the same file. Nothing registers anything anywhere —
     * SQLite's data_version is what gives it away.
     */
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const events = sseEvents(response);

    expect(await nextEvent(events)).toEqual({ event: 'hello', data: { watch: null } });

    const writer = Database.open(databasePath);
    writer.run(
      `INSERT INTO jira_workitems (site, id, key, project_key, summary, synced_at, raw)
       VALUES ('acme', 'PLAT-100', 'PLAT-100', 'PLAT', 'Late arrival', ?, '{}')`,
      [NOW],
    );
    writer.close();

    expect((await nextEvent(events)).event).toBe('data-changed');
    controller.abort();
  });
});

describe('watch mode', () => {
  let watchServer: Server;
  let watchBase: string;
  let scheduler: SyncScheduler;
  let finishRun: (() => void) | null = null;
  let reportProgress: ((snapshot: ProgressSnapshot) => void) | null = null;
  let lastOnly: string[] | null = null;

  beforeAll(async () => {
    scheduler = new SyncScheduler({
      // Far enough out that only the test ever starts a run.
      intervalMs: 3_600_000,
      logger: nullLogger,
      run: (ctx) => {
        reportProgress = ctx.report;
        lastOnly = ctx.only ?? null;
        return new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      },
    });
    watchServer = await startWebServer({
      ...serverOptions,
      watch: { scheduler, intervalMs: 3_600_000 },
    });
    watchBase = `http://127.0.0.1:${String((watchServer.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    scheduler.stop();
    await new Promise<void>((resolve) => watchServer.close(() => resolve()));
  });

  it('without watch, the trigger does not exist', async () => {
    const response = await fetch(`${base}/api/sync`, { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('reports itself in /api/status', async () => {
    const response = await fetch(`${watchBase}/api/status`);
    const body = (await response.json()) as { watch: unknown; rateLimits: unknown };
    expect(body.watch).toEqual({
      intervalMs: 3_600_000,
      running: false,
      paused: false,
      progress: null,
    });
    // The budget the last sync persisted, watch mode or not.
    expect(body.rateLimits).toEqual({
      GitHub: {
        limit: 5000,
        remaining: 4321,
        resetAt: '2026-08-01T11:00:00.000Z',
        observedAt: '2026-08-01T09:59:00.000Z',
      },
    });
  });

  it('pauses and resumes over HTTP, and the paused state refuses the trigger', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${watchBase}/api/events`, { signal: controller.signal });
    const events = sseEvents(stream);
    expect((await nextEvent(events)).event).toBe('hello');

    const paused = await fetch(`${watchBase}/api/sync/pause`, { method: 'POST' });
    expect(paused.status).toBe(200);
    expect((await nextEvent(events)).event).toBe('watch-paused');

    const status = (await (await fetch(`${watchBase}/api/status`)).json()) as {
      watch: { paused: boolean };
    };
    expect(status.watch.paused).toBe(true);

    // Paused means paused, and the refusal says so rather than claiming a
    // sync is running.
    const refused = await fetch(`${watchBase}/api/sync`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/paused/);

    const resumed = await fetch(`${watchBase}/api/sync/resume`, { method: 'POST' });
    expect(resumed.status).toBe(200);
    expect((await nextEvent(events)).event).toBe('watch-resumed');
    controller.abort();
  });

  it('the pause endpoints do not exist outside watch mode', async () => {
    expect((await fetch(`${base}/api/sync/pause`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/sync/resume`, { method: 'POST' })).status).toBe(404);
  });

  it('syncs one named item via ?only=, encoded reference and all', async () => {
    // The "Sync this item" button on an opened pull request sends exactly
    // this: the reference, percent-encoded because it contains a hash.
    const response = await fetch(`${watchBase}/api/sync?only=acme%2Fplatform%2342`, {
      method: 'POST',
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ started: true, only: ['acme/platform#42'] });
    expect(lastOnly).toEqual(['acme/platform#42']);
    finishRun?.();
    // Let the run settle so the next test starts from idle.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('accepts one trigger, refuses a second, and tells the stream', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${watchBase}/api/events`, { signal: controller.signal });
    const events = sseEvents(stream);
    expect(await nextEvent(events)).toEqual({
      event: 'hello',
      data: { watch: { intervalMs: 3_600_000 } },
    });

    const first = await fetch(`${watchBase}/api/sync`, { method: 'POST' });
    expect(first.status).toBe(202);
    expect((await nextEvent(events)).event).toBe('sync-started');

    // One writer is the rule the whole design leans on; a second request
    // while one runs is refused, not queued.
    const second = await fetch(`${watchBase}/api/sync`, { method: 'POST' });
    expect(second.status).toBe(409);

    /*
     * Progress reaches a viewer two ways, and both matter: the stream for
     * pages already open, and /api/status for one opened mid-sync — an
     * hours-long run must be visible however late somebody looks.
     */
    const snapshot: ProgressSnapshot = {
      phase: 'issues',
      position: '#42, 5 of 231',
      apiCalls: 50,
      apiCallsExpected: 200,
      items: 40,
      elapsedMs: 60_000,
      etaMs: 180_000,
    };
    reportProgress?.(snapshot);

    const progressed = await nextEvent(events);
    expect(progressed.event).toBe('sync-progress');
    expect(progressed.data).toMatchObject({ progress: snapshot });

    const during = (await (await fetch(`${watchBase}/api/status`)).json()) as {
      watch: { running: boolean; progress: ProgressSnapshot | null };
    };
    expect(during.watch.running).toBe(true);
    expect(during.watch.progress).toEqual(snapshot);

    finishRun?.();
    const completed = await nextEvent(events);
    expect(completed.event).toBe('sync-completed');
    expect(completed.data).toMatchObject({ status: 'completed', error: null });
    controller.abort();
  });
});
