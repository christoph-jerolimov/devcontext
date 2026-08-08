import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { REFERENCE } from '../fixtures/data.mjs';

/** Every entry in the viewer's main navigation, in the order the sidebar has them. */
const PAGES = [
  { id: 'overview', label: 'Overview' },
  { id: 'issues', label: 'GitHub issues' },
  { id: 'pulls', label: 'Pull requests' },
  { id: 'runs', label: 'Workflow runs' },
  { id: 'workitems', label: 'Jira work items' },
  { id: 'sprints', label: 'Sprints' },
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
  await page.goto(`/#/${hash}`);
  // The shell renders before the fetches resolve; waiting on the panel avoids
  // photographing a half loaded page.
  await expect(page.locator('.content .panel, .content .cards').first()).toBeVisible();
  await expect(page.getByText('Loading…')).toHaveCount(0);
}

/**
 * The few things on a page that cannot be the same twice.
 *
 * Almost everything the viewer shows comes from the fixture and is rendered
 * against the frozen clock, so it is stable. These are the exceptions: values
 * the *server* derives from its own clock, or from where the database happens
 * to live. Masking them is narrower than dropping the page from the
 * comparison, which would leave its layout unwatched.
 */
function unstable(page: Page, id: string) {
  if (id === 'overview') {
    return [
      // Absolute paths on this machine.
      page.locator('.panel', { hasText: 'Projects' }).locator('p.muted'),
      // When the sync ran, and the cursors it wrote — both real timestamps.
      page.locator('.panel', { hasText: 'Recent sync runs' }).locator('tbody'),
      page.locator('.panel', { hasText: 'Sync state' }).locator('tbody'),
    ];
  }
  if (id === 'insights') {
    // "Oldest" is an age the server computes from now, not from the frozen
    // browser clock, so it grows by a day every day.
    return [page.locator('.panel', { hasText: 'Work in progress' }).locator('td:last-child')];
  }
  return [];
}

test.describe('the viewer, page by page', () => {
  for (const { id, label } of PAGES) {
    test(`${id} renders and looks right`, async ({ page }) => {
      await openViewer(page, id);

      // The sidebar marks where you are, which is also how a broken route
      // would show up as something other than a screenshot difference.
      await expect(page.locator('.sidebar a.active')).toHaveText(label);

      await expect(page).toHaveScreenshot(`${id}.png`, {
        fullPage: true,
        mask: unstable(page, id),
      });
    });
  }
});

test.describe('the data actually arrived', () => {
  /*
   * The screenshots would still pass if every page were empty, so these assert
   * that the sync put something on each of them. They are about the pipeline —
   * CLI sync, SQLite, JSON API, React — not about layout.
   */
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
