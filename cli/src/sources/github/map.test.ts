import { describe, expect, it } from 'vitest';

import { nextPageUrl, statedTotal, totalFromLinkHeader } from './client.js';
import {
  isPullRequest,
  issueLabelRows,
  mapIssue,
  mapPullRequest,
  mapTimelineEvent,
  mapWorkflowSteps,
} from './map.js';

const REF = { host: 'github.com', repoId: 7, fullName: 'acme/platform' };
const SYNCED_AT = '2024-06-15T12:00:00.000Z';

describe('mapIssue', () => {
  const raw = {
    id: 100,
    number: 12,
    title: 'Something is broken',
    body: 'Steps to reproduce',
    state: 'closed',
    state_reason: 'completed',
    user: { login: 'alice' },
    labels: [{ name: 'bug' }, { name: 'ui' }],
    assignees: [{ login: 'bob' }],
    milestone: { title: 'v1.0' },
    comments: 3,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-02-01T00:00:00Z',
    closed_at: '2024-02-01T00:00:00Z',
    html_url: 'https://github.com/acme/platform/issues/12',
  };

  it('lifts the interesting fields into columns and keeps the payload', () => {
    const row = mapIssue(raw, REF, SYNCED_AT);

    expect(row.number).toBe(12);
    expect(row.repo_full_name).toBe('acme/platform');
    expect(row.author).toBe('alice');
    expect(row.labels).toBe('["bug","ui"]');
    expect(row.assignees).toBe('["bob"]');
    expect(row.milestone).toBe('v1.0');
    expect(row.is_pull_request).toBe(false);
    expect(JSON.parse(row.raw as string)).toEqual(raw);
  });

  it('detects pull requests', () => {
    expect(isPullRequest(raw)).toBe(false);
    expect(isPullRequest({ ...raw, pull_request: { url: 'x' } })).toBe(true);
    expect(mapIssue({ ...raw, pull_request: { url: 'x' } }, REF, SYNCED_AT).is_pull_request).toBe(
      true,
    );
  });

  it('produces one row per label', () => {
    expect(issueLabelRows(raw, 'github.com')).toEqual([
      { host: 'github.com', issue_id: 100, label_name: 'bug' },
      { host: 'github.com', issue_id: 100, label_name: 'ui' },
    ]);
  });
});

describe('mapTimelineEvent', () => {
  const issue = { id: 100, number: 12 };

  it('keeps label changes queryable', () => {
    const row = mapTimelineEvent(
      {
        id: 555,
        event: 'labeled',
        actor: { login: 'alice' },
        label: { name: 'bug' },
        created_at: '2024-01-02T00:00:00Z',
      },
      REF,
      issue,
      0,
      SYNCED_AT,
    );

    expect(row.uid).toBe('555');
    expect(row.event).toBe('labeled');
    expect(row.actor).toBe('alice');
    expect(row.label).toBe('bug');
  });

  it('keeps renames with their before and after values', () => {
    const row = mapTimelineEvent(
      {
        id: 556,
        event: 'renamed',
        actor: { login: 'bob' },
        rename: { from: 'old title', to: 'new title' },
        created_at: '2024-01-03T00:00:00Z',
      },
      REF,
      issue,
      1,
      SYNCED_AT,
    );

    expect(row.from_value).toBe('old title');
    expect(row.to_value).toBe('new title');
  });

  it('builds a stable uid for events without an id (commits, reviews)', () => {
    const row = mapTimelineEvent(
      { event: 'committed', committer: { name: 'ci', date: '2024-01-04T00:00:00Z' } },
      REF,
      issue,
      4,
      SYNCED_AT,
    );

    expect(row.uid).toBe('100:committed:2024-01-04T00:00:00Z:4');
    expect(row.actor).toBe('ci');
  });
});

describe('mapPullRequest', () => {
  it('marks merged pull requests even when the merged flag is missing', () => {
    const row = mapPullRequest(
      {
        id: 5,
        number: 42,
        title: 'Add a thing',
        state: 'closed',
        merged_at: '2024-03-01T00:00:00Z',
        head: { ref: 'feature', sha: 'abc' },
        base: { ref: 'main' },
        user: { login: 'alice' },
      },
      REF,
      SYNCED_AT,
    );

    expect(row.merged).toBe(true);
    expect(row.head_ref).toBe('feature');
    expect(row.base_ref).toBe('main');
  });
});

describe('mapWorkflowSteps', () => {
  it('computes the step duration', () => {
    const [step] = mapWorkflowSteps(
      {
        id: 9,
        run_id: 3,
        steps: [
          {
            number: 1,
            name: 'Checkout',
            status: 'completed',
            conclusion: 'success',
            started_at: '2024-01-01T10:00:00Z',
            completed_at: '2024-01-01T10:00:30Z',
          },
        ],
      },
      'github.com',
      SYNCED_AT,
    );

    expect(step?.job_id).toBe(9);
    expect(step?.duration_ms).toBe(30_000);
  });
});

describe('nextPageUrl', () => {
  it('extracts the next link', () => {
    const header =
      '<https://api.github.com/repositories/1/issues?page=2>; rel="next", ' +
      '<https://api.github.com/repositories/1/issues?page=9>; rel="last"';
    expect(nextPageUrl(header)).toBe('https://api.github.com/repositories/1/issues?page=2');
  });

  it('returns null on the last page', () => {
    expect(nextPageUrl('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
  });
});

describe('totalFromLinkHeader', () => {
  /*
   * Asked for one item per page, the last page number is the item count. This
   * is what lets the sync size the job in one request per resource instead of
   * discovering it while walking, so the arithmetic is worth pinning down.
   */
  it('reads the count off the last page number', () => {
    const header =
      '<https://api.github.com/repositories/1/issues?per_page=1&page=2>; rel="next", ' +
      '<https://api.github.com/repositories/1/issues?per_page=1&page=273>; rel="last"';
    expect(totalFromLinkHeader(header, 1)).toBe(273);
  });

  it('trusts the body when there is no header at all', () => {
    // GitHub omits Link entirely when everything fits on one page, which at
    // one item per page means zero or one item.
    expect(totalFromLinkHeader(null, 1)).toBe(1);
    expect(totalFromLinkHeader(null, 0)).toBe(0);
  });

  it('treats a header with neither next nor last as a single page', () => {
    expect(totalFromLinkHeader('<https://api.github.com/x?page=1>; rel="first"', 1)).toBe(1);
  });

  it('does not help with an object shaped response, which is what statedTotal is for', () => {
    // `/actions/runs` answers `{ total_count, workflow_runs: [...] }`. It is
    // not an array, so nothing can be counted on the page, and a single page
    // response carries no Link header either — which read as zero runs and
    // left the whole workflow run slice unsized.
    expect(totalFromLinkHeader(null, 0)).toBe(0);
  });

  it('takes the endpoint at its word when it states a total', () => {
    expect(statedTotal({ total_count: 273, workflow_runs: [] })).toBe(273);
    expect(statedTotal({ total_count: 0, workflow_runs: [] })).toBe(0);
  });

  it('ignores anything that is not an object with an honest total', () => {
    expect(statedTotal([{ id: 1 }])).toBeNull();
    expect(statedTotal(null)).toBeNull();
    expect(statedTotal({ workflow_runs: [] })).toBeNull();
    expect(statedTotal({ total_count: '273' })).toBeNull();
    expect(statedTotal({ total_count: -1 })).toBeNull();
    expect(statedTotal({ total_count: 1.5 })).toBeNull();
  });

  it('says "no idea" rather than guessing when there is a next but no last', () => {
    // Cursor paginated endpoints report a next page without a total; a wrong
    // number here would be worse than admitting the size is unknown.
    expect(totalFromLinkHeader('<https://api.github.com/x?after=abc>; rel="next"', 1)).toBeNull();
  });

  it('says "no idea" when the last link has no usable page number', () => {
    for (const last of [
      '<https://api.github.com/x?page=nope>; rel="last"',
      '<https://api.github.com/x?page=0>; rel="last"',
      '<https://api.github.com/x>; rel="last"',
    ]) {
      expect(totalFromLinkHeader(last, 1)).toBeNull();
    }
  });
});
