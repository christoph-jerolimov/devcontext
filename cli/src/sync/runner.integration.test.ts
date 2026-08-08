import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseConfig } from '../config/load.js';
import type { ResolvedConfig } from '../config/types.js';
import { Database } from '../db/database.js';
import { SyncJournal } from '../db/journal.js';
import * as gh from '../db/queries/github.js';
import * as jira from '../db/queries/jira.js';
import { nullLogger } from '../util/logger.js';
import { duplicateEvents, type DuplicateEvent } from '../testing/duplicates.js';
import { runSync } from './runner.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const ISSUE = {
  id: 100,
  number: 12,
  title: 'Sync is slow',
  body: 'It takes ages',
  state: 'open',
  user: { id: 1, login: 'alice', type: 'User' },
  labels: [{ id: 1, name: 'bug' }],
  assignees: [{ id: 2, login: 'bob', type: 'User' }],
  comments: 1,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-02-01T00:00:00Z',
  html_url: 'https://github.com/acme/platform/issues/12',
};

const PULL_AS_ISSUE = {
  id: 200,
  number: 42,
  title: 'Speed up the sync',
  body: 'Batches the API calls',
  state: 'closed',
  user: { id: 1, login: 'alice', type: 'User' },
  labels: [],
  assignees: [],
  comments: 0,
  pull_request: { url: 'https://api.github.com/repos/acme/platform/pulls/42' },
  created_at: '2024-01-10T00:00:00Z',
  updated_at: '2024-03-01T00:00:00Z',
  html_url: 'https://github.com/acme/platform/pull/42',
};

const WORKITEM = {
  id: '10001',
  key: 'PLAT-42',
  fields: {
    project: { key: 'PLAT' },
    summary: 'Improve the sync',
    description: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body text' }] }],
    },
    issuetype: { name: 'Story' },
    status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
    assignee: { displayName: 'Alice', accountId: 'a-1' },
    labels: ['backend'],
    components: [],
    fixVersions: [],
    created: '2024-01-01T10:00:00.000+0000',
    updated: '2024-02-01T10:00:00.000+0000',
    customfield_10016: 5,
    customfield_10020: [{ id: 33, name: 'Sprint 7' }],
    comment: {
      total: 1,
      comments: [
        {
          id: '5000',
          author: { displayName: 'Bob', accountId: 'b-1' },
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Agreed' }] }],
          },
          created: '2024-01-15T10:00:00.000+0000',
        },
      ],
    },
    issuelinks: [
      {
        id: '7000',
        type: { name: 'Blocks', outward: 'blocks' },
        outwardIssue: { key: 'PLAT-43', fields: { summary: 'Docs', status: { name: 'To Do' } } },
      },
    ],
    attachment: [],
  },
  // Deliberately incomplete so the syncer has to fetch the full changelog.
  changelog: { total: 2, histories: [] },
};

const CHANGELOG_HISTORIES = [
  {
    id: '900',
    author: { displayName: 'Alice', accountId: 'a-1' },
    created: '2024-01-20T10:00:00.000+0000',
    items: [{ field: 'status', fieldtype: 'jira', fromString: 'To Do', toString: 'In Progress' }],
  },
  {
    id: '901',
    author: { displayName: 'Alice', accountId: 'a-1' },
    created: '2024-01-21T10:00:00.000+0000',
    items: [{ field: 'labels', fieldtype: 'jira', fromString: '', toString: 'backend' }],
  },
];

/* -------------------------------------------------------------------------- */
/* Stubbed API                                                                 */
/* -------------------------------------------------------------------------- */

const requestedUrls: string[] = [];

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      ...headers,
    },
  });
}

/**
 * A paginated list response, the way GitHub sends one.
 *
 * The size probe the sync uses asks for one item per page and reads the item
 * count off `rel="last"`, so a stub that ignored `per_page` would return the
 * whole list and make the probe look right for the wrong reason.
 */
function page(url: URL, all: unknown[]): Response {
  const perPage = Number(url.searchParams.get('per_page') ?? '100');
  const current = Number(url.searchParams.get('page') ?? '1');
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  const slice = all.slice((current - 1) * perPage, current * perPage);

  if (pages <= 1) return json(slice);

  const link = (rel: string, target: number): string =>
    `<${url.origin}${url.pathname}?per_page=${String(perPage)}&page=${String(target)}>; rel="${rel}"`;
  const parts = [link('last', pages)];
  if (current < pages) parts.unshift(link('next', current + 1));

  return json(slice, { link: parts.join(', ') });
}

/**
 * A pull request that only exists once this is set, so a test can simulate the
 * repository changing between two syncs — which is what actually happens when
 * CI runs on a merge.
 */
let mergedDuringTheRun = false;

const LATE_PULL_AS_ISSUE = {
  id: 201,
  number: 43,
  title: 'Merged while the sync was running',
  body: 'Landed between the two passes',
  state: 'closed',
  user: { id: 1, login: 'alice', type: 'User' },
  labels: [],
  assignees: [],
  comments: 0,
  pull_request: { url: 'https://api.github.com/repos/acme/platform/pulls/43' },
  created_at: '2024-03-02T00:00:00Z',
  updated_at: '2024-03-03T00:00:00Z',
  html_url: 'https://github.com/acme/platform/pull/43',
};

function route(rawUrl: string): Response {
  const url = new URL(rawUrl);
  // A second repository answers with the same fixtures below. Only the test
  // that checks the phase ordering configures one, and what it needs is that
  // the repository exists and returns the same shapes, not different data.
  if (url.pathname === '/repos/acme/platform-docs') {
    return json({
      id: 556,
      name: 'platform-docs',
      full_name: 'acme/platform-docs',
      default_branch: 'main',
      open_issues_count: 0,
      stargazers_count: 0,
    });
  }
  const path = url.pathname.replace('/repos/acme/platform-docs/', '/repos/acme/platform/');

  if (mergedDuringTheRun) {
    if (path === '/repos/acme/platform/issues/43') return json(LATE_PULL_AS_ISSUE);
    if (path === '/repos/acme/platform/issues/43/comments') return json([]);
    if (path === '/repos/acme/platform/issues/43/timeline') return json([]);
    if (path === '/repos/acme/platform/pulls/43') {
      return json({
        ...LATE_PULL_AS_ISSUE,
        merged: true,
        merged_at: '2024-03-03T00:00:00Z',
        merged_by: { login: 'bob' },
        head: { ref: 'feature/late', sha: 'ccc333', repo: { full_name: 'acme/platform' } },
        base: { ref: 'main', sha: 'bbb222' },
        additions: 1,
        deletions: 0,
        changed_files: 1,
        commits: 1,
      });
    }
    if (path === '/repos/acme/platform/pulls/43/reviews') return json([]);
    if (path === '/repos/acme/platform/pulls/43/comments') return json([]);
    if (path === '/repos/acme/platform/pulls/43/commits') {
      return json([
        {
          sha: 'dec0de1',
          commit: {
            message: 'Land it',
            author: { name: 'Alice', email: 'alice@acme.test', date: '2024-03-03T00:00:00Z' },
            committer: { name: 'Alice', date: '2024-03-03T00:00:00Z' },
          },
          author: { login: 'alice' },
          parents: [{ sha: 'beef' }],
        },
      ]);
    }
    if (path === '/repos/acme/platform/pulls/43/files') {
      return json([
        { filename: 'README.md', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      ]);
    }
  }

  // ---- GitHub -------------------------------------------------------------
  if (path === '/repos/acme/platform') {
    return json({
      id: 7,
      name: 'platform',
      full_name: 'acme/platform',
      owner: { login: 'acme' },
      private: false,
      default_branch: 'main',
      html_url: 'https://github.com/acme/platform',
      updated_at: '2024-03-01T00:00:00Z',
    });
  }
  if (path === '/repos/acme/platform/labels') {
    return json([{ id: 1, name: 'bug', color: 'ff0000' }]);
  }
  if (path === '/repos/acme/platform/milestones') {
    return json([{ id: 3, number: 1, title: 'v1.0', state: 'open' }]);
  }
  if (path === '/repos/acme/platform/issues') {
    const all = mergedDuringTheRun
      ? [ISSUE, PULL_AS_ISSUE, LATE_PULL_AS_ISSUE]
      : [ISSUE, PULL_AS_ISSUE];
    return page(url, all);
  }
  // Only ever asked for as a count probe: the sync itself derives its pull
  // requests from the issue list.
  if (path === '/repos/acme/platform/pulls') {
    return page(url, mergedDuringTheRun ? [PULL_AS_ISSUE, LATE_PULL_AS_ISSUE] : [PULL_AS_ISSUE]);
  }
  if (path === '/repos/acme/platform/issues/12') return json(ISSUE);
  if (path === '/repos/acme/platform/issues/42') return json(PULL_AS_ISSUE);
  if (path === '/repos/acme/platform/issues/12/comments') {
    return json([
      {
        id: 500,
        user: { id: 2, login: 'bob', type: 'User' },
        body: 'Confirmed',
        created_at: '2024-01-05T00:00:00Z',
      },
    ]);
  }
  if (path === '/repos/acme/platform/issues/42/comments') return json([]);
  if (path === '/repos/acme/platform/issues/12/timeline') {
    return json([
      {
        id: 900,
        event: 'labeled',
        actor: { login: 'alice' },
        label: { name: 'bug' },
        created_at: '2024-01-02T00:00:00Z',
      },
      {
        id: 901,
        event: 'assigned',
        actor: { login: 'alice' },
        assignee: { login: 'bob' },
        created_at: '2024-01-03T00:00:00Z',
      },
    ]);
  }
  if (path === '/repos/acme/platform/issues/42/timeline') {
    return json([
      { id: 902, event: 'closed', actor: { login: 'alice' }, created_at: '2024-03-01T00:00:00Z' },
    ]);
  }
  if (path === '/repos/acme/platform/pulls/42') {
    return json({
      ...PULL_AS_ISSUE,
      merged: true,
      merged_at: '2024-03-01T00:00:00Z',
      merged_by: { login: 'bob' },
      head: { ref: 'feature/speed', sha: 'aaa111', repo: { full_name: 'acme/platform' } },
      base: { ref: 'main', sha: 'bbb222' },
      additions: 40,
      deletions: 12,
      changed_files: 3,
      commits: 2,
    });
  }
  if (path === '/repos/acme/platform/pulls/42/reviews') {
    return json([
      {
        id: 600,
        user: { id: 2, login: 'bob', type: 'User' },
        state: 'APPROVED',
        body: 'Looks good',
        submitted_at: '2024-02-28T00:00:00Z',
      },
    ]);
  }
  if (path === '/repos/acme/platform/pulls/42/comments') {
    return json([
      {
        id: 700,
        pull_request_review_id: 600,
        user: { id: 2, login: 'bob', type: 'User' },
        body: 'Nice',
        path: 'src/sync.ts',
        line: 10,
        diff_hunk: '@@ -1 +1 @@',
        created_at: '2024-02-28T00:00:00Z',
      },
    ]);
  }
  if (path === '/repos/acme/platform/pulls/42/commits') {
    return json([
      {
        sha: 'c0ffee1',
        commit: {
          message: 'Batch the calls',
          author: { name: 'Alice', email: 'alice@acme.test', date: '2024-02-20T00:00:00Z' },
          committer: { name: 'Alice', date: '2024-02-20T00:00:00Z' },
        },
        author: { login: 'alice' },
        parents: [{ sha: 'beef' }],
      },
    ]);
  }
  if (path === '/repos/acme/platform/pulls/42/files') {
    return json([
      {
        filename: 'src/sync.ts',
        status: 'modified',
        additions: 40,
        deletions: 12,
        changes: 52,
        patch: '@@',
      },
    ]);
  }
  if (path === '/repos/acme/platform/actions/workflows') {
    return json({
      total_count: 1,
      workflows: [{ id: 55, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }],
    });
  }
  if (path === '/repos/acme/platform/actions/runs') {
    return json({
      total_count: 1,
      workflow_runs: [
        {
          id: 1001,
          workflow_id: 55,
          name: 'CI',
          run_number: 17,
          run_attempt: 1,
          event: 'push',
          status: 'completed',
          conclusion: 'failure',
          head_branch: 'main',
          head_sha: 'aaa111',
          actor: { login: 'alice' },
          created_at: '2024-03-02T00:00:00Z',
          updated_at: '2024-03-02T00:10:00Z',
        },
      ],
    });
  }
  if (path === '/repos/acme/platform/actions/runs/1001/jobs') {
    // Three jobs, deliberately: a run with one job cannot tell an estimate of
    // "one job per run" apart from a correct one.
    return json({
      total_count: 3,
      jobs: [
        { id: 2002, run_id: 1001, name: 'lint', status: 'completed', conclusion: 'success' },
        { id: 2003, run_id: 1001, name: 'docs', status: 'completed', conclusion: 'success' },
        {
          id: 2001,
          run_id: 1001,
          name: 'build',
          status: 'completed',
          conclusion: 'failure',
          started_at: '2024-03-02T00:00:00Z',
          completed_at: '2024-03-02T00:05:00Z',
          runner_name: 'ubuntu-latest',
          steps: [
            {
              number: 1,
              name: 'Checkout',
              status: 'completed',
              conclusion: 'success',
              started_at: '2024-03-02T00:00:00Z',
              completed_at: '2024-03-02T00:00:30Z',
            },
            {
              number: 2,
              name: 'Test',
              status: 'completed',
              conclusion: 'failure',
              started_at: '2024-03-02T00:00:30Z',
              completed_at: '2024-03-02T00:05:00Z',
            },
          ],
        },
      ],
    });
  }
  if (path === '/repos/acme/platform/actions/jobs/2001/logs') {
    return new Response('2024-03-02T00:00:01Z npm test\nfailed', { status: 200 });
  }
  if (/\/actions\/jobs\/(2002|2003)\/logs$/.test(path)) {
    return new Response('2024-03-02T00:00:01Z ok', { status: 200 });
  }

  // ---- Jira ---------------------------------------------------------------
  if (path === '/rest/api/3/project/PLAT') {
    return json({ id: '1', key: 'PLAT', name: 'Platform', projectTypeKey: 'software' });
  }
  if (path === '/rest/api/3/field') {
    return json([
      { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
      {
        id: 'customfield_10016',
        name: 'Story point estimate',
        custom: true,
        schema: { type: 'number' },
      },
    ]);
  }
  if (path === '/rest/api/3/search/approximate-count') {
    return json({ count: 1 });
  }
  if (path === '/rest/api/3/search/jql') {
    return json({ issues: [WORKITEM] });
  }
  if (path === '/rest/api/3/issue/PLAT-42/changelog') {
    return json({ total: 2, values: CHANGELOG_HISTORIES });
  }
  if (path === '/rest/agile/1.0/board') {
    return json({
      isLast: true,
      total: 1,
      values: [{ id: 1, name: 'PLAT board', type: 'scrum', location: { projectKey: 'PLAT' } }],
    });
  }
  if (path === '/rest/agile/1.0/board/1/sprint') {
    return json({
      isLast: true,
      // Three, for the same reason as the jobs above.
      values: [
        {
          id: 33,
          name: 'Sprint 7',
          state: 'active',
          startDate: '2024-01-15T00:00:00.000Z',
          endDate: '2024-01-29T00:00:00.000Z',
          originBoardId: 1,
        },
        { id: 34, name: 'Sprint 8', state: 'future', originBoardId: 1 },
        { id: 35, name: 'Sprint 6', state: 'closed', originBoardId: 1 },
      ],
    });
  }
  if (path === '/rest/agile/1.0/sprint/33/issue') {
    return json({ total: 1, issues: [{ id: '10001', key: 'PLAT-42' }] });
  }
  if (/\/sprint\/(34|35)\/issue$/.test(path)) return json({ total: 0, issues: [] });

  return new Response(JSON.stringify({ message: `unexpected request ${path}` }), { status: 404 });
}

/**
 * Which phase a request belongs to, by shape rather than by name — a
 * collection, an individual thing a collection named, or something hanging
 * off an individual thing.
 */
function phaseOf(rawUrl: string): 'lists' | 'items' | 'details' | null {
  const path = new URL(rawUrl).pathname;

  if (/\/(issues|pulls)\/\d+\/(comments|timeline|reviews|commits|files)$/.test(path)) {
    return 'details';
  }
  if (/\/actions\/runs\/\d+\/jobs$/.test(path)) return 'details';
  if (/\/actions\/jobs\/\d+\/logs$/.test(path)) return 'details';
  if (/\/sprint\/\d+\/issue$/.test(path)) return 'details';

  if (/\/pulls\/\d+$/.test(path)) return 'items';
  if (/\/board\/\d+\/sprint$/.test(path)) return 'items';

  if (/\/(issues|labels|milestones|releases)$/.test(path)) return 'lists';
  if (/\/actions\/(runs|workflows)$/.test(path)) return 'lists';
  if (path.startsWith('/rest/api/3/search')) return 'lists';
  if (path === '/rest/agile/1.0/board') return 'lists';

  // The repository, the project, the field catalogue: preludes that belong
  // to no phase and are not what this test is about.
  return null;
}

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

let workspace: string;
let config: ResolvedConfig;

const CONFIG_YAML = `
sync:
  minDelayMs: 0
  progress: false
github:
  hosts:
    - name: github.com
      apiUrl: https://api.github.com
      token: test-token
jira:
  sites:
    - name: acme
      baseUrl: https://acme.atlassian.net
      email: bot@acme.test
      token: test-token
      fields:
        customfield_10016: storyPoints
        customfield_10020: sprint
projects:
  - key: demo
    name: Demo
    github:
      - repo: acme/platform
        sync:
          workflowLogs: true
    jira:
      - site: acme
        project: PLAT
        filter: labels != security
`;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'devcontext-test-'));
  config = parseConfig(CONFIG_YAML, { configPath: join(workspace, 'devcontext.yaml') });
  requestedUrls.length = 0;
  mergedDuringTheRun = false;

  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    requestedUrls.push(url);
    return route(url);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(workspace, { recursive: true, force: true });
});

function readCursors(): Record<string, string | null> {
  const db = Database.open(config.databasePath, { create: false, readOnly: true });
  try {
    return Object.fromEntries(
      new SyncJournal(db).listState().map((row) => [row.scope, row.cursor]),
    );
  } finally {
    db.close();
  }
}

interface Snapshot {
  issues: number[];
  pullRequests: number[];
  comments: number;
  events: number;
  duplicatedEvents: DuplicateEvent[];
}

function snapshot(): Snapshot {
  const db = Database.open(config.databasePath, { create: false, readOnly: true });
  try {
    return {
      issues: db
        .all<{ number: number }>('SELECT number FROM gh_issues ORDER BY number')
        .map((row) => row.number),
      pullRequests: db
        .all<{ number: number }>('SELECT number FROM gh_pull_requests ORDER BY number')
        .map((row) => row.number),
      comments: db.count('gh_comments'),
      events: db.count('gh_events'),
      duplicatedEvents: duplicateEvents(db),
    };
  } finally {
    db.close();
  }
}

describe('runSync', () => {
  it('downloads everything on the initial sync and writes the outputs', async () => {
    const summary = await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: true,
    });

    expect(summary.results.map((result) => [result.source, result.status, result.mode])).toEqual([
      ['github', 'completed', 'initial'],
      ['jira', 'completed', 'initial'],
    ]);
    expect(summary.apiCalls).toBeGreaterThan(10);

    const db = Database.open(config.databasePath, { create: false, readOnly: true });
    try {
      // --- GitHub ---------------------------------------------------------
      expect(gh.listRepositories(db).map((repo) => repo.full_name)).toEqual(['acme/platform']);

      const issues = gh.listIssues(db, { state: 'all' });
      expect(issues.map((issue) => issue.number)).toEqual([12]);
      expect(issues[0]?.labels).toBe('["bug"]');

      expect(gh.listComments(db, 'acme/platform', 12)).toHaveLength(1);
      expect(gh.listEvents(db, 'acme/platform', 12).map((event) => event.event)).toEqual([
        'labeled',
        'assigned',
      ]);

      const pulls = gh.listPullRequests(db, { state: 'all' });
      expect(pulls.map((pull) => pull.number)).toEqual([42]);
      expect(pulls[0]?.merged).toBe(1);
      expect(pulls[0]?.additions).toBe(40);
      expect(gh.listReviews(db, 'acme/platform', 42).map((review) => review.state)).toEqual([
        'APPROVED',
      ]);
      expect(gh.listReviewComments(db, 'acme/platform', 42)).toHaveLength(1);
      expect(gh.listCommits(db, 'acme/platform', 42).map((commit) => commit.sha)).toEqual([
        'c0ffee1',
      ]);
      expect(gh.listChangedFiles(db, 'acme/platform', 42)).toHaveLength(1);
      // The closed event of the pull request landed in the event table as well.
      expect(gh.listEvents(db, 'acme/platform', 42).map((event) => event.event)).toEqual([
        'closed',
      ]);

      expect(gh.listWorkflows(db)).toHaveLength(1);
      const runs = gh.listWorkflowRuns(db);
      expect(runs.map((run) => run.conclusion)).toEqual(['failure']);
      const jobs = gh.listWorkflowJobs(db, { runId: runs[0]!.id });
      expect(jobs.map((job) => job.name).toSorted()).toEqual(['build', 'docs', 'lint']);
      const build = jobs.find((job) => job.name === 'build');
      expect(build?.duration_ms).toBe(300_000);
      const steps = gh.listWorkflowSteps(db, { jobId: build!.id });
      expect(steps.map((step) => step.name)).toEqual(['Checkout', 'Test']);
      expect(gh.getJobLog(db, 2001)?.content).toContain('npm test');

      // --- Jira -----------------------------------------------------------
      const workitems = jira.listWorkitems(db);
      expect(workitems.map((item) => item.key)).toEqual(['PLAT-42']);
      expect(workitems[0]?.story_points).toBe(5);
      expect(workitems[0]?.sprint_name).toBe('Sprint 7');
      expect(workitems[0]?.description).toBe('Body text');
      expect(jira.listJiraComments(db, 'PLAT-42')).toHaveLength(1);
      // Two history entries, fetched from the changelog endpoint.
      expect(jira.listChangelog(db, 'PLAT-42').map((entry) => entry.field)).toEqual([
        'status',
        'labels',
      ]);
      expect(jira.listLinks(db, 'PLAT-42')).toHaveLength(1);
      expect(
        jira
          .listSprints(db)
          .map((sprint) => sprint.name)
          .toSorted(),
      ).toEqual(['Sprint 6', 'Sprint 7', 'Sprint 8']);
      expect(jira.listSprintWorkitems(db, 33).map((item) => item.key)).toEqual(['PLAT-42']);
      expect(
        jira.listJiraFields(db, { onlyMapped: true }).map((field) => field.mapped_name),
      ).toEqual(['storyPoints']);

      // --- Bookkeeping ----------------------------------------------------
      const journal = new SyncJournal(db);
      expect(journal.getCursor('github:github.com/acme/platform:issues')).toBe(
        '2024-03-01T00:00:00Z',
      );
      expect(journal.getCursor('jira:acme/PLAT:workitems')).toBe('2024-02-01T10:00:00.000Z');
      expect(journal.listRuns()).toHaveLength(2);
      expect(journal.listRuns().every((run) => run.status === 'completed')).toBe(true);
    } finally {
      db.close();
    }

    // --- Outputs ----------------------------------------------------------
    const markdown = readFileSync(
      join(config.outputs.markdown.path, 'github/acme__platform/issues/000012.md'),
      'utf8',
    );
    expect(markdown).toContain('# acme/platform#12 Sync is slow');
    expect(markdown).toContain('Confirmed');

    const yaml = readFileSync(
      join(config.outputs.yaml.path, 'jira/acme/PLAT/workitems/PLAT-42.yaml'),
      'utf8',
    );
    expect(yaml).toContain('key: PLAT-42');
    expect(yaml).toContain('storyPoints: 5');

    expect(
      readFileSync(join(config.outputs.markdown.path, 'github/acme__platform/index.md'), 'utf8'),
    ).toContain('Pull requests (1)');
  });

  it('continues from the stored cursor on the next run', async () => {
    await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    requestedUrls.length = 0;

    const summary = await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    expect(summary.results.map((result) => result.mode)).toEqual(['incremental', 'incremental']);

    /*
     * The cursor no longer bounds the *list*. Every issue is listed on every
     * run, because how many were open on a past day cannot be answered from
     * the ones that changed since — the balance carried in from before is the
     * part that would be missing, and no later sync recovers it.
     */
    // The size probes are excluded: one of them deliberately asks with the
    // cursor, because pricing the follow ups needs the count of what changed.
    const issueRequests = requestedUrls.filter(
      (url) => /\/issues\?/.test(url) && !/[?&]per_page=1(&|$)/.test(url),
    );
    expect(issueRequests.length).toBeGreaterThan(0);
    expect(issueRequests.every((url) => !url.includes('since='))).toBe(true);

    /*
     * What the cursor bounds instead is the request per item, which is where
     * the cost of a sync actually is.
     *
     * Issue 12 last changed on 2024-02-01 and the cursor stands at 2024-03-01,
     * so the second run listed it and asked nothing further about it. Pull
     * request 42 sits exactly on the cursor and is fetched again — the
     * boundary item always is, so that nothing can fall through it, and
     * writing it a second time changes nothing because every write is an
     * upsert.
     */
    const perItem = requestedUrls.filter((url) =>
      /\/(comments|timeline|reviews|commits|files)(\?|$)/.test(url),
    );
    expect(perItem.some((url) => url.includes('/issues/12/'))).toBe(false);
    expect(perItem.some((url) => url.includes('/42/'))).toBe(true);

    const jqlRequest = requestedUrls.find((url) => url.includes('/search/jql'));
    expect(jqlRequest).toBeDefined();
  });

  it('keeps everything exactly once when a pull request lands between two runs', async () => {
    /*
     * The scenario the live end to end test kept failing on: CI runs on a
     * merge, so the repository changes while the two passes are running. The
     * counts legitimately grow — what must not happen is a row disappearing or
     * being stored twice.
     */
    await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    const before = snapshot();
    expect(before.pullRequests).toEqual([42]);

    mergedDuringTheRun = true;

    await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    const after = snapshot();

    // The new pull request arrived...
    expect(after.pullRequests).toEqual([42, 43]);
    // ...nothing from the first pass was lost...
    expect(after.issues).toEqual(expect.arrayContaining(before.issues));
    expect(after.comments).toBeGreaterThanOrEqual(before.comments);
    expect(after.events).toBeGreaterThanOrEqual(before.events);
    // ...and nothing was stored twice.
    expect(new Set(after.pullRequests).size).toBe(after.pullRequests.length);
    expect(new Set(after.issues).size).toBe(after.issues.length);
    expect(after.duplicatedEvents).toEqual([]);
    // The first pass has to be clean too, or the second proves nothing.
    expect(before.duplicatedEvents).toEqual([]);
  });

  it('leaves the database untouched on a dry run', async () => {
    await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: true,
      progress: false,
      writeOutputs: true,
    });

    const db = Database.open(config.databasePath, { create: false, readOnly: true });
    try {
      expect(gh.listIssues(db, { state: 'all' })).toHaveLength(0);
      expect(jira.listWorkitems(db)).toHaveLength(0);
      // The run itself is still recorded so the history stays complete.
      expect(new SyncJournal(db).listRuns()).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('syncs one item directly without moving any cursor, then the rest', async () => {
    // A first full sync establishes the cursors.
    await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    const before = readCursors();
    expect(before['github:github.com/acme/platform:issues']).toBe('2024-03-01T00:00:00Z');

    // Now a targeted sync of the pull request only.
    requestedUrls.length = 0;
    const targeted = await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
      only: ['acme/platform#42'],
      targetedOnly: true,
    });

    expect(targeted.results).toEqual([
      expect.objectContaining({ source: 'github', mode: 'targeted', status: 'completed' }),
    ]);
    // It went straight at the item instead of walking the list.
    expect(requestedUrls.some((url) => url.includes('/issues/42'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/issues?'))).toBe(false);

    // The cursors must be exactly as they were: a targeted item can be newer
    // than things the regular sync has not fetched yet, and advancing the
    // cursor to it would skip that window for good.
    expect(readCursors()).toEqual(before);

    // And nothing was duplicated.
    const db = Database.open(config.databasePath, { create: false, readOnly: true });
    try {
      expect(gh.listPullRequests(db, { state: 'all' })).toHaveLength(1);
      expect(gh.listReviews(db, 'acme/platform', 42)).toHaveLength(1);
      expect(gh.listCommits(db, 'acme/platform', 42)).toHaveLength(1);
      expect(gh.listEvents(db, 'acme/platform', 42)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('follows a targeted item up with the regular sync by default', async () => {
    const summary = await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
      only: ['PLAT-42'],
    });

    expect(summary.results.map((result) => result.mode)).toEqual([
      'targeted',
      'initial',
      'initial',
    ]);
    expect(summary.results.every((result) => result.status === 'completed')).toBe(true);

    const db = Database.open(config.databasePath, { create: false, readOnly: true });
    try {
      // The work item was written once by the targeted run and once by the
      // regular one; upserts mean there is still exactly one row.
      expect(jira.listWorkitems(db)).toHaveLength(1);
      expect(jira.listJiraComments(db, 'PLAT-42')).toHaveLength(1);
      expect(jira.listChangelog(db, 'PLAT-42')).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('rejects a reference that does not belong to the configuration', async () => {
    await expect(
      runSync({
        config,
        logger: nullLogger,
        full: false,
        dryRun: false,
        progress: false,
        writeOutputs: false,
        only: ['other/repo#1'],
        targetedOnly: true,
      }),
    ).rejects.toThrow(/No GitHub repository "other\/repo"/);

    await expect(
      runSync({
        config,
        logger: nullLogger,
        full: false,
        dryRun: false,
        progress: false,
        writeOutputs: false,
        only: ['NOPE-1'],
        targetedOnly: true,
      }),
    ).rejects.toThrow(/No Jira project "NOPE"/);
  });

  it('sizes every target before fetching anything, and gets it right', async () => {
    /*
     * The complaint this answers: the expected call count used to climb every
     * time another resource group was reached, so the percentage and the time
     * remaining meant nothing until the sync was nearly over.
     *
     * Two things have to hold. The counting requests must all come before the
     * work, and the number they produce must match what the sync then spends.
     */
    const lines: string[] = [];
    const summary = await runSync({
      config,
      logger: { ...nullLogger, info: (message: string) => lines.push(message) },
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    // --- the counting happens first ---------------------------------------
    const probes = requestedUrls
      .map((url, index) => ({ url, index }))
      // `per_page=1` exactly — `per_page=100` contains it as a prefix.
      .filter(({ url }) => /[?&]per_page=1(&|$)/.test(url) || url.includes('approximate-count'));
    const work = requestedUrls
      .map((url, index) => ({ url, index }))
      .filter(({ url }) => /\/(comments|timeline|reviews|commits|files)(\?|$)/.test(url));

    expect(probes.length).toBeGreaterThan(0);
    expect(work.length).toBeGreaterThan(0);
    const lastProbe = Math.max(...probes.map((entry) => entry.index));
    const firstWork = Math.min(...work.map((entry) => entry.index));
    expect(lastProbe).toBeLessThan(firstWork);

    // --- and the number it announced was already the right one ------------
    const planned = lines.find((line) => line.startsWith('Planned '));
    expect(planned).toBeDefined();

    const predicted = Number(/about (\d+) API call/.exec(planned ?? '')?.[1]);
    expect(predicted).toBeGreaterThan(0);

    /*
     * The figure printed before the first item is fetched, against what the
     * run actually cost. Being close is the whole point — a plan that is only
     * accurate once the work is done is the behaviour this replaced.
     *
     * On a *first* sync it cannot be exact, and the shortfall is specific:
     * neither API can be asked how many jobs a workflow run has or how many
     * sprints hang off a board without listing them, and an empty database has
     * nothing to go on either. Everything else is priced up front.
     */
    expect(predicted).toBeGreaterThanOrEqual(Math.round(summary.apiCalls * 0.7));
    expect(predicted).toBeLessThanOrEqual(Math.round(summary.apiCalls * 1.15));
  });

  it('prices the jobs and the sprints from the last sync, so the second is exact', async () => {
    // The two ratios a cold database cannot know. This fixture has three jobs
    // on its run and three sprints on its board, so an estimate of "one each"
    // is visibly wrong rather than accidentally right.
    await runSync({
      config,
      logger: nullLogger,
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    const lines: string[] = [];
    const summary = await runSync({
      config,
      logger: { ...nullLogger, info: (message: string) => void lines.push(message) },
      // Ignore the cursors, so the second run does the same work as the first
      // and the two figures are comparable.
      full: true,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    const planned = lines.find((line) => line.startsWith('Planned '));
    const predicted = Number(/about (\d+) API call/.exec(planned ?? '')?.[1]);

    /*
     * One call out, and it is a known one: the survey reserves a comments
     * request per work item, and a Jira search usually returns the comments
     * embedded so the request is never made. Whether it will is a property of
     * the individual item, not a ratio, so nothing up front can predict it.
     *
     * The two this change is about are worth six calls here — three job logs
     * and three sprint memberships — so the bound below fails if either
     * regresses, while staying honest about what is left.
     */
    expect(predicted).toBeGreaterThanOrEqual(summary.apiCalls);
    expect(predicted).toBeLessThanOrEqual(summary.apiCalls + 1);
  });

  it('only syncs the requested source', async () => {
    const summary = await runSync({
      config,
      logger: nullLogger,
      sources: ['jira'],
      full: false,
      dryRun: false,
      progress: false,
      writeOutputs: false,
    });

    expect(summary.results.map((result) => result.source)).toEqual(['jira']);
    expect(requestedUrls.every((url) => !url.includes('api.github.com'))).toBe(true);
  });

  describe('the three phases', () => {
    const TWO_REPOSITORIES = CONFIG_YAML.replace(
      '      - repo: acme/platform\n',
      '      - repo: acme/platform\n      - repo: acme/platform-docs\n',
    );

    it('finishes every list, for every target, before fetching anything they named', async () => {
      config = parseConfig(TWO_REPOSITORIES, { configPath: join(workspace, 'devcontext.yaml') });

      await runSync({
        config,
        logger: nullLogger,
        full: false,
        dryRun: false,
        progress: false,
        writeOutputs: false,
      });

      const phases = requestedUrls.map(phaseOf).filter((phase) => phase !== null);

      // Both repositories and the Jira project were actually reached, or the
      // ordering below would hold for an empty run just as well.
      expect(requestedUrls.some((url) => url.includes('/acme/platform/issues?'))).toBe(true);
      expect(requestedUrls.some((url) => url.includes('/acme/platform-docs/issues?'))).toBe(true);
      expect(phases.filter((phase) => phase === 'details').length).toBeGreaterThan(4);

      const lastOf = (phase: string): number => phases.lastIndexOf(phase);
      const firstOf = (phase: string): number => phases.indexOf(phase);

      expect(lastOf('lists')).toBeLessThan(firstOf('items'));
      expect(lastOf('items')).toBeLessThan(firstOf('details'));
    });

    it('leaves the cursor alone when the detail phase fails', async () => {
      // The list phase writes the issues; the comments come a phase later. A
      // cursor advanced in between would claim they were synced with comments
      // that were never fetched, and nothing would ever go back for them.
      config = parseConfig(
        CONFIG_YAML.replace('  minDelayMs: 0', '  minDelayMs: 0\n  maxRetries: 0'),
        {
          configPath: join(workspace, 'devcontext.yaml'),
        },
      );

      const failing = vi.fn<(input: string | URL | Request) => Promise<Response>>(async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        requestedUrls.push(url);
        if (url.includes('/issues/12/comments')) throw new Error('network went away');
        return route(url);
      });
      vi.stubGlobal('fetch', failing);

      const summary = await runSync({
        config,
        logger: nullLogger,
        full: false,
        dryRun: false,
        progress: false,
        writeOutputs: false,
      });

      expect(summary.results.find((result) => result.source === 'github')?.status).toBe('failed');

      const cursors = readCursors();
      expect(cursors['github:github.com/acme/platform:issues']).toBeUndefined();
      // Jira is a separate target and was not affected by the GitHub failure.
      expect(summary.results.find((result) => result.source === 'jira')?.status).toBe('completed');
    });
  });
});
