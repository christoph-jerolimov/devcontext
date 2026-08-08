/**
 * The repository and Jira project the screenshots are taken of.
 *
 * Every timestamp is fixed and sits just before REFERENCE, which the browser
 * clock is frozen to. That is what makes the screenshots comparable: the
 * viewer renders "3d ago", and the insight and digest windows are computed in
 * the browser from the same frozen clock, so a run tomorrow produces the same
 * pixels as a run today.
 *
 * The data is deliberately varied — merged and open pull requests, a failing
 * workflow, a flaky step, work items in each status category — so that every
 * page in the navigation has something on it worth looking at.
 */

/** The instant the browser clock is frozen to. */
export const REFERENCE = '2026-03-02T09:00:00.000Z';

const day = 86_400_000;
const at = (daysBefore, hour = 12) => {
  const date = new Date(Date.parse(REFERENCE) - daysBefore * day);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
};

export const REPO = {
  id: 7,
  node_id: 'R_1',
  name: 'platform',
  full_name: 'acme/platform',
  owner: { id: 1, login: 'acme', type: 'Organization' },
  private: false,
  fork: false,
  archived: false,
  description: 'The service that keeps everything else running',
  default_branch: 'main',
  language: 'TypeScript',
  stargazers_count: 128,
  open_issues_count: 3,
  html_url: 'https://github.com/acme/platform',
  created_at: at(400),
  updated_at: at(1),
  pushed_at: at(1),
};

export const LABELS = [
  { id: 1, node_id: 'L_1', name: 'bug', color: 'd73a4a', description: 'Something is broken' },
  { id: 2, node_id: 'L_2', name: 'performance', color: '0e8a16', description: null },
  { id: 3, node_id: 'L_3', name: 'docs', color: '0075ca', description: null },
];

export const MILESTONES = [
  {
    id: 30,
    number: 1,
    title: 'v2.0',
    state: 'open',
    description: 'Scale to the biggest customers',
    open_issues: 2,
    closed_issues: 4,
    due_on: at(-14),
  },
];

const user = (login) => ({ id: login.length, login, type: 'User', avatar_url: '' });

/** Issues and pull requests, as the issues endpoint returns them together. */
export const ISSUES = [
  {
    id: 1001,
    node_id: 'I_1001',
    number: 12,
    title: 'Sync stalls on repositories with many pull requests',
    body: 'Above about 5000 pull requests the sync slows to a crawl.\n\nIt looks like the per-item calls are not being paced.',
    state: 'open',
    user: user('ada'),
    labels: [LABELS[0], LABELS[1]],
    assignees: [user('grace')],
    milestone: MILESTONES[0],
    comments: 2,
    created_at: at(21),
    updated_at: at(3),
    closed_at: null,
    html_url: 'https://github.com/acme/platform/issues/12',
  },
  {
    id: 1002,
    node_id: 'I_1002',
    number: 13,
    title: 'Document the rate limiter settings',
    body: 'The defaults are sensible but undocumented.',
    state: 'closed',
    state_reason: 'completed',
    user: user('grace'),
    labels: [LABELS[2]],
    assignees: [],
    comments: 1,
    created_at: at(30),
    updated_at: at(9),
    closed_at: at(9),
    html_url: 'https://github.com/acme/platform/issues/13',
  },
  {
    id: 1003,
    node_id: 'I_1003',
    number: 14,
    title: 'Timeline events are missing for old issues',
    body: 'Anything before the migration has no timeline.',
    state: 'open',
    user: user('linus'),
    labels: [LABELS[0]],
    assignees: [],
    comments: 0,
    created_at: at(120),
    updated_at: at(95),
    closed_at: null,
    html_url: 'https://github.com/acme/platform/issues/14',
  },
  {
    id: 2001,
    node_id: 'PR_2001',
    number: 42,
    title: 'PLAT-3: respect the secondary rate limit',
    body: 'Implements PLAT-3.\n\nBacks off when GitHub reports a secondary limit, instead of retrying immediately.',
    state: 'closed',
    user: user('ada'),
    labels: [LABELS[1]],
    assignees: [user('ada')],
    comments: 1,
    pull_request: { url: 'https://api.github.com/repos/acme/platform/pulls/42' },
    created_at: at(12),
    updated_at: at(6),
    closed_at: at(6),
    html_url: 'https://github.com/acme/platform/pull/42',
  },
  {
    id: 2002,
    node_id: 'PR_2002',
    number: 43,
    title: 'Show the remaining budget in the progress bar',
    body: 'Part of PLAT-4. Still a draft while the layout settles.',
    state: 'open',
    user: user('grace'),
    labels: [],
    assignees: [user('grace')],
    comments: 0,
    pull_request: { url: 'https://api.github.com/repos/acme/platform/pulls/43' },
    created_at: at(4),
    updated_at: at(2),
    closed_at: null,
    html_url: 'https://github.com/acme/platform/pull/43',
  },
];

export const PULL_NUMBERS = [42, 43];

export const PULLS = {
  42: {
    ...ISSUES[3],
    merged: true,
    merged_at: at(6),
    merged_by: user('linus'),
    draft: false,
    mergeable_state: 'clean',
    head: { ref: 'feature/PLAT-3-secondary-rate-limit', sha: 'a1b2c3d', repo: REPO },
    base: { ref: 'main', sha: 'f0e1d2c' },
    additions: 184,
    deletions: 26,
    changed_files: 5,
    commits: 3,
    requested_reviewers: [],
  },
  43: {
    ...ISSUES[4],
    merged: false,
    merged_at: null,
    draft: true,
    mergeable_state: 'clean',
    head: { ref: 'feature/progress-budget', sha: 'b2c3d4e', repo: REPO },
    base: { ref: 'main', sha: 'f0e1d2c' },
    additions: 41,
    deletions: 3,
    changed_files: 2,
    commits: 1,
    requested_reviewers: [user('ada')],
  },
};

export const REVIEWS = {
  42: [
    {
      id: 3001,
      user: user('linus'),
      state: 'CHANGES_REQUESTED',
      body: 'The back off looks right, but the ceiling should be configurable.',
      submitted_at: at(9),
      html_url: 'https://github.com/acme/platform/pull/42#pullrequestreview-3001',
    },
    {
      id: 3002,
      user: user('linus'),
      state: 'APPROVED',
      body: 'Much better, thank you.',
      submitted_at: at(7),
      html_url: 'https://github.com/acme/platform/pull/42#pullrequestreview-3002',
    },
  ],
  43: [],
};

export const REVIEW_COMMENTS = {
  42: [
    {
      id: 4001,
      pull_request_review_id: 3001,
      user: user('linus'),
      path: 'cli/src/sync/rateLimiter.ts',
      line: 88,
      body: 'Make this a setting rather than a constant.',
      diff_hunk: '@@ -85,6 +85,9 @@\n+    const ceiling = 60_000;',
      created_at: at(9),
    },
  ],
  43: [],
};

export const COMMITS = {
  42: [
    {
      sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      commit: {
        message: 'Respect the secondary rate limit',
        author: { name: 'Ada', email: 'ada@acme.test', date: at(12) },
        committer: { name: 'Ada', email: 'ada@acme.test', date: at(12) },
      },
      author: user('ada'),
      parents: [{ sha: 'f0e1d2c3b4a5' }],
    },
    {
      sha: 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a',
      commit: {
        message: 'Make the ceiling configurable',
        author: { name: 'Ada', email: 'ada@acme.test', date: at(8) },
        committer: { name: 'Ada', email: 'ada@acme.test', date: at(8) },
      },
      author: user('ada'),
      parents: [{ sha: 'a1b2c3d4e5f6' }],
    },
  ],
  43: [
    {
      sha: 'c3d4e5f60718293a4b5c6d7e8f90123456789abc',
      commit: {
        message: 'Show the remaining budget',
        author: { name: 'Grace', email: 'grace@acme.test', date: at(4) },
        committer: { name: 'Grace', email: 'grace@acme.test', date: at(4) },
      },
      author: user('grace'),
      parents: [{ sha: 'f0e1d2c3b4a5' }],
    },
  ],
};

export const FILES = {
  42: [
    {
      filename: 'cli/src/sync/rateLimiter.ts',
      status: 'modified',
      additions: 96,
      deletions: 18,
      changes: 114,
      patch: '@@ -85,6 +85,9 @@\n+    const ceiling = settings.maxRateLimitWaitMs;',
    },
    {
      filename: 'docs/sync.md',
      status: 'modified',
      additions: 88,
      deletions: 8,
      changes: 96,
      patch: '@@ -96,3 +96,8 @@\n+## Progress',
    },
  ],
  43: [
    {
      filename: 'cli/src/sync/progress.ts',
      status: 'modified',
      additions: 41,
      deletions: 3,
      changes: 44,
      patch: '@@ -70,2 +70,6 @@\n+  expectFor(key, count) {}',
    },
  ],
};

export const ISSUE_COMMENTS = {
  12: [
    {
      id: 5001,
      user: user('grace'),
      body: 'Reproduced on a repository with 8000 pull requests. It is the timeline calls.',
      created_at: at(18),
      updated_at: at(18),
      html_url: 'https://github.com/acme/platform/issues/12#issuecomment-5001',
    },
    {
      id: 5002,
      user: user('ada'),
      body: 'Probably the same root cause as PLAT-3.',
      created_at: at(15),
      updated_at: at(15),
      html_url: 'https://github.com/acme/platform/issues/12#issuecomment-5002',
    },
  ],
  13: [
    {
      id: 5003,
      user: user('ada'),
      body: 'Covered by the sync page now.',
      created_at: at(9),
      updated_at: at(9),
      html_url: 'https://github.com/acme/platform/issues/13#issuecomment-5003',
    },
  ],
  14: [],
  42: [
    {
      id: 5004,
      user: user('linus'),
      body: 'Merging — the follow up is tracked in PLAT-4.',
      created_at: at(6),
      updated_at: at(6),
      html_url: 'https://github.com/acme/platform/pull/42#issuecomment-5004',
    },
  ],
  43: [],
};

export const TIMELINES = {
  12: [
    { id: 6001, event: 'labeled', actor: user('ada'), label: { name: 'bug' }, created_at: at(21) },
    {
      id: 6002,
      event: 'assigned',
      actor: user('ada'),
      assignee: user('grace'),
      created_at: at(20),
    },
    {
      id: 6003,
      event: 'labeled',
      actor: user('grace'),
      label: { name: 'performance' },
      created_at: at(18),
    },
  ],
  13: [{ id: 6004, event: 'closed', actor: user('ada'), created_at: at(9) }],
  14: [],
  42: [
    {
      id: 6005,
      event: 'renamed',
      actor: user('ada'),
      rename: { from: 'Rate limit fix', to: 'PLAT-3: respect the secondary rate limit' },
      created_at: at(11),
    },
    { id: 6006, event: 'merged', actor: user('linus'), created_at: at(6) },
  ],
  43: [],
};

export const WORKFLOWS = [
  {
    id: 900,
    node_id: 'W_900',
    name: 'CI',
    path: '.github/workflows/ci.yml',
    state: 'active',
    html_url: 'https://github.com/acme/platform/actions/workflows/ci.yml',
    created_at: at(400),
    updated_at: at(40),
  },
];

export const RUNS = [
  {
    id: 7001,
    name: 'CI',
    workflow_id: 900,
    run_number: 812,
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    head_branch: 'feature/progress-budget',
    head_sha: 'b2c3d4e',
    actor: user('grace'),
    created_at: at(2),
    updated_at: at(2),
    run_started_at: at(2),
    html_url: 'https://github.com/acme/platform/actions/runs/7001',
  },
  {
    id: 7002,
    name: 'CI',
    workflow_id: 900,
    run_number: 811,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: 'a1b2c3d',
    actor: user('ada'),
    created_at: at(6),
    updated_at: at(6),
    run_started_at: at(6),
    html_url: 'https://github.com/acme/platform/actions/runs/7002',
  },
  {
    id: 7004,
    name: 'CI',
    workflow_id: 900,
    run_number: 809,
    event: 'push',
    status: 'completed',
    // Somebody stopped this one. It is not a failure and must not read as one.
    conclusion: 'cancelled',
    head_branch: 'main',
    head_sha: 'e5f6071',
    actor: user('ada'),
    created_at: at(13),
    updated_at: at(13),
    run_started_at: at(13),
    html_url: 'https://github.com/acme/platform/actions/runs/7004',
  },
  {
    id: 7003,
    name: 'CI',
    workflow_id: 900,
    run_number: 810,
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    head_branch: 'main',
    head_sha: 'd4e5f60',
    actor: user('linus'),
    created_at: at(11),
    updated_at: at(11),
    run_started_at: at(11),
    html_url: 'https://github.com/acme/platform/actions/runs/7003',
  },
];

const step = (number, name, conclusion, startedAt, seconds) => ({
  number,
  name,
  status: 'completed',
  conclusion,
  started_at: startedAt,
  completed_at: new Date(Date.parse(startedAt) + seconds * 1000).toISOString(),
});

/** The "Flaky steps" insight needs a step that fails on some runs and not others. */
export const JOBS = {
  7001: [
    {
      id: 8001,
      run_id: 7001,
      name: 'Check (Node 22)',
      status: 'completed',
      conclusion: 'failure',
      started_at: at(2, 10),
      completed_at: at(2, 10),
      html_url: 'https://github.com/acme/platform/actions/runs/7001/job/8001',
      steps: [
        step(1, 'Check out the repository', 'success', at(2, 10), 4),
        step(2, 'Install dependencies', 'success', at(2, 10), 31),
        step(3, 'Integration tests', 'failure', at(2, 10), 96),
      ],
    },
  ],
  7002: [
    {
      id: 8002,
      run_id: 7002,
      name: 'Check (Node 22)',
      status: 'completed',
      conclusion: 'success',
      started_at: at(6, 10),
      completed_at: at(6, 10),
      html_url: 'https://github.com/acme/platform/actions/runs/7002/job/8002',
      steps: [
        step(1, 'Check out the repository', 'success', at(6, 10), 3),
        step(2, 'Install dependencies', 'success', at(6, 10), 28),
        step(3, 'Integration tests', 'success', at(6, 10), 74),
      ],
    },
  ],
  7004: [
    {
      id: 8004,
      run_id: 7004,
      name: 'Check (Node 22)',
      status: 'completed',
      conclusion: 'cancelled',
      started_at: at(13, 10),
      completed_at: at(13, 10),
      html_url: 'https://github.com/acme/platform/actions/runs/7004/job/8004',
      steps: [
        step(1, 'Check out the repository', 'success', at(13, 10), 4),
        step(2, 'Install dependencies', 'cancelled', at(13, 10), 12),
      ],
    },
  ],
  7003: [
    {
      id: 8003,
      run_id: 7003,
      name: 'Check (Node 22)',
      status: 'completed',
      conclusion: 'failure',
      started_at: at(11, 10),
      completed_at: at(11, 10),
      html_url: 'https://github.com/acme/platform/actions/runs/7003/job/8003',
      steps: [
        step(1, 'Check out the repository', 'success', at(11, 10), 4),
        step(2, 'Install dependencies', 'success', at(11, 10), 30),
        step(3, 'Integration tests', 'failure', at(11, 10), 88),
      ],
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Jira                                                                        */
/* -------------------------------------------------------------------------- */

export const JIRA_PROJECT = {
  id: '10000',
  key: 'PLAT',
  name: 'Platform',
  projectTypeKey: 'software',
  lead: { displayName: 'Ada' },
};

export const JIRA_FIELDS = [
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
  { id: 'customfield_10016', name: 'Story Points', custom: true, schema: { type: 'number' } },
  { id: 'customfield_10020', name: 'Sprint', custom: true, schema: { type: 'array' } },
];

const jiraDate = (daysBefore, hour = 12) =>
  at(daysBefore, hour)
    .replace('Z', '+0000')
    .replace(/\.(\d{3})\+/, '.$1+');

const doc = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const SPRINT_7 = { id: 33, name: 'Sprint 7', state: 'active', boardId: 1 };

const workitem = (key, fields, changelog = []) => ({
  id: String(10000 + Number(key.split('-')[1])),
  key,
  fields: {
    project: { key: 'PLAT' },
    components: [],
    fixVersions: [],
    issuelinks: [],
    attachment: [],
    comment: { total: 0, comments: [] },
    ...fields,
  },
  changelog: { total: changelog.length, histories: changelog },
});

export const WORKITEMS = [
  workitem('PLAT-1', {
    summary: 'Make the sync survive big repositories',
    description: doc('Umbrella for the rate limiting work.'),
    issuetype: { name: 'Epic' },
    status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
    assignee: { displayName: 'Ada', accountId: 'a-1' },
    reporter: { displayName: 'Ada', accountId: 'a-1' },
    labels: ['platform'],
    created: jiraDate(60),
    updated: jiraDate(3),
  }),
  workitem(
    'PLAT-3',
    {
      summary: 'Respect the secondary rate limit',
      description: doc('Back off instead of retrying immediately.'),
      issuetype: { name: 'Story' },
      status: { name: 'Done', statusCategory: { name: 'Done' } },
      resolutiondate: jiraDate(6),
      resolution: { name: 'Done' },
      assignee: { displayName: 'Ada', accountId: 'a-1' },
      reporter: { displayName: 'Grace', accountId: 'g-1' },
      parent: { key: 'PLAT-1' },
      labels: ['backend'],
      customfield_10016: 5,
      customfield_10020: [SPRINT_7],
      created: jiraDate(20),
      updated: jiraDate(6),
      comment: {
        total: 1,
        comments: [
          {
            id: '9001',
            author: { displayName: 'Grace', accountId: 'g-1' },
            body: doc('Merged in acme/platform#42.'),
            created: jiraDate(6),
          },
        ],
      },
    },
    [
      {
        id: '9101',
        author: { displayName: 'Ada', accountId: 'a-1' },
        created: jiraDate(14),
        items: [
          { field: 'status', fieldtype: 'jira', fromString: 'To Do', toString: 'In Progress' },
        ],
      },
      {
        id: '9102',
        author: { displayName: 'Ada', accountId: 'a-1' },
        created: jiraDate(6),
        items: [
          { field: 'status', fieldtype: 'jira', fromString: 'In Progress', toString: 'Done' },
        ],
      },
    ],
  ),
  workitem(
    'PLAT-4',
    {
      summary: 'Show the remaining budget in the progress bar',
      description: doc('So a long sync says how much is left.'),
      issuetype: { name: 'Story' },
      status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
      assignee: { displayName: 'Grace', accountId: 'g-1' },
      reporter: { displayName: 'Ada', accountId: 'a-1' },
      parent: { key: 'PLAT-1' },
      labels: ['frontend'],
      customfield_10016: 3,
      customfield_10020: [SPRINT_7],
      created: jiraDate(10),
      updated: jiraDate(2),
    },
    [
      {
        id: '9103',
        author: { displayName: 'Grace', accountId: 'g-1' },
        created: jiraDate(5),
        items: [
          { field: 'status', fieldtype: 'jira', fromString: 'To Do', toString: 'In Progress' },
        ],
      },
    ],
  ),
  /*
   * Pulled into Sprint 7 three days after it started, and still open.
   *
   * The one work item here whose sprint membership *changed*, which is what
   * the burndown needs to have anything to say: without it every item was in
   * the sprint from the first day and the scope line is flat, so a report that
   * backdated mid-sprint arrivals would look identical to one that does not.
   */
  workitem(
    'PLAT-8',
    {
      summary: 'Audit what is stored on a laptop',
      description: doc('Security asked.'),
      issuetype: { name: 'Task' },
      status: { name: 'To Do', statusCategory: { name: 'To Do' } },
      reporter: { displayName: 'Linus', accountId: 'l-1' },
      labels: [],
      customfield_10016: 8,
      customfield_10020: [SPRINT_7],
      created: jiraDate(45),
      updated: jiraDate(4),
    },
    [
      {
        id: '9104',
        author: { displayName: 'Linus', accountId: 'l-1' },
        created: jiraDate(4),
        items: [{ field: 'Sprint', fieldtype: 'custom', fromString: '', toString: 'Sprint 7' }],
      },
    ],
  ),
];

export const BOARDS = [{ id: 1, name: 'Platform board', type: 'scrum' }];

export const SPRINTS = [
  {
    id: 33,
    name: 'Sprint 7',
    state: 'active',
    startDate: jiraDate(7),
    endDate: jiraDate(-7),
    goal: 'Stop the sync falling over on big repositories',
    originBoardId: 1,
  },
  {
    id: 32,
    name: 'Sprint 6',
    state: 'closed',
    startDate: jiraDate(21),
    endDate: jiraDate(7),
    goal: 'Cross links between GitHub and Jira',
    completeDate: jiraDate(7),
    originBoardId: 1,
  },
];

export const SPRINT_ISSUES = {
  33: [{ key: 'PLAT-3' }, { key: 'PLAT-4' }],
  32: [{ key: 'PLAT-8' }],
};
