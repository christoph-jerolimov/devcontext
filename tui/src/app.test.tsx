/**
 * Drives the real components against a real database.
 *
 * A terminal UI is easy to write and easy to have quietly render nothing —
 * a wrong column name throws inside a view, a wrong width collapses a table to
 * blanks, and neither shows up in a typecheck. So these render the actual app
 * over actual rows and read the frame back.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { render } from 'ink-testing-library';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Database } from '@devcontext/cli';
import { App } from './app.js';
import type { Store } from './data.js';
import { fit } from './components/table.js';
import { relative } from './views/format.js';

let workspace: string;
let store: Store;

const ESC = String.fromCharCode(27);
const ENTER = String.fromCharCode(13);

/** Waits for Ink to flush the frame its effects produced. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'devcontext-tui-'));
  const db = Database.openAndMigrate(join(workspace, 'devcontext.db'));

  db.upsert('gh_repositories', {
    host: 'github.com',
    id: 1,
    full_name: 'acme/platform',
    owner: 'acme',
    name: 'platform',
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
  db.upsert('gh_issues', {
    host: 'github.com',
    id: 100,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: 12,
    title: 'Sync is slow on large repositories',
    state: 'open',
    author: 'ada',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-02-01T00:00:00Z',
    is_pull_request: false,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
  db.upsert('gh_issues', {
    host: 'github.com',
    id: 200,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: 42,
    title: 'Batch the API calls',
    state: 'closed',
    author: 'grace',
    created_at: '2024-01-10T00:00:00Z',
    updated_at: '2024-03-01T00:00:00Z',
    is_pull_request: true,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
  db.upsert('gh_pull_requests', {
    host: 'github.com',
    id: 200,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: 42,
    title: 'Batch the API calls',
    state: 'closed',
    merged: true,
    draft: false,
    author: 'grace',
    additions: 184,
    deletions: 26,
    created_at: '2024-01-10T00:00:00Z',
    updated_at: '2024-03-01T00:00:00Z',
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
  db.close();

  process.env['DEVCONTEXT_TUI_TEST_DB'] = join(workspace, 'devcontext.db');
  const open = Database.open(join(workspace, 'devcontext.db'), { create: false, readOnly: true });
  store = {
    db: open,
    close: () => void open.close(),
    // Only `databasePath` is read by a view, so the rest is not worth faking.
    config: { databasePath: join(workspace, 'devcontext.db') } as Store['config'],
  };
});

afterAll(() => {
  store.close();
  rmSync(workspace, { recursive: true, force: true });
});

describe('the app', () => {
  it('opens on the overview and lists every view', async () => {
    const { lastFrame, unmount } = render(<App store={store} />);
    await settle();
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Overview');
    expect(frame).toContain('Pull requests');
    expect(frame).toContain('History');
    // The counts, from the rows actually written above.
    expect(frame).toContain('Contents');
    expect(frame).toMatch(/1 repositories/);
    unmount();
  });

  it('shows issues, and pull requests as merged rather than closed', async () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    await settle();

    stdin.write('2');
    await settle();
    expect(lastFrame()).toContain('Sync is slow');

    stdin.write('3');
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Batch the API calls');
    // GitHub stores merged as `closed`; the reader is told the difference.
    expect(frame).toContain('merged');
    expect(frame).toContain('+184');
    expect(frame).toContain('-26');
    unmount();
  });

  it('filters the list as you type, and esc puts it back', async () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    await settle();

    stdin.write('2');
    await settle();
    expect(lastFrame()).toContain('Sync is slow');

    stdin.write('/');
    await settle();
    stdin.write('nothing matches this');
    await settle();
    expect(lastFrame()).not.toContain('Sync is slow');

    stdin.write(ESC);
    await settle();
    expect(lastFrame()).toContain('Sync is slow');
    unmount();
  });

  it('renders without a React warning, which nothing else would fail on', async () => {
    /*
     * Both sides count `comments`, so the overview cards collided on their
     * key and React quietly dropped one. A duplicate key is a warning, not an
     * error — it fails no test and shows up as a missing card nobody misses.
     */
    const warnings: string[] = [];
    // React reports these through console.error and nothing else.
    // oxlint-disable no-console
    const original = console.error;
    console.error = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));

    try {
      const { stdin, unmount } = render(<App store={store} />);
      await settle();
      // Every view, since any of them could collide.
      for (const key of ['2', '3', '4', '5', '6', '7', '8', '9']) {
        stdin.write(key);
        await settle();
      }
      unmount();
    } finally {
      console.error = original;
      // oxlint-enable no-console
    }

    expect(warnings).toEqual([]);
  });

  it('keeps pull requests out of the issue list, as the web viewer does', async () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    await settle();

    stdin.write('2');
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Sync is slow');
    expect(frame).not.toContain('Batch the API calls');
    unmount();
  });

  it('does not treat a q in a search term as quit', async () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    await settle();

    stdin.write('/');
    await settle();
    stdin.write('q');
    await settle();

    // Still rendering: the filter swallowed the key rather than exiting.
    expect(lastFrame()).toContain('filter: q');
    unmount();
  });

  it('opens the selected item and comes back', async () => {
    const { lastFrame, stdin, unmount } = render(<App store={store} />);
    await settle();

    stdin.write('3');
    await settle();
    stdin.write(ENTER);
    await settle();

    const open = lastFrame() ?? '';
    expect(open).toContain('acme/platform#42');
    expect(open).toContain('esc to go back');

    stdin.write(ESC);
    await settle();

    const back = lastFrame() ?? '';
    expect(back).not.toContain('esc to go back');
    expect(back).toContain('Batch the API calls');
    unmount();
  });
});

describe('fit', () => {
  it('pads to exactly the width', () => {
    expect(fit('ab', 5)).toBe('ab   ');
    expect(fit('ab', 5, 'right')).toBe('   ab');
  });

  it('cuts with an ellipsis, because a wrapped row breaks the whole table', () => {
    expect(fit('abcdef', 4)).toBe('abc…');
    expect(fit('abcdef', 4)).toHaveLength(4);
  });

  it('survives a width of zero or one', () => {
    expect(fit('abc', 0)).toBe('');
    expect(fit('abc', 1)).toBe('a');
  });
});

describe('relative', () => {
  const now = Date.parse('2024-06-01T00:00:00Z');

  it('keeps it short enough to share a line', () => {
    expect(relative('2024-05-30T00:00:00Z', now)).toBe('2d');
    expect(relative('2024-04-01T00:00:00Z', now)).toBe('2mo');
    expect(relative('2024-06-01T00:00:00Z', now)).toBe('now');
  });

  it('says nothing rather than NaN', () => {
    expect(relative(null, now)).toBe('');
    expect(relative('not a date', now)).toBe('');
  });
});
