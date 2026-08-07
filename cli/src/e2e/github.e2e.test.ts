/**
 * End to end test against the live GitHub API.
 *
 * It syncs the issues and pull requests of this repository into a throwaway
 * database and asserts on what actually arrives, which is the only way to catch
 * the things a stubbed API cannot: pagination, real payload shapes, the
 * timeline media type, and cursors that have to survive a second run.
 *
 * The test needs a token and is skipped without one, so `npm test` stays
 * offline and deterministic for everybody.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseConfig } from '../config/load.js';
import type { ResolvedConfig } from '../config/types.js';
import { Database } from '../db/database.js';
import { SyncJournal } from '../db/journal.js';
import * as gh from '../db/queries/github.js';
import { nullLogger } from '../util/logger.js';
import { runSync } from '../sync/runner.js';
import { duplicateEvents } from '../testing/duplicates.js';

/**
 * Opt in explicitly: `DEVCONTEXT_E2E=1` or a token in `$DEVCONTEXT_E2E_TOKEN`.
 * `$GITHUB_TOKEN` is deliberately not used as a trigger, because a stale or
 * placeholder value in a shell should skip these tests, not fail them.
 */
const token = process.env.DEVCONTEXT_E2E_TOKEN ?? '';
const enabled = token !== '' || process.env.DEVCONTEXT_E2E === '1';
const repo = process.env.DEVCONTEXT_E2E_REPO ?? 'christoph-jerolimov/devcontext';

/** How far back the test syncs. Small enough to stay cheap, long enough to find data. */
const since = process.env.DEVCONTEXT_E2E_SINCE ?? '180d';

let workspace: string;
let config: ResolvedConfig;

function buildConfig(): ResolvedConfig {
  return parseConfig(
    `
sync:
  minDelayMs: 0
  progress: false
  # A test must fail fast instead of waiting out a rate limit window. The
  # unauthenticated budget is 60 requests per hour, and this sync needs ~30.
  rateLimitReserve: 2
  maxRetries: 2
  requestTimeoutMs: 30000
  # Fail with a clear message instead of sitting out an hour long window.
  maxRateLimitWaitMs: 20000
outputs:
  yaml:
    enabled: false
  markdown:
    enabled: false
github:
  hosts:
    - name: github.com
      tokenEnv: DEVCONTEXT_E2E_TOKEN
projects:
  - key: e2e
    github:
      - repo: ${repo}
        since: ${since}
        maxWorkflowRuns: 3
        sync:
          workflows: false
          workflowRuns: false
          workflowJobs: false
          workflowLogs: false
          milestones: false
`,
    { configPath: join(workspace, 'devcontext.yaml') },
  );
}

describe.skipIf(!enabled)('github end to end sync', () => {
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'devcontext-e2e-'));
    config = buildConfig();
  });

  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('syncs issues and pull requests, then continues incrementally', async () => {
    const first = await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    expect(first.results).toHaveLength(1);
    const [run] = first.results;
    // Surface the sync error itself rather than just "failed !== completed".
    expect(run?.error ?? null).toBeNull();
    expect(run?.status).toBe('completed');
    expect(run?.mode).toBe('initial');
    expect(first.apiCalls).toBeGreaterThan(0);

    const db = Database.open(config.databasePath, { create: false, readOnly: true });
    let counts: Record<string, number>;
    let pullRequestNumbers: number[];
    try {
      // --- the repository itself ---------------------------------------
      const repositories = gh.listRepositories(db);
      expect(repositories.map((row) => row.full_name)).toEqual([repo]);
      expect(repositories[0]?.default_branch).toBeTruthy();

      // --- pull requests -------------------------------------------------
      const pullRequests = gh.listPullRequests(db, { state: 'all' });
      expect(pullRequests.length).toBeGreaterThan(0);

      for (const pullRequest of pullRequests) {
        expect(pullRequest.repo_full_name).toBe(repo);
        expect(pullRequest.number).toBeGreaterThan(0);
        expect(pullRequest.title).toBeTruthy();
        expect(pullRequest.html_url).toContain(`${repo}/pull/${pullRequest.number}`);
      }

      // Every pull request GitHub reports also has to be in the issue table,
      // because that is the endpoint the sync walks.
      const issueRows = gh.listIssues(db, { state: 'all' });
      const asIssues = db.all<{ number: number }>(
        'SELECT number FROM gh_issues WHERE is_pull_request = 1 ORDER BY number',
      );
      expect(asIssues.map((row) => row.number)).toEqual(
        pullRequests.map((row) => row.number).toSorted((a, b) => a - b),
      );
      // Plain issues may legitimately be zero; the query still has to work.
      expect(Array.isArray(issueRows)).toBe(true);

      // --- everything that hangs off a pull request ----------------------
      // Deliberately not "the newest pull request": one opened seconds ago may
      // genuinely have no timeline events yet, and this test runs on merges.
      // What has to hold is that the sub-resources were fetched for the pull
      // requests that have them, and that their shapes are right.
      const withCommits = pullRequests.filter(
        (row) => gh.listCommits(db, repo, row.number).length > 0,
      );
      expect(withCommits.length).toBeGreaterThan(0);

      for (const pullRequest of withCommits) {
        const commits = gh.listCommits(db, repo, pullRequest.number);
        expect(commits.every((commit) => commit.sha.length === 40)).toBe(true);
      }

      const sample = withCommits[withCommits.length - 1] as gh.PullRequestRow;
      expect(gh.listChangedFiles(db, repo, sample.number).length).toBeGreaterThan(0);

      const timelines = pullRequests.map((row) => gh.listEvents(db, repo, row.number));
      expect(timelines.some((events) => events.length > 0)).toBe(true);
      for (const events of timelines) {
        expect(events.every((event) => event.event.length > 0)).toBe(true);
      }

      // --- bookkeeping ---------------------------------------------------
      const journal = new SyncJournal(db);
      const cursor = journal.getCursor(`github:github.com/${repo}:issues`);
      expect(cursor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(journal.listRuns().every((entry) => entry.status === 'completed')).toBe(true);

      counts = tableCounts(db);
      pullRequestNumbers = pullRequests.map((row) => row.number).toSorted((a, b) => a - b);
    } finally {
      db.close();
    }

    // --- second run: incremental, and nothing gets duplicated ------------
    const second = await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    expect(second.results[0]?.error ?? null).toBeNull();
    expect(second.results[0]?.status).toBe('completed');
    expect(second.results[0]?.mode).toBe('incremental');
    // The whole point of a cursor: the second pass costs a fraction of the first.
    expect(second.apiCalls).toBeLessThan(first.apiCalls);

    const db2 = Database.open(config.databasePath, { create: false, readOnly: true });
    try {
      /*
       * The counts are deliberately *not* compared for equality.
       *
       * This runs against a live repository, and on every merge to main — so a
       * pull request can land between the two syncs and legitimately change
       * every number. Asserting a snapshot made the test fail on exactly the
       * event it is meant to cover.
       *
       * What has to hold on a second pass is the invariant: nothing the first
       * run stored may disappear, and nothing may be stored twice.
       */
      const after = tableCounts(db2);
      const shrunk = Object.entries(counts)
        .filter(([table, before]) => (after[table] ?? 0) < before)
        .map(([table, before]) => `${table}: ${before} -> ${String(after[table])}`);
      expect(shrunk).toEqual([]);

      const numbersAfter = gh
        .listPullRequests(db2, { state: 'all' })
        .map((row) => row.number)
        .toSorted((a, b) => a - b);

      // Still every pull request from the first run...
      expect(numbersAfter).toEqual(expect.arrayContaining(pullRequestNumbers));
      // ...and each of them exactly once.
      expect(new Set(numbersAfter).size).toBe(numbersAfter.length);
      // The timeline is the one place a second pass can duplicate a row: its
      // key is synthesised, not given by the API. See testing/duplicates.ts.
      expect(duplicateEvents(db2)).toEqual([]);
    } finally {
      db2.close();
    }
  });
});

function tableCounts(db: Database): Record<string, number> {
  return {
    repositories: db.count('gh_repositories'),
    issues: db.count('gh_issues'),
    pullRequests: db.count('gh_pull_requests'),
    comments: db.count('gh_comments'),
    events: db.count('gh_events'),
    reviews: db.count('gh_reviews'),
    reviewComments: db.count('gh_review_comments'),
    commits: db.count('gh_commits'),
    files: db.count('gh_pull_request_files'),
  };
}
