/**
 * Linking a pull request to the issue it fixes.
 *
 * Two sources, and the point of having both is that they fail differently.
 * GitHub's own timeline is exact but only records that something referred to
 * something — it does not say the referrer promised to close it. A closing
 * keyword says exactly that and has to be read out of prose. Neither alone
 * answers "which pull request fixed this".
 *
 * A wrong link here looks identical to a right one, which is why the negative
 * cases outnumber the positive ones.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import { linksFor } from '../db/queries/links.js';
import { buildContributors } from '../contributors/build.js';
import { contributionsOf } from '../db/queries/contributors.js';
import { buildCrossLinks, crossReferenceSource } from './build.js';

let db: Database;

const SYNCED = '2026-06-01T00:00:00.000Z';

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
});

afterEach(() => {
  db.close();
});

function issue(row: {
  id: number;
  number: number;
  author?: string;
  body?: string;
  pull?: boolean;
  repo?: string;
}): void {
  db.upsert('gh_issues', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: row.repo ?? 'acme/platform',
    number: row.number,
    title: `Item ${String(row.number)}`,
    body: row.body ?? null,
    state: 'open',
    author: row.author ?? 'ada',
    assignees: '[]',
    is_pull_request: row.pull ?? false,
    created_at: '2026-03-01T09:00:00Z',
    updated_at: '2026-03-05T09:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
  });
}

function pull(row: { id: number; number: number; body?: string; author?: string }): void {
  issue({ id: row.id, number: row.number, pull: true, author: row.author ?? 'grace' });
  db.upsert('gh_pull_requests', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: row.number,
    title: `Pull ${String(row.number)}`,
    body: row.body ?? null,
    state: 'open',
    author: row.author ?? 'grace',
    assignees: '[]',
    created_at: '2026-03-01T09:00:00Z',
    updated_at: '2026-03-05T09:00:00Z',
    synced_at: SYNCED,
    raw: '{}',
  });
}

/** A `cross-referenced` event on `onIssue`, produced by `from`. */
function crossReference(row: {
  uid: string;
  onIssueId: number;
  onIssueNumber: number;
  fromNumber: number;
  fromIsPull?: boolean;
  fromRepo?: string;
}): void {
  db.upsert('gh_events', {
    host: 'github.com',
    uid: row.uid,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    issue_id: row.onIssueId,
    issue_number: row.onIssueNumber,
    event: 'cross-referenced',
    actor: 'grace',
    created_at: '2026-03-04T09:00:00Z',
    synced_at: SYNCED,
    raw: JSON.stringify({
      event: 'cross-referenced',
      source: {
        type: 'issue',
        issue: {
          number: row.fromNumber,
          repository: { full_name: row.fromRepo ?? 'acme/platform' },
          ...(row.fromIsPull === false ? {} : { pull_request: { url: 'https://api…' } }),
        },
      },
    }),
  });
}

function linkedTo(ref: string): Array<{ ref: string; via: string }> {
  return linksFor(db, ref).map((link) => ({ ref: link.ref, via: link.via }));
}

describe('a pull request that says it fixes an issue', () => {
  it('links both ways from one row', () => {
    // The link is stored once, from the pull request towards the issue, and
    // read from either end — so "which pull request fixed this" and "what did
    // this pull request fix" are the same row.
    issue({ id: 1, number: 12, author: 'linus' });
    pull({ id: 2, number: 42, body: 'Fixes #12' });
    buildCrossLinks(db);

    expect(linkedTo('acme/platform#42')).toEqual([{ ref: 'acme/platform#12', via: 'closes' }]);
    expect(linkedTo('acme/platform#12')).toEqual([{ ref: 'acme/platform#42', via: 'closes' }]);
  });

  it('does not link a mention', () => {
    /*
     * The distinction the whole feature rests on. Both bodies contain "#12";
     * only one of them means the issue is finished when this lands, and a
     * release note built from the other would be wrong.
     */
    issue({ id: 1, number: 12 });
    pull({ id: 2, number: 42, body: 'Similar to #12, but for the other endpoint.' });
    buildCrossLinks(db);

    expect(linkedTo('acme/platform#42')).toEqual([]);
  });

  it('ignores a reference to something not synced', () => {
    // A dangling link is worse than none: it renders as a row nobody can open.
    pull({ id: 2, number: 42, body: 'Fixes #999' });
    buildCrossLinks(db);

    expect(linkedTo('acme/platform#42')).toEqual([]);
    expect(buildCrossLinks(db).danglingGithubRefs).toContain('acme/platform#999');
  });

  it('does not link a pull request to itself', () => {
    pull({ id: 2, number: 42, body: 'Fixes #42' });
    buildCrossLinks(db);

    expect(linkedTo('acme/platform#42')).toEqual([]);
  });
});

describe("what GitHub's own timeline already knows", () => {
  it('links a pull request that referred to an issue', () => {
    /*
     * The structured source. GitHub resolved the reference itself, so there is
     * no prose to misread — and the payload is already in gh_events.raw, synced
     * with the timeline and until now never read, so this costs no API call.
     */
    issue({ id: 1, number: 12 });
    pull({ id: 2, number: 42 });
    crossReference({ uid: 'x1', onIssueId: 1, onIssueNumber: 12, fromNumber: 42 });
    buildCrossLinks(db);

    expect(linkedTo('acme/platform#12')).toEqual([{ ref: 'acme/platform#42', via: 'timeline' }]);
  });

  it('prefers the closing keyword when both sources agree', () => {
    // One row, not two: the same pair found twice is one relationship, and the
    // more specific word for it wins.
    issue({ id: 1, number: 12 });
    pull({ id: 2, number: 42, body: 'Fixes #12' });
    crossReference({ uid: 'x1', onIssueId: 1, onIssueNumber: 12, fromNumber: 42 });
    buildCrossLinks(db);

    // One row, and the more specific reason is the one shown. Left to the
    // order SQLite happened to return, this was a coin toss.
    expect(linkedTo('acme/platform#12')).toEqual([{ ref: 'acme/platform#42', via: 'closes' }]);
  });

  it('reads the referring item out of the payload rather than guessing', () => {
    expect(
      crossReferenceSource(
        JSON.stringify({ source: { issue: { number: 7, pull_request: {} } } }),
        'acme/platform',
      ),
    ).toEqual({ ref: 'acme/platform#7', isPullRequest: true });

    // Another repository entirely: the payload names it, so nothing is assumed.
    expect(
      crossReferenceSource(
        JSON.stringify({
          source: { issue: { number: 7, repository: { full_name: 'other/repo' } } },
        }),
        'acme/platform',
      ),
    ).toEqual({ ref: 'other/repo#7', isPullRequest: false });
  });

  it('returns nothing rather than half a link from an unusable payload', () => {
    // Inventing a link from a payload that is not the expected shape is how a
    // wrong one gets in, and a wrong link is indistinguishable from a right one.
    expect(crossReferenceSource('not json', 'acme/platform')).toBeNull();
    expect(crossReferenceSource('{}', 'acme/platform')).toBeNull();
    expect(crossReferenceSource(JSON.stringify({ source: { issue: {} } }), 'a/b')).toBeNull();
    expect(
      crossReferenceSource(JSON.stringify({ source: { issue: { number: 0 } } }), 'a/b'),
    ).toBeNull();
  });
});

describe('who gets credit for the fix', () => {
  it('counts whoever raised the issue as a contributor to the pull request', () => {
    /*
     * They wrote the problem statement and are the one who can say whether it
     * was solved, and until now they appeared nowhere near the pull request.
     */
    issue({ id: 1, number: 12, author: 'linus' });
    pull({ id: 2, number: 42, body: 'Fixes #12', author: 'grace' });
    buildCrossLinks(db);
    buildContributors(db);

    const roles = contributionsOf(db, ['acme/platform#42'])
      .filter((row) => row.identity === 'linus')
      .map((row) => row.role);

    expect(roles).toEqual(['raised']);
  });

  it('does not credit the author of an issue that was merely mentioned', () => {
    // Otherwise every contributor list on a chatty repository quietly inflates.
    issue({ id: 1, number: 12, author: 'linus' });
    pull({ id: 2, number: 42, body: 'Similar to #12.', author: 'grace' });
    buildCrossLinks(db);
    buildContributors(db);

    expect(contributionsOf(db, ['acme/platform#42']).map((row) => row.identity)).not.toContain(
      'linus',
    );
  });

  it('keeps the credit on the pull request, not on the issue', () => {
    // "raised" says what they did for the pull request. On their own issue
    // they are simply the author, which is already recorded.
    issue({ id: 1, number: 12, author: 'linus' });
    pull({ id: 2, number: 42, body: 'Fixes #12' });
    buildCrossLinks(db);
    buildContributors(db);

    const onIssue = contributionsOf(db, ['acme/platform#12']).filter(
      (row) => row.identity === 'linus',
    );

    expect(onIssue.map((row) => row.role)).toEqual(['author']);
  });
});
