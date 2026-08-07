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
      const newest = pullRequests.reduce((best, row) => (row.number > best.number ? row : best));
      const timeline = gh.listEvents(db, repo, newest.number);
      expect(timeline.length).toBeGreaterThan(0);
      expect(timeline.every((event) => event.event.length > 0)).toBe(true);

      const commits = gh.listCommits(db, repo, newest.number);
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.every((commit) => commit.sha.length === 40)).toBe(true);

      const files = gh.listChangedFiles(db, repo, newest.number);
      expect(files.length).toBeGreaterThan(0);

      // --- bookkeeping ---------------------------------------------------
      const journal = new SyncJournal(db);
      const cursor = journal.getCursor(`github:github.com/${repo}:issues`);
      expect(cursor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(journal.listRuns().every((entry) => entry.status === 'completed')).toBe(true);

      counts = tableCounts(db);
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
    expect(second.apiCalls).toBeLessThan(first.apiCalls);

    const db2 = Database.open(config.databasePath, { create: false, readOnly: true });
    try {
      expect(tableCounts(db2)).toEqual(counts);
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
