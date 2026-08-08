import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { REFERENCE } from '../fixtures/data.mjs';

/** Every entry in the viewer's main navigation, in the order the sidebar has them. */
const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'issues', label: 'GitHub issues' },
  { id: 'pulls', label: 'Pull requests' },
  { id: 'runs', label: 'Workflow runs' },
  { id: 'workitems', label: 'Jira work items' },
  { id: 'sprints', label: 'Sprints' },
  { id: 'activity', label: 'Activity' },
  { id: 'history', label: 'History' },
  { id: 'burndown', label: 'Burndown' },
  { id: 'insights', label: 'Insights' },
  { id: 'digest', label: 'Digest' },
] as const;

/**
 * Freezes the clock before anything runs.
 *
 * The viewer prints relative times, and computes the insight and digest
 * windows from `Date.now()` in the browser. Left alone, every screenshot would
 * differ from the day before — so the clock is pinned to the instant the
 * fixture data was written against.
 */
async function openViewer(page: Page, hash: string): Promise<void> {
  await page.clock.setFixedTime(new Date(REFERENCE));
  await pinVolatileValues(page);
  await page.goto(`/#/${hash}`);
  await pinTheMonospaceFont(page);
  // The shell renders before the fetches resolve; waiting on the panel avoids
  // photographing a half loaded page.
  await expect(page.locator('.content .panel, .content .cards').first()).toBeVisible();
  await expect(page.getByText('Loading…')).toHaveCount(0);
}

/**
 * Pins the one font the stylesheet never actually names.
 *
 * Every monospace rule in the viewer ends in the generic `monospace`, and a
 * generic family is by definition whatever the machine decides — fontconfig
 * picks it, and two Linux boxes need not pick the same one. The overview is
 * the only screenshotted page with any monospace text on it (the configuration
 * and database paths), and it was the only page that differed between this
 * machine and the runner, by a few hundred pixels of identical characters.
 *
 * The body font is pinned to whatever it already resolves to, because the nine
 * other pages matching exactly is proof that both environments agree on it.
 * The cost is that those two paths appear in the body font in the pictures
 * rather than in a monospace one, which for a screenshot of two invented paths
 * is not much of a cost at all.
 */
async function pinTheMonospaceFont(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `code, pre, .palette-ref, .mono, .tree-key { font-family: inherit; }`,
  });
}

/**
 * Pins the handful of values the *server* derives from its own clock, or from
 * where the database happens to live.
 *
 * Everything else the viewer shows comes from the fixture and is rendered
 * against the frozen clock above, so it is already stable. These are the
 * exceptions, and they used to be painted over with Playwright's mask instead
 * — which made the screenshots reproducible and simultaneously useless for
 * anything else, because a mask is a solid magenta rectangle.
 *
 * Rewriting the response is narrower than masking in both directions. The rows
 * stay in the picture, so their layout is still compared rather than hidden,
 * and the picture stays a picture of the product.
 */
async function pinVolatileValues(page: Page): Promise<void> {
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      config: { path: string; database: string };
      runs: Array<Record<string, unknown>>;
      state: Array<Record<string, unknown>>;
    };

    // Absolute paths on whichever machine ran the sync.
    body.config.path = '/work/platform/devcontext.yaml';
    body.config.database = '/work/platform/.devcontext/devcontext.db';

    /*
     * Everything in this table except what was synced is a measurement of the
     * run rather than a property of the product: the ids count up across runs,
     * the timings are wall clock, and the call and item counts move with how
     * the sync happened to go on this machine.
     *
     * The real numbers are asserted in the DOM tests below, where being exact
     * costs nothing. Here they only need to be the same shape every time.
     */
    body.runs = body.runs.toSorted((a, b) =>
      String(a['target']).localeCompare(String(b['target'])),
    );
    body.runs.forEach((run, index) => {
      Object.assign(run, {
        id: index + 1,
        started_at: REFERENCE,
        duration_ms: 1200,
        api_calls: 30,
        items_synced: 17,
      });
    });
    /*
     * Cursors come in two kinds and only one of them is stable.
     *
     * Most are the newest `updated_at` the walk saw, which is fixture data and
     * never moves. The rest — labels, milestones, workflows, sprints — have no
     * timestamp to carry, so the sync stores the moment it ran, which is a
     * different string every time. Anything later than the frozen reference is
     * one of those by construction.
     */
    body.state = body.state.map((entry) => ({
      ...entry,
      updated_at: REFERENCE,
      cursor:
        typeof entry['cursor'] === 'string' && entry['cursor'] > REFERENCE
          ? REFERENCE
          : entry['cursor'],
    }));

    await route.fulfill({ response, json: body });
  });

  await page.route('**/api/insights**', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      wip?: { byAssignee: Array<Record<string, unknown>> };
    };
    /*
     * Everything under /api/insights matches this glob, and only the overview
     * has a `wip` section — the burndown and velocity reports have their own
     * shapes and nothing here to pin. Rewriting blindly turned a new endpoint
     * into a 500 and a page stuck on "Loading…", which is a confusing way to
     * find out that a stub outgrew its route.
     */
    if (body.wip) {
      // An age the server measures from its own now, so it grows by a day a day.
      body.wip.byAssignee = body.wip.byAssignee.map((row) => ({ ...row, oldestHours: 36 }));
    }
    await route.fulfill({ response, json: body });
  });
}

test.describe('the viewer, page by page', () => {
  for (const { id, label } of PAGES) {
    test(`${id} renders and looks right`, async ({ page }) => {
      await openViewer(page, id);

      // The sidebar marks where you are, which is also how a broken route
      // would show up as something other than a screenshot difference.
      await expect(page.locator('.sidebar a.active')).toHaveText(label);

      await expect(page).toHaveScreenshot(`${id}.png`, { fullPage: true });
    });
  }
});

test.describe('the data actually arrived', () => {
  /*
   * The screenshots would still pass if every page were empty, so these assert
   * that the sync put something on each of them. They are about the pipeline —
   * CLI sync, SQLite, JSON API, React — not about layout.
   */
  test('the sync really made the calls the screenshot no longer shows', async ({ request }) => {
    /*
     * The overview screenshot shows pinned call and item counts, so nothing in
     * the picture would notice a sync that did nothing. This reads the API
     * directly — the `request` fixture has no page and therefore no route
     * handler — and checks the real numbers instead.
     */
    const status = (await (await request.get('/api/status')).json()) as {
      runs: Array<{ source: string; status: string; api_calls: number; items_synced: number }>;
    };

    expect(status.runs.map((run) => run.status)).toEqual(['completed', 'completed']);
    expect(status.runs.map((run) => run.source).toSorted()).toEqual(['github', 'jira']);
    for (const run of status.runs) {
      expect(run.api_calls).toBeGreaterThan(0);
      expect(run.items_synced).toBeGreaterThan(0);
    }
  });

  test('the overview counts what was synced', async ({ page }) => {
    await openViewer(page, 'overview');
    await expect(page.locator('.sidebar-footer')).toContainText('1 repositories');
    await expect(page.locator('.sidebar-footer')).toContainText('4 work items');
  });

  test('issues, pull requests and runs are listed', async ({ page }) => {
    // No state filter anywhere: both lists default to every state, so the
    // closed issue and the merged pull request are here without asking.
    await openViewer(page, 'issues');
    await expect(page.locator('.table tbody tr')).toHaveCount(3);
    await expect(page.locator('.table tbody .badge', { hasText: 'closed' })).toBeVisible();

    await openViewer(page, 'pulls');
    await expect(page.locator('.table tbody tr')).toHaveCount(2);
    await expect(page.getByText('PLAT-3: respect the secondary rate limit')).toBeVisible();

    await openViewer(page, 'runs');
    await expect(page.locator('.table tbody tr')).toHaveCount(4);
  });

  test('the activity feed carries all three kinds, from both platforms', async ({ request }) => {
    /*
     * The screenshot would pass on an empty feed, and would pass again if only
     * the comments made it through. This asserts the union actually unions:
     * every kind, and both sources, reached the page.
     */
    const feed = (await (
      await request.get('/api/activity?since=2000-01-01T00:00:00Z&limit=500')
    ).json()) as {
      events: Array<{ source: string; kind: string; action: string; title: string | null }>;
      total: number;
    };

    expect(feed.events.map((event) => event.kind).toSorted()).toContain('review');
    expect(new Set(feed.events.map((event) => event.kind))).toEqual(
      new Set(['status', 'comment', 'review']),
    );
    expect(new Set(feed.events.map((event) => event.source))).toEqual(new Set(['github', 'jira']));

    // A row that cannot say what it is about is a row nobody can read.
    expect(feed.events.every((event) => event.title !== null)).toBe(true);
    expect(feed.total).toBe(feed.events.length);
  });

  test('a merged pull request is one line, not merged and closed', async ({ request }) => {
    /*
     * The fixture reports both, a second apart, exactly as GitHub does —
     * merging closes the pull request. Through the real sync and the real
     * server, only the more specific word should survive.
     */
    const feed = (await (
      await request.get('/api/activity?since=2000-01-01T00:00:00Z&limit=500')
    ).json()) as { events: Array<{ ref: string; action: string }> };

    const merged = feed.events.filter((event) => event.ref === 'acme/platform#42');

    expect(merged.map((event) => event.action)).toContain('merged');
    expect(merged.map((event) => event.action)).not.toContain('closed');
  });

  test('the feed can be narrowed to one repository and one person', async ({ request }) => {
    /*
     * Two filters that only look right: a container filter that matches
     * nothing and a person filter that matches everything both produce a page
     * nobody can tell is wrong. So both are asserted against the union.
     */
    const url = '/api/activity?since=2000-01-01T00:00:00Z&limit=500';
    const all = (await (await request.get(url)).json()) as {
      events: Array<{ container: string; actor: string | null }>;
    };
    const scoped = (await (await request.get(`${url}&container=acme/platform`)).json()) as {
      events: Array<{ container: string }>;
      total: number;
    };

    expect(scoped.events.length).toBeGreaterThan(0);
    expect(new Set(scoped.events.map((event) => event.container))).toEqual(
      new Set(['acme/platform']),
    );
    // It narrowed rather than passed everything through.
    expect(scoped.events.length).toBeLessThan(all.events.length);
  });

  test('the history chart is drawn from the state changes, not from today', async ({ page }) => {
    await openViewer(page, 'history');

    /*
     * The point of this view: a count for a day in the past, which no other
     * table can produce. The line has a point per day and the caption states
     * the balance, so both are checked rather than only that an svg exists.
     */
    const chart = page.locator('.chart svg');
    await expect(chart).toBeVisible();
    await expect(page.locator('.chart-line')).toHaveCount(1);

    // One hit column per day in the window, each carrying its own tooltip.
    await expect(page.locator('.chart-hit')).toHaveCount(30);
    await expect(page.locator('.chart-hit title').first()).toHaveText(
      /\d{4}-\d{2}-\d{2}: \d+ open/,
    );

    await expect(page.locator('.chart figcaption')).toContainText('open now');
    await expect(page.locator('.panel', { hasText: 'Open per person' })).toBeVisible();
  });

  test('the ticket list merges both sources and builds its filters from them', async ({ page }) => {
    await openViewer(page, 'tickets');

    const rows = page.locator('.table tbody tr');
    // Three GitHub issues and four Jira work items, in one table.
    await expect(rows).toHaveCount(7);
    await expect(rows.filter({ hasText: 'acme/platform#' })).toHaveCount(3);
    await expect(rows.filter({ hasText: 'PLAT-' })).toHaveCount(4);
    // A pull request is not a ticket, so #42 must not be here.
    await expect(rows.filter({ hasText: '#42' })).toHaveCount(0);

    /*
     * The type dropdown is built from the data, not from a list in the code.
     * Story and Epic exist only because the fixture's work items carry them,
     * and Issue only because GitHub issues without a type are called that.
     */
    const types = page.locator('.panel-actions select').nth(2);
    await expect(types.locator('option')).toContainText(['All types', 'Issue (3)', 'Story (2)']);

    // Narrowing to one source narrows the type list with it.
    await page.locator('.panel-actions select').first().selectOption('jira');
    await expect(rows).toHaveCount(4);
    await expect(types.locator('option')).not.toContainText(['Issue (3)']);
  });

  test('state and size are colour coded, and cancelled is not a failure', async ({ page }) => {
    /*
     * A pixel comparison cannot police this: recolouring "+41" moves a couple
     * of hundred pixels, well under any threshold that survives antialiasing.
     * The meaning is in the class, so that is what gets asserted.
     */
    await openViewer(page, 'pulls');
    const rows = page.locator('.table tbody tr');

    await expect(rows.filter({ hasText: 'PLAT-3' }).locator('.badge')).toHaveClass(/badge-merged/);
    await expect(rows.filter({ hasText: 'remaining budget' }).locator('.badge')).toHaveClass(
      /badge-open/,
    );
    // Added and removed lines read as opposite colours, not one grey number.
    const added = rows.first().locator('.changes-added');
    const removed = rows.first().locator('.changes-removed');
    await expect(added).toBeVisible();
    expect(await added.evaluate((el) => getComputedStyle(el).color)).not.toBe(
      await removed.evaluate((el) => getComputedStyle(el).color),
    );

    await openViewer(page, 'runs');
    const cancelled = page.locator('.table tbody tr').filter({ hasText: 'cancelled' });
    await expect(cancelled.locator('.badge')).toHaveClass(/badge-cancelled/);
    // Whatever the theme, it must not be the colour a failure gets.
    const failureColour = await page
      .locator('.badge-failure')
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    expect(await cancelled.locator('.badge').evaluate((el) => getComputedStyle(el).color)).not.toBe(
      failureColour,
    );
  });

  test('a pull request opens with its reviews and files', async ({ page }) => {
    await openViewer(page, 'pulls');
    await page.getByText('PLAT-3: respect the secondary rate limit').click();

    const detail = page.locator('.detail');
    await expect(detail.getByRole('heading', { level: 3, name: /Reviews \(2\)/ })).toBeVisible();
    await expect(detail.getByText('Make this a setting rather than a constant.')).toBeVisible();
    // The cross link back to Jira, which only exists because the sync built it
    // from the branch name and the title.
    await expect(detail.getByRole('heading', { level: 3, name: /Links/ })).toBeVisible();
    await expect(detail.locator('.links')).toContainText('PLAT-3');
  });

  test('a work item opens with its hierarchy', async ({ page }) => {
    await openViewer(page, 'workitems');
    await page.getByText('Respect the secondary rate limit').click();

    const detail = page.locator('.detail');
    await expect(detail.getByRole('heading', { level: 3, name: /Hierarchy/ })).toBeVisible();
    // Its epic above it, from the parent field.
    await expect(detail.locator('.tree')).toContainText('PLAT-1');
  });

  test('the command palette finds a ticket by a word in its comment', async ({ page }) => {
    await openViewer(page, 'issues');
    await page.keyboard.press('ControlOrMeta+k');

    // Scoped to the palette: the view behind it has a search box too.
    await page.locator('[cmdk-input]').fill('secondary rate limit');
    await expect(page.locator('[cmdk-item]').first()).toBeVisible();
    await expect(page.locator('[cmdk-list]')).toContainText('PLAT-3');
  });
});
