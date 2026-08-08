/**
 * Which items are worth a per-item request.
 *
 * Both failure directions are silent, which is why this is tested rather than
 * observed. Fetching too much only shows up as a slow sync; fetching too
 * little shows up as nothing at all — the sync reports success, the rows are
 * there, and only the answers built from the missing rows are wrong.
 */

import { describe, expect, it } from 'vitest';

import { needsDetails, parseParts, withinWindow } from './refresh.js';
import type { DetailPart, StoredItem } from './refresh.js';

const WANTED: DetailPart[] = ['comments', 'timeline'];

function stored(row: Partial<StoredItem> = {}): StoredItem {
  return {
    updated_at: '2026-03-01T10:00:00Z',
    details_parts: JSON.stringify(WANTED),
    details_synced_at: '2026-03-01T11:00:00Z',
    ...row,
  };
}

describe('needing the details again', () => {
  it('skips an item that has not moved since it was fetched', () => {
    /*
     * The whole point. A watermark refetched anything at or after the previous
     * run's newest timestamp, which includes items whose stored copy was
     * already current — every one of those was a wasted request.
     */
    expect(needsDetails({ updated_at: '2026-03-01T10:00:00Z' }, stored(), WANTED)).toBe(false);
  });

  it('fetches an item that moved', () => {
    expect(needsDetails({ updated_at: '2026-03-02T10:00:00Z' }, stored(), WANTED)).toBe(true);
  });

  it('fetches one it has never seen', () => {
    expect(needsDetails({ updated_at: '2026-03-01T10:00:00Z' }, undefined, WANTED)).toBe(true);
  });

  it('fetches one the list stored but the details phase never reached', () => {
    // An interrupted sync writes the row from the list page and stops before
    // the follow-ups. Nothing about that row looks stale afterwards.
    expect(
      needsDetails(
        { updated_at: '2026-03-01T10:00:00Z' },
        stored({ details_synced_at: null, details_parts: null }),
        WANTED,
      ),
    ).toBe(true);
  });

  it('fetches an item missing a resource that was switched on since', () => {
    /*
     * The hole a watermark could not see. `issueTimeline: false` to `true`
     * leaves every untouched item without a timeline — not on the next sync,
     * not ever — and the only symptom is a history that is quietly flat.
     */
    const withoutTimeline = stored({ details_parts: JSON.stringify(['comments']) });

    expect(needsDetails({ updated_at: '2026-03-01T10:00:00Z' }, withoutTimeline, WANTED)).toBe(
      true,
    );
    // ...and once it is wanted no longer, the same item is settled again.
    expect(
      needsDetails({ updated_at: '2026-03-01T10:00:00Z' }, withoutTimeline, ['comments']),
    ).toBe(false);
  });

  it('does not fetch anything when no resource is wanted', () => {
    // A repository configured with every detail resource off should make no
    // follow-up calls at all, whatever the timestamps say.
    expect(needsDetails({ updated_at: '2026-09-01T10:00:00Z' }, undefined, [])).toBe(false);
  });

  it('fetches when either timestamp is missing rather than guessing', () => {
    // The two outcomes are not equally bad: a wasted request costs one call,
    // a wrong skip leaves a stale answer with nothing to indicate it.
    expect(needsDetails({ updated_at: null }, stored(), WANTED)).toBe(true);
    expect(
      needsDetails({ updated_at: '2026-03-01T10:00:00Z' }, stored({ updated_at: null }), WANTED),
    ).toBe(true);
  });

  it('treats an unreadable parts value as nothing known', () => {
    expect(parseParts('not json')).toEqual([]);
    expect(parseParts(null)).toEqual([]);
    expect(parseParts('{"comments":true}')).toEqual([]);
    expect(parseParts('["comments"]')).toEqual(['comments']);
  });
});

describe('the configured window', () => {
  it('excludes what the operator said they do not care about', () => {
    // No amount of staleness makes an item outside `since` worth fetching:
    // that is what they asked for.
    expect(withinWindow({ updated_at: '2025-01-01T00:00:00Z' }, '2026-01-01T00:00:00Z')).toBe(
      false,
    );
    expect(withinWindow({ updated_at: '2026-06-01T00:00:00Z' }, '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('includes everything when no window was configured', () => {
    expect(withinWindow({ updated_at: '1999-01-01T00:00:00Z' }, null)).toBe(true);
  });

  it('excludes an item with no timestamp from a bounded window', () => {
    // It cannot be shown to be inside the window, and the window is an
    // explicit instruction rather than a guess to be resolved generously.
    expect(withinWindow({ updated_at: null }, '2026-01-01T00:00:00Z')).toBe(false);
    expect(withinWindow({ updated_at: null }, null)).toBe(true);
  });
});
