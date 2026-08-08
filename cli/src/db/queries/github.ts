import type { Database } from '../database.js';
import { limitClause, orderClause, WhereBuilder } from './filters.js';
import { eachDay } from './history.js';
import type { PagingOptions } from './filters.js';
import { anyPerson, isABot, notABot } from './people.js';

export interface RepositoryRow {
  host: string;
  id: number;
  owner: string;
  name: string;
  full_name: string;
  private: number;
  archived: number;
  description: string | null;
  default_branch: string | null;
  stars: number | null;
  open_issues: number | null;
  html_url: string | null;
  updated_at: string | null;
  pushed_at: string | null;
  synced_at: string;
}

export interface IssueRow {
  host: string;
  id: number;
  repo_full_name: string;
  number: number;
  title: string | null;
  body: string | null;
  state: string | null;
  state_reason: string | null;
  author: string | null;
  assignees: string | null;
  labels: string | null;
  milestone: string | null;
  comment_count: number | null;
  is_pull_request: number;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  html_url: string | null;
}

export interface PullRequestRow extends IssueRow {
  draft: number;
  merged: number;
  head_ref: string | null;
  base_ref: string | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  commit_count: number | null;
  merged_at: string | null;
  merged_by: string | null;
}

export interface WorkflowRow {
  host: string;
  id: number;
  repo_full_name: string;
  name: string | null;
  path: string | null;
  state: string | null;
  updated_at: string | null;
  run_count?: number;
  last_run_at?: string | null;
}

export interface WorkflowRunRow {
  host: string;
  id: number;
  repo_full_name: string;
  workflow_id: number | null;
  workflow_name: string | null;
  name: string | null;
  run_number: number | null;
  run_attempt: number | null;
  event: string | null;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string | null;
  actor: string | null;
  created_at: string | null;
  updated_at: string | null;
  html_url: string | null;
}

export interface WorkflowJobRow {
  host: string;
  id: number;
  repo_full_name: string;
  run_id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  runner_name: string | null;
  html_url: string | null;
}

export interface WorkflowStepRow {
  host: string;
  job_id: number;
  run_id: number | null;
  number: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
}

export interface CommentRow {
  id: number;
  issue_number: number | null;
  author: string | null;
  body: string | null;
  created_at: string | null;
  updated_at: string | null;
  html_url: string | null;
}

export interface EventRow {
  uid: string;
  issue_number: number | null;
  event: string;
  actor: string | null;
  created_at: string | null;
  label: string | null;
  assignee: string | null;
  milestone: string | null;
  from_value: string | null;
  to_value: string | null;
  commit_sha: string | null;
}

export interface ReviewRow {
  id: number;
  pr_number: number | null;
  author: string | null;
  state: string | null;
  body: string | null;
  submitted_at: string | null;
  html_url: string | null;
}

export interface ReviewCommentRow {
  id: number;
  pr_number: number | null;
  review_id: number | null;
  author: string | null;
  body: string | null;
  path: string | null;
  line: number | null;
  diff_hunk: string | null;
  created_at: string | null;
}

export interface CommitRow {
  sha: string;
  pr_number: number | null;
  message: string | null;
  author_name: string | null;
  author_login: string | null;
  committed_at: string | null;
}

export interface IssueFilter extends PagingOptions {
  repos?: string[] | undefined;
  state?: 'open' | 'closed' | 'all' | undefined;
  labels?: string[] | undefined;
  author?: string | undefined;
  assignee?: string | undefined;
  milestone?: string | undefined;
  search?: string | undefined;
  createdSince?: string | undefined;
  createdBefore?: string | undefined;
  updatedSince?: string | undefined;
  /** Only items whose last update is older than this timestamp (stale items). */
  updatedBefore?: string | undefined;
  closedSince?: string | undefined;
  sort?: 'updated' | 'created' | 'number' | undefined;
  order?: 'asc' | 'desc' | undefined;
  numbers?: number[] | undefined;
  /**
   * GitHub logins of the selected people or teams, lower cased.
   *
   * Matches the author *or* an assignee, because "the platform team's issues"
   * means both the ones they raised and the ones they were handed, and a filter
   * that answered only one of those would need the other one named every time.
   * `author` and `assignee` are still there when only one side is wanted.
   */
  people?: string[] | undefined;
  /** Drop rows written by a bot. */
  excludeBots?: boolean | undefined;
  /** Keep only rows written by a bot. */
  onlyBots?: boolean | undefined;
  /** Logins configured as bots, lower cased; the `[bot]` suffix is found anyway. */
  bots?: string[] | undefined;
}

export interface PullRequestFilter extends IssueFilter {
  draft?: boolean | undefined;
  merged?: boolean | undefined;
  baseRef?: string | undefined;
  reviewer?: string | undefined;
}

export interface WorkflowRunFilter extends PagingOptions {
  repos?: string[] | undefined;
  workflow?: string | undefined;
  status?: string | undefined;
  conclusion?: string | undefined;
  branch?: string | undefined;
  event?: string | undefined;
  actor?: string | undefined;
  createdSince?: string | undefined;
  createdBefore?: string | undefined;
  search?: string | undefined;
}

export function listRepositories(
  db: Database,
  options: { search?: string | undefined } & PagingOptions = {},
): RepositoryRow[] {
  const where = new WhereBuilder().addSearch(['full_name', 'description'], options.search);
  const paging = limitClause(options);
  return db.all<RepositoryRow>(
    `SELECT * FROM gh_repositories ${where.sql} ORDER BY full_name ASC${paging.sql}`,
    [...where.values, ...paging.params],
  );
}

export function getRepository(db: Database, fullName: string): RepositoryRow | undefined {
  return db.get<RepositoryRow>('SELECT * FROM gh_repositories WHERE full_name = ?', [fullName]);
}

function applyIssueFilters(where: WhereBuilder, filter: IssueFilter): WhereBuilder {
  where.addIn('repo_full_name', filter.repos);
  if (filter.state && filter.state !== 'all') where.add('state = ?', filter.state);
  where.addIf(filter.author, 'LOWER(author) = ?', filter.author?.toLowerCase());
  where.addIf(filter.milestone, 'milestone = ?', filter.milestone);
  where.addIf(filter.createdSince, 'created_at >= ?', filter.createdSince);
  where.addIf(filter.createdBefore, 'created_at < ?', filter.createdBefore);
  where.addIf(filter.updatedSince, 'updated_at >= ?', filter.updatedSince);
  where.addIf(filter.updatedBefore, 'updated_at < ?', filter.updatedBefore);
  where.addIf(filter.closedSince, 'closed_at >= ?', filter.closedSince);
  where.addSearch(['title', 'body'], filter.search);

  if (filter.assignee) {
    where.add(`LOWER(assignees) LIKE ?`, `%"${filter.assignee.toLowerCase()}"%`);
  }

  const byPerson = anyPerson(
    [{ column: 'author' }, { column: 'assignees', json: true }],
    filter.people,
  );
  if (byPerson.sql) where.add(byPerson.sql, ...byPerson.params);

  if (filter.excludeBots === true) {
    const clause = notABot('author', filter.bots);
    where.add(clause.sql, ...clause.params);
  }
  if (filter.onlyBots === true) {
    const clause = isABot('author', filter.bots);
    where.add(clause.sql, ...clause.params);
  }

  for (const label of filter.labels ?? []) {
    where.add('LOWER(labels) LIKE ?', `%"${label.toLowerCase()}"%`);
  }
  if (filter.numbers && filter.numbers.length > 0) {
    where.add(`number IN (${filter.numbers.map(() => '?').join(', ')})`, ...filter.numbers);
  }
  return where;
}

export function listIssues(db: Database, filter: IssueFilter = {}): IssueRow[] {
  const where = applyIssueFilters(new WhereBuilder(), filter).add('is_pull_request = 0');
  const paging = limitClause(filter);
  const sort = filter.sort ?? 'updated';
  const column = sort === 'number' ? 'number' : `${sort}_at`;
  return db.all<IssueRow>(
    `SELECT * FROM gh_issues ${where.sql} ${orderClause(column, filter.order ?? 'desc', 'number')}${paging.sql}`,
    [...where.values, ...paging.params],
  );
}

export function getIssue(db: Database, repo: string, number: number): IssueRow | undefined {
  return db.get<IssueRow>(
    'SELECT * FROM gh_issues WHERE repo_full_name = ? AND number = ? AND is_pull_request = 0',
    [repo, number],
  );
}

export function listPullRequests(db: Database, filter: PullRequestFilter = {}): PullRequestRow[] {
  const where = applyIssueFilters(new WhereBuilder(), filter);
  where.addIf(filter.baseRef, 'base_ref = ?', filter.baseRef);
  if (filter.draft !== undefined) where.add('draft = ?', filter.draft ? 1 : 0);
  if (filter.merged !== undefined) {
    where.add(filter.merged ? 'merged_at IS NOT NULL' : 'merged_at IS NULL');
  }
  if (filter.reviewer) {
    where.add(
      `id IN (SELECT pr_id FROM gh_reviews WHERE LOWER(author) = ?)`,
      filter.reviewer.toLowerCase(),
    );
  }

  const paging = limitClause(filter);
  const sort = filter.sort ?? 'updated';
  const column = sort === 'number' ? 'number' : `${sort}_at`;
  return db.all<PullRequestRow>(
    `SELECT * FROM gh_pull_requests ${where.sql} ${orderClause(column, filter.order ?? 'desc', 'number')}${paging.sql}`,
    [...where.values, ...paging.params],
  );
}

export function getPullRequest(
  db: Database,
  repo: string,
  number: number,
): PullRequestRow | undefined {
  return db.get<PullRequestRow>(
    'SELECT * FROM gh_pull_requests WHERE repo_full_name = ? AND number = ?',
    [repo, number],
  );
}

export function listComments(db: Database, repo: string, issueNumber: number): CommentRow[] {
  return db.all<CommentRow>(
    `SELECT * FROM gh_comments WHERE repo_full_name = ? AND issue_number = ?
      ORDER BY created_at ASC, id ASC`,
    [repo, issueNumber],
  );
}

export function listEvents(db: Database, repo: string, issueNumber: number): EventRow[] {
  return db.all<EventRow>(
    `SELECT * FROM gh_events WHERE repo_full_name = ? AND issue_number = ?
      ORDER BY created_at ASC, uid ASC`,
    [repo, issueNumber],
  );
}

export function listReviews(db: Database, repo: string, prNumber: number): ReviewRow[] {
  return db.all<ReviewRow>(
    `SELECT * FROM gh_reviews WHERE repo_full_name = ? AND pr_number = ?
      ORDER BY submitted_at ASC, id ASC`,
    [repo, prNumber],
  );
}

export function listReviewComments(
  db: Database,
  repo: string,
  prNumber: number,
): ReviewCommentRow[] {
  return db.all<ReviewCommentRow>(
    `SELECT * FROM gh_review_comments WHERE repo_full_name = ? AND pr_number = ?
      ORDER BY created_at ASC, id ASC`,
    [repo, prNumber],
  );
}

export function listCommits(db: Database, repo: string, prNumber: number): CommitRow[] {
  return db.all<CommitRow>(
    `SELECT * FROM gh_commits WHERE repo_full_name = ? AND pr_number = ?
      ORDER BY committed_at ASC`,
    [repo, prNumber],
  );
}

export function listChangedFiles(
  db: Database,
  repo: string,
  prNumber: number,
): Array<{
  filename: string;
  status: string | null;
  additions: number | null;
  deletions: number | null;
}> {
  return db.all(
    `SELECT f.filename, f.status, f.additions, f.deletions
       FROM gh_pull_request_files f
       JOIN gh_pull_requests p ON p.id = f.pr_id AND p.host = f.host
      WHERE p.repo_full_name = ? AND p.number = ?
      ORDER BY f.filename`,
    [repo, prNumber],
  );
}

export function listWorkflows(
  db: Database,
  options: { repos?: string[] | undefined; search?: string | undefined } & PagingOptions = {},
): WorkflowRow[] {
  const where = new WhereBuilder()
    .addIn('w.repo_full_name', options.repos)
    .addSearch(['w.name', 'w.path'], options.search);
  const paging = limitClause(options);
  return db.all<WorkflowRow>(
    `SELECT w.*,
            (SELECT COUNT(*) FROM gh_workflow_runs r
              WHERE r.host = w.host AND r.workflow_id = w.id) AS run_count,
            (SELECT MAX(r.created_at) FROM gh_workflow_runs r
              WHERE r.host = w.host AND r.workflow_id = w.id) AS last_run_at
       FROM gh_workflows w
       ${where.sql}
      ORDER BY w.repo_full_name, w.name${paging.sql}`,
    [...where.values, ...paging.params],
  );
}

export function listWorkflowRuns(db: Database, filter: WorkflowRunFilter = {}): WorkflowRunRow[] {
  const where = new WhereBuilder().addIn('repo_full_name', filter.repos);
  where.addIf(filter.status, 'status = ?', filter.status);
  where.addIf(filter.conclusion, 'conclusion = ?', filter.conclusion);
  where.addIf(filter.branch, 'head_branch = ?', filter.branch);
  where.addIf(filter.event, 'event = ?', filter.event);
  where.addIf(filter.actor, 'LOWER(actor) = ?', filter.actor?.toLowerCase());
  where.addIf(filter.createdSince, 'created_at >= ?', filter.createdSince);
  where.addIf(filter.createdBefore, 'created_at < ?', filter.createdBefore);
  where.addSearch(['name', 'workflow_name'], filter.search);
  if (filter.workflow) {
    where.add(
      `(workflow_name = ? OR workflow_id IN (SELECT id FROM gh_workflows WHERE name = ? OR path = ?))`,
      filter.workflow,
      filter.workflow,
      filter.workflow,
    );
  }
  const paging = limitClause(filter);
  return db.all<WorkflowRunRow>(
    `SELECT * FROM gh_workflow_runs ${where.sql} ${orderClause('created_at', 'desc')}${paging.sql}`,
    [...where.values, ...paging.params],
  );
}

export interface ClosedOnDay {
  day: string;
  /** Merged plus closed-without-merging. */
  total: number;
  merged: number;
  /** Closed and thrown away — work that produced nothing. */
  discarded: number;
}

/**
 * How many pull requests were finished on each day, and how many of those were
 * thrown away.
 *
 * Read from `closed_at` on the pull request rather than from `state_changes`,
 * because the two answer different questions. The history table knows how many
 * were *open* at a moment, which needs the balance carried in from before the
 * window; this is a count of events inside the window, and it needs the merged
 * / discarded split that the state dimension flattens into "closed".
 *
 * The split is the reason to draw it at all. A team closing twelve pull
 * requests a week is doing well or wasting its time depending entirely on how
 * many of them were merged, and one number cannot tell you which.
 */
export function closedByDay(
  db: Database,
  options: {
    from: string;
    to: string;
    repos?: string[] | undefined;
    /** GitHub logins, lower cased. Matches the author or an assignee. */
    people?: string[] | undefined;
    excludeBots?: boolean | undefined;
    bots?: string[] | undefined;
  },
): ClosedOnDay[] {
  const where = new WhereBuilder().addIn('repo_full_name', options.repos);
  where.add('closed_at IS NOT NULL');
  /*
   * Compared on the date, not the timestamp.
   *
   * `to` is usually a plain date, and "2026-03-03T09:00:00Z" sorts *after*
   * "2026-03-03" as a string — so a timestamp comparison silently drops
   * everything that happened on the last day of the window. The bar for today
   * would have read zero every time, which is indistinguishable from a slow
   * morning.
   */
  where.add('SUBSTR(closed_at, 1, 10) >= SUBSTR(?, 1, 10)', options.from);
  where.add('SUBSTR(closed_at, 1, 10) <= SUBSTR(?, 1, 10)', options.to);

  // Author or assignee, the same rule every other person filter here uses.
  const people = anyPerson(
    [{ column: 'author' }, { column: 'assignees', json: true }],
    options.people,
  );
  if (people.sql !== '') where.add(people.sql, ...people.params);

  if (options.excludeBots === true) {
    const clause = notABot('author', options.bots);
    where.add(clause.sql, ...clause.params);
  }

  const rows = db.all<{ day: string; total: number; merged: number }>(
    `SELECT SUBSTR(closed_at, 1, 10) AS day,
            COUNT(*) AS total,
            COALESCE(SUM(merged = 1), 0) AS merged
       FROM gh_pull_requests ${where.sql}
      GROUP BY day
      ORDER BY day`,
    where.values,
  );

  const byDay = new Map(
    rows.map((row) => [row.day, { ...row, discarded: row.total - row.merged }]),
  );
  return eachDay(options.from, options.to).map(
    (day) => byDay.get(day) ?? { day, total: 0, merged: 0, discarded: 0 },
  );
}

export interface RunsOnDay {
  day: string;
  total: number;
  success: number;
  failure: number;
  cancelled: number;
  /** Skipped, timed out, action required — and the ones still running. */
  other: number;
}

/**
 * How many workflow runs started on each day, split by how they ended.
 *
 * Deliberately not "how many were in flight". A run is queued, running, then
 * finished within minutes, so counting the unfinished ones at the end of a day
 * draws a flat line at zero and answers nothing. What the line is asked to say
 * is whether CI is getting worse, and that is a failure count per day.
 *
 * Grouped by `created_at`, which is exact, rather than by a finish time, which
 * is not recorded — a run that started before midnight and failed after it
 * counts on the day the work was pushed, which is the day somebody has to look
 * at.
 *
 * Days with no runs are filled in by the caller: a gap the chart skips over
 * reads as a quiet week rather than a weekend.
 */
export function runsByDay(
  db: Database,
  options: { from: string; to: string; repos?: string[] | undefined },
): RunsOnDay[] {
  const where = new WhereBuilder().addIn('repo_full_name', options.repos);
  // On the date rather than the timestamp — see closedByDay: a plain `to`
  // otherwise drops every run from the last day of the window.
  where.add('SUBSTR(created_at, 1, 10) >= SUBSTR(?, 1, 10)', options.from);
  where.add('SUBSTR(created_at, 1, 10) <= SUBSTR(?, 1, 10)', options.to);

  const rows = db.all<RunsOnDay>(
    `SELECT SUBSTR(created_at, 1, 10) AS day,
            COUNT(*) AS total,
            COALESCE(SUM(conclusion = 'success'), 0)   AS success,
            COALESCE(SUM(conclusion = 'failure'), 0)   AS failure,
            COALESCE(SUM(conclusion = 'cancelled'), 0) AS cancelled,
            COALESCE(SUM(conclusion IS NULL
                     OR conclusion NOT IN ('success', 'failure', 'cancelled')), 0) AS other
       FROM gh_workflow_runs ${where.sql}
      GROUP BY day
      ORDER BY day`,
    where.values,
  );

  const byDay = new Map(rows.map((row) => [row.day, row]));
  return eachDay(options.from, options.to).map(
    (day) => byDay.get(day) ?? { day, total: 0, success: 0, failure: 0, cancelled: 0, other: 0 },
  );
}

export function listWorkflowJobs(
  db: Database,
  options: {
    runId?: number | undefined;
    repos?: string[] | undefined;
    conclusion?: string | undefined;
    search?: string | undefined;
  } & PagingOptions = {},
): WorkflowJobRow[] {
  const where = new WhereBuilder().addIn('repo_full_name', options.repos);
  where.addIf(options.runId, 'run_id = ?', options.runId);
  where.addIf(options.conclusion, 'conclusion = ?', options.conclusion);
  where.addSearch(['name'], options.search);
  const paging = limitClause(options);
  return db.all<WorkflowJobRow>(
    `SELECT * FROM gh_workflow_jobs ${where.sql} ${orderClause('started_at', 'desc')}${paging.sql}`,
    [...where.values, ...paging.params],
  );
}

export function listWorkflowSteps(
  db: Database,
  options: {
    jobId?: number | undefined;
    runId?: number | undefined;
    conclusion?: string | undefined;
    search?: string | undefined;
  } & PagingOptions = {},
): WorkflowStepRow[] {
  const where = new WhereBuilder();
  where.addIf(options.jobId, 'job_id = ?', options.jobId);
  where.addIf(options.runId, 'run_id = ?', options.runId);
  where.addIf(options.conclusion, 'conclusion = ?', options.conclusion);
  where.addSearch(['name'], options.search);
  const paging = limitClause(options);
  return db.all<WorkflowStepRow>(
    `SELECT * FROM gh_workflow_steps ${where.sql}
      ORDER BY job_id DESC, number ASC${paging.sql}`,
    [...where.values, ...paging.params],
  );
}

export function getJobLog(
  db: Database,
  jobId: number,
): { content: string | null; truncated: number; size_bytes: number | null } | undefined {
  return db.get('SELECT content, truncated, size_bytes FROM gh_job_logs WHERE job_id = ?', [jobId]);
}

const group = (table: string, where = ''): string =>
  `SELECT repo_full_name AS name, COUNT(*) AS total FROM ${table}
   ${where ? `WHERE ${where}` : ''} GROUP BY repo_full_name`;

/** The same counts as `githubStats`, split per repository. */
export interface RepositoryStats {
  repository: string;
  issues: number;
  openIssues: number;
  pullRequests: number;
  openPullRequests: number;
  comments: number;
  events: number;
  reviews: number;
  workflows: number;
  workflowRuns: number;
  workflowJobs: number;
  jobLogs: number;
}

export function githubStatsByRepository(db: Database): RepositoryStats[] {
  const rows = new Map<string, RepositoryStats>();
  const forRepository = (name: string): RepositoryStats => {
    const existing = rows.get(name);
    if (existing) return existing;
    const created: RepositoryStats = {
      repository: name,
      issues: 0,
      openIssues: 0,
      pullRequests: 0,
      openPullRequests: 0,
      comments: 0,
      events: 0,
      reviews: 0,
      workflows: 0,
      workflowRuns: 0,
      workflowJobs: 0,
      jobLogs: 0,
    };
    rows.set(name, created);
    return created;
  };

  // Every repository appears, even one that has only just been added and has
  // nothing under it yet — a row of zeroes says more than a missing row.
  for (const repository of db.all<{ full_name: string }>(
    'SELECT full_name FROM gh_repositories ORDER BY full_name',
  )) {
    forRepository(repository.full_name);
  }

  const tally = (field: keyof RepositoryStats, sql: string): void => {
    for (const row of db.all<{ name: string; total: number }>(sql)) {
      if (row.name) (forRepository(row.name)[field] as number) = row.total;
    }
  };
  tally('issues', group('gh_issues', 'is_pull_request = 0'));
  tally('openIssues', group('gh_issues', "is_pull_request = 0 AND state = 'open'"));
  tally('pullRequests', group('gh_pull_requests'));
  tally('openPullRequests', group('gh_pull_requests', "state = 'open'"));
  tally('comments', group('gh_comments'));
  tally('events', group('gh_events'));
  tally('reviews', group('gh_reviews'));
  tally('workflows', group('gh_workflows'));
  tally('workflowRuns', group('gh_workflow_runs'));
  tally('workflowJobs', group('gh_workflow_jobs'));
  // Job logs only carry the numeric repository id, so they come through the
  // repository table.
  tally(
    'jobLogs',
    `SELECT r.full_name AS name, COUNT(*) AS total
       FROM gh_job_logs l
       JOIN gh_repositories r ON r.host = l.host AND r.id = l.repo_id
      GROUP BY r.full_name`,
  );

  return [...rows.values()];
}

export function githubStats(db: Database): Record<string, number> {
  return {
    repositories: db.count('gh_repositories'),
    issues: db.count('gh_issues', 'is_pull_request = 0'),
    openIssues: db.count('gh_issues', "is_pull_request = 0 AND state = 'open'"),
    pullRequests: db.count('gh_pull_requests'),
    openPullRequests: db.count('gh_pull_requests', "state = 'open'"),
    comments: db.count('gh_comments'),
    events: db.count('gh_events'),
    reviews: db.count('gh_reviews'),
    workflows: db.count('gh_workflows'),
    workflowRuns: db.count('gh_workflow_runs'),
    workflowJobs: db.count('gh_workflow_jobs'),
    jobLogs: db.count('gh_job_logs'),
  };
}
