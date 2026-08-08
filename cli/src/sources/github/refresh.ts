/**
 * Deciding which items are worth a per-item request.
 *
 * The list walk is cheap and complete — every issue and pull request, every
 * sync. What costs is the second phase: comments, timelines, reviews, commits
 * and changed files, one request each. On a repository with 20,000 issues that
 * is 200 list pages against 40,000 follow-ups, so the only question that
 * matters for the size of a sync is which items get skipped.
 *
 * ## What this replaces
 *
 * A watermark: "newer than the newest thing the last run saw". Nearly right,
 * and wrong in two ways that never announced themselves.
 *
 * It **over-fetched**. Anything that changed between the previous run's newest
 * timestamp and the moment that run finished sits at or after the watermark, so
 * its details were fetched again even though the stored copy was already
 * current.
 *
 * It **under-fetched, permanently**. Turning on a detail resource that was off
 * — `issueTimeline: false` to `true` — left the watermark far ahead of every
 * item that had not been touched since. Those items never got a timeline, and
 * nothing said so: the sync reported success, the rows were there, and only the
 * history built from those timelines was quietly flat. The fix was `--full`,
 * which nobody knew to run.
 *
 * ## What it does instead
 *
 * Compares each listed item against the copy already stored, and records which
 * detail resources were fetched for it. An item is fetched again when it has
 * genuinely changed, or when it is missing a resource that is wanted now.
 */

/** The per-item resources a sync can fetch, named as they are stored. */
export type DetailPart =
  | 'comments'
  | 'timeline'
  /*
   * The pull request half. `review_comments` rather than `comments` because a
   * pull request has both — the conversation and the notes on the diff — and
   * one name for two resources would let a repository that fetched only one of
   * them look complete.
   */
  | 'reviews'
  | 'review_comments'
  | 'commits'
  | 'files';

export interface StoredItem {
  updated_at: string | null;
  /** JSON array of the parts fetched, or null when details never ran. */
  details_parts: string | null;
  details_synced_at: string | null;
}

export function parseParts(value: string | null | undefined): DetailPart[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? (parsed.filter((p) => typeof p === 'string') as DetailPart[])
      : [];
  } catch {
    // A hand-edited or truncated value means "nothing known", which errs
    // towards fetching — the safe direction.
    return [];
  }
}

/**
 * Whether this item's per-item resources have to be fetched.
 *
 * Every branch that returns true errs towards fetching, because the two
 * outcomes are not equally bad: fetching something already current costs one
 * request, and skipping something stale leaves a wrong answer in the database
 * with nothing to indicate it.
 */
export function needsDetails(
  listed: { updated_at: string | null },
  stored: StoredItem | undefined,
  wanted: readonly DetailPart[],
): boolean {
  // Nothing wanted, nothing to do — a repository synced with every detail
  // resource off should make no follow-up calls at all.
  if (wanted.length === 0) return false;

  // Never stored, or stored by the list walk while the details phase never
  // ran (an interrupted sync, or a resume that stopped between phases).
  if (stored === undefined || stored.details_synced_at === null) return true;

  // A missing timestamp on either side cannot be compared. Fetching is the
  // safe direction.
  if (listed.updated_at === null || stored.updated_at === null) return true;

  // The item genuinely moved since the copy we hold. ISO 8601 strings sort
  // chronologically, which is why they are stored as text.
  if (listed.updated_at > stored.updated_at) return true;

  /*
   * A resource that was off when this item was last fetched and is on now.
   *
   * This is the case a watermark could not see: the item has not changed, so
   * nothing about it looks stale, and without this it would never get the
   * newly wanted resource — not on the next sync, not ever.
   */
  const have = new Set(parseParts(stored.details_parts));
  return wanted.some((part) => !have.has(part));
}

/**
 * Whether an item falls inside the configured window at all.
 *
 * Separate from `needsDetails` because it answers a different question:
 * `since` is what the operator asked for ("I do not care about anything older
 * than a year"), and no amount of staleness makes an item they excluded worth
 * fetching. The list still stores every item — only the follow-ups are bounded
 * — because the balance carried in from before the window is exactly what a
 * partial list cannot recover.
 */
export function withinWindow(listed: { updated_at: string | null }, since: string | null): boolean {
  if (since === null) return true;
  return listed.updated_at !== null && listed.updated_at >= since;
}
