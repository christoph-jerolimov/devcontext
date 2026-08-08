import type { Database } from '../db/database.js';
import { describe, hoursBetween, percent } from './stats.js';
import type { Distribution } from './stats.js';

export interface InsightFilter {
  /** Only consider items that finished (or were last touched) at or after this. */
  since?: string | undefined;
  until?: string | undefined;
  repos?: string[] | undefined;
  projects?: string[] | undefined;
  limit?: number | undefined;
}

/* -------------------------------------------------------------------------- */
/* Cycle time                                                                  */
/* -------------------------------------------------------------------------- */

export interface CycleTimeItem {
  key: string;
  summary: string | null;
  type: string | null;
  assignee: string | null;
  startedAt: string;
  finishedAt: string;
  hours: number;
}

export interface CycleTimeReport {
  kind: 'cycle-time';
  items: CycleTimeItem[];
  overall: Distribution;
  byType: Array<{ type: string; distribution: Distribution }>;
  /** Items that reached Done but never passed through an in-progress status. */
  withoutStart: number;
}

/**
 * Time from the first move into an "In Progress" status to the move into a
 * "Done" one, read from the Jira changelog rather than from the created and
 * resolved timestamps — a ticket that sat in the backlog for a month should not
 * count that month as cycle time.
 */
export function cycleTime(db: Database, filter: InsightFilter = {}): CycleTimeReport {
  const params: Array<string | number> = [];
  const where: string[] = ["c.field = 'status'"];

  if (filter.projects?.length) {
    where.push(`w.project_key IN (${filter.projects.map(() => '?').join(', ')})`);
    params.push(...filter.projects.map((key) => key.toUpperCase()));
  }

  const rows = db.all<{
    key: string;
    summary: string | null;
    type: string | null;
    assignee: string | null;
    created_at: string | null;
    to_string: string | null;
    category: string | null;
  }>(
    `SELECT w.key, w.summary, w.type, w.assignee, c.created_at, c.to_string,
            (SELECT status_category FROM jira_workitems x WHERE x.key = w.key) AS category
       FROM jira_changelog c
       JOIN jira_workitems w ON w.key = c.workitem_key
      WHERE ${where.join(' AND ')}
      ORDER BY c.workitem_key, c.created_at`,
    params,
  );

  const IN_PROGRESS = /in progress|in review|in development|doing|started/i;
  const DONE = /^(done|closed|resolved|complete|completed|shipped)$/i;

  const starts = new Map<string, string>();
  const ends = new Map<string, string>();
  const meta = new Map<
    string,
    { summary: string | null; type: string | null; assignee: string | null }
  >();

  for (const row of rows) {
    if (!row.created_at || !row.to_string) continue;
    meta.set(row.key, { summary: row.summary, type: row.type, assignee: row.assignee });

    if (IN_PROGRESS.test(row.to_string) && !starts.has(row.key)) {
      starts.set(row.key, row.created_at);
    }
    if (DONE.test(row.to_string.trim())) {
      // The last move into Done wins: a reopened ticket finishes twice.
      ends.set(row.key, row.created_at);
    }
  }

  const items: CycleTimeItem[] = [];
  let withoutStart = 0;

  for (const [key, finishedAt] of ends) {
    if (filter.since && finishedAt < filter.since) continue;
    if (filter.until && finishedAt >= filter.until) continue;

    const startedAt = starts.get(key);
    if (!startedAt) {
      withoutStart += 1;
      continue;
    }
    const hours = hoursBetween(startedAt, finishedAt);
    if (hours === null) continue;

    const info = meta.get(key);
    items.push({
      key,
      summary: info?.summary ?? null,
      type: info?.type ?? null,
      assignee: info?.assignee ?? null,
      startedAt,
      finishedAt,
      hours,
    });
  }

  const slowest = items.toSorted((a, b) => b.hours - a.hours);

  const byType = new Map<string, number[]>();
  for (const item of items) {
    const type = item.type ?? 'unknown';
    byType.set(type, [...(byType.get(type) ?? []), item.hours]);
  }

  return {
    kind: 'cycle-time',
    items: filter.limit ? slowest.slice(0, filter.limit) : slowest,
    overall: describe(items.map((item) => item.hours)),
    byType: [...byType.entries()]
      .map(([type, values]) => ({ type, distribution: describe(values) }))
      .toSorted((a, b) => b.distribution.count - a.distribution.count),
    withoutStart,
  };
}

/* -------------------------------------------------------------------------- */
/* Review latency                                                              */
/* -------------------------------------------------------------------------- */

export interface ReviewLatencyItem {
  repo: string;
  number: number;
  title: string | null;
  author: string | null;
  createdAt: string;
  firstReviewAt: string | null;
  mergedAt: string | null;
  hoursToFirstReview: number | null;
  hoursToMerge: number | null;
}

export interface ReviewLatencyReport {
  kind: 'review-latency';
  items: ReviewLatencyItem[];
  toFirstReview: Distribution;
  toMerge: Distribution;
  /** Pull requests that were merged without a single review. */
  mergedWithoutReview: number;
  byReviewer: Array<{ reviewer: string; reviews: number; medianResponseHours: number | null }>;
}

/** How long a pull request waits for its first review, and for the merge. */
export function reviewLatency(db: Database, filter: InsightFilter = {}): ReviewLatencyReport {
  const where: string[] = ['p.created_at IS NOT NULL'];
  const params: Array<string | number> = [];

  if (filter.repos?.length) {
    where.push(`p.repo_full_name IN (${filter.repos.map(() => '?').join(', ')})`);
    params.push(...filter.repos);
  }
  if (filter.since) {
    where.push('p.created_at >= ?');
    params.push(filter.since);
  }
  if (filter.until) {
    where.push('p.created_at < ?');
    params.push(filter.until);
  }

  const rows = db.all<{
    repo: string;
    number: number;
    title: string | null;
    author: string | null;
    created_at: string;
    merged_at: string | null;
    first_review_at: string | null;
  }>(
    `SELECT p.repo_full_name AS repo, p.number, p.title, p.author, p.created_at, p.merged_at,
            (SELECT MIN(r.submitted_at) FROM gh_reviews r
              WHERE r.pr_id = p.id AND r.host = p.host
                AND r.submitted_at IS NOT NULL
                AND (r.author IS NULL OR r.author != p.author)) AS first_review_at
       FROM gh_pull_requests p
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC`,
    params,
  );

  const items: ReviewLatencyItem[] = rows.map((row) => ({
    repo: row.repo,
    number: row.number,
    title: row.title,
    author: row.author,
    createdAt: row.created_at,
    firstReviewAt: row.first_review_at,
    mergedAt: row.merged_at,
    hoursToFirstReview: hoursBetween(row.created_at, row.first_review_at),
    hoursToMerge: hoursBetween(row.created_at, row.merged_at),
  }));

  const reviewerRows = db.all<{ reviewer: string; reviews: number }>(
    `SELECT author AS reviewer, COUNT(*) AS reviews
       FROM gh_reviews
      WHERE author IS NOT NULL ${filter.since ? 'AND submitted_at >= ?' : ''}
      GROUP BY author
      ORDER BY reviews DESC`,
    filter.since ? [filter.since] : [],
  );

  const responses = new Map<string, number[]>();
  for (const row of db.all<{ reviewer: string; created_at: string; submitted_at: string }>(
    `SELECT r.author AS reviewer, p.created_at, r.submitted_at
       FROM gh_reviews r
       JOIN gh_pull_requests p ON p.id = r.pr_id AND p.host = r.host
      WHERE r.author IS NOT NULL AND r.submitted_at IS NOT NULL AND p.created_at IS NOT NULL
        ${filter.since ? 'AND r.submitted_at >= ?' : ''}`,
    filter.since ? [filter.since] : [],
  )) {
    const hours = hoursBetween(row.created_at, row.submitted_at);
    if (hours === null) continue;
    responses.set(row.reviewer, [...(responses.get(row.reviewer) ?? []), hours]);
  }

  return {
    kind: 'review-latency',
    items: filter.limit ? items.slice(0, filter.limit) : items,
    toFirstReview: describe(
      items
        .map((item) => item.hoursToFirstReview)
        .filter((value): value is number => value !== null),
    ),
    toMerge: describe(
      items.map((item) => item.hoursToMerge).filter((value): value is number => value !== null),
    ),
    mergedWithoutReview: items.filter((item) => item.mergedAt && item.firstReviewAt === null)
      .length,
    byReviewer: reviewerRows.map((row) => ({
      reviewer: row.reviewer,
      reviews: row.reviews,
      medianResponseHours: describe(responses.get(row.reviewer) ?? []).p50,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Work in progress                                                            */
/* -------------------------------------------------------------------------- */

export interface WipReport {
  kind: 'wip';
  workitems: number;
  openPullRequests: number;
  draftPullRequests: number;
  openIssues: number;
  byAssignee: Array<{
    assignee: string;
    workitems: number;
    pullRequests: number;
    oldestHours: number | null;
  }>;
}

/** What is in flight right now, and who is carrying it. */
export function wip(db: Database, filter: InsightFilter = {}): WipReport {
  const projectFilter = filter.projects?.length
    ? `AND project_key IN (${filter.projects.map(() => '?').join(', ')})`
    : '';
  const projectParams = filter.projects?.map((key) => key.toUpperCase()) ?? [];

  const workitems = db.all<{ assignee: string | null; updated_at: string | null }>(
    `SELECT assignee, updated_at FROM jira_workitems
      WHERE status_category = 'In Progress' ${projectFilter}`,
    projectParams,
  );

  const repoFilter = filter.repos?.length
    ? `AND repo_full_name IN (${filter.repos.map(() => '?').join(', ')})`
    : '';
  const repoParams = filter.repos ?? [];

  const pulls = db.all<{ author: string | null; created_at: string | null; draft: number }>(
    `SELECT author, created_at, draft FROM gh_pull_requests
      WHERE state = 'open' ${repoFilter}`,
    repoParams,
  );

  const now = new Date().toISOString();
  const byAssignee = new Map<
    string,
    { workitems: number; pullRequests: number; oldest: number | null }
  >();

  const bump = (
    name: string | null,
    field: 'workitems' | 'pullRequests',
    since: string | null,
  ): void => {
    const key = name ?? '(unassigned)';
    const entry = byAssignee.get(key) ?? { workitems: 0, pullRequests: 0, oldest: null };
    entry[field] += 1;
    const age = hoursBetween(since, now);
    if (age !== null && (entry.oldest === null || age > entry.oldest)) entry.oldest = age;
    byAssignee.set(key, entry);
  };

  for (const row of workitems) bump(row.assignee, 'workitems', row.updated_at);
  for (const row of pulls) bump(row.author, 'pullRequests', row.created_at);

  return {
    kind: 'wip',
    workitems: workitems.length,
    openPullRequests: pulls.length,
    draftPullRequests: pulls.filter((row) => row.draft === 1).length,
    openIssues: db.count(
      'gh_issues',
      `is_pull_request = 0 AND state = 'open'${
        filter.repos?.length
          ? ` AND repo_full_name IN (${filter.repos.map(() => '?').join(', ')})`
          : ''
      }`,
      repoParams,
    ),
    byAssignee: [...byAssignee.entries()]
      .map(([assignee, entry]) => ({
        assignee,
        workitems: entry.workitems,
        pullRequests: entry.pullRequests,
        oldestHours: entry.oldest,
      }))
      .toSorted((a, b) => b.workitems + b.pullRequests - (a.workitems + a.pullRequests)),
  };
}

/* -------------------------------------------------------------------------- */
/* Stale items                                                                 */
/* -------------------------------------------------------------------------- */

export interface StaleItem {
  kind: 'issue' | 'pull-request' | 'workitem';
  ref: string;
  title: string | null;
  owner: string | null;
  updatedAt: string | null;
  ageHours: number | null;
}

export interface StaleReport {
  kind: 'stale';
  threshold: string;
  items: StaleItem[];
  counts: { issues: number; pullRequests: number; workitems: number };
}

/** Open work nobody has touched since `threshold`. */
export function staleItems(
  db: Database,
  threshold: string,
  filter: InsightFilter = {},
): StaleReport {
  const now = new Date().toISOString();
  const items: StaleItem[] = [];

  const repoFilter = filter.repos?.length
    ? `AND repo_full_name IN (${filter.repos.map(() => '?').join(', ')})`
    : '';
  const repoParams = filter.repos ?? [];

  for (const row of db.all<{
    repo: string;
    number: number;
    title: string | null;
    author: string | null;
    updated_at: string | null;
  }>(
    `SELECT repo_full_name AS repo, number, title, author, updated_at FROM gh_issues
      WHERE is_pull_request = 0 AND state = 'open' AND updated_at < ? ${repoFilter}
      ORDER BY updated_at`,
    [threshold, ...repoParams],
  )) {
    items.push({
      kind: 'issue',
      ref: `${row.repo}#${row.number}`,
      title: row.title,
      owner: row.author,
      updatedAt: row.updated_at,
      ageHours: hoursBetween(row.updated_at, now),
    });
  }

  for (const row of db.all<{
    repo: string;
    number: number;
    title: string | null;
    author: string | null;
    updated_at: string | null;
  }>(
    `SELECT repo_full_name AS repo, number, title, author, updated_at FROM gh_pull_requests
      WHERE state = 'open' AND updated_at < ? ${repoFilter}
      ORDER BY updated_at`,
    [threshold, ...repoParams],
  )) {
    items.push({
      kind: 'pull-request',
      ref: `${row.repo}#${row.number}`,
      title: row.title,
      owner: row.author,
      updatedAt: row.updated_at,
      ageHours: hoursBetween(row.updated_at, now),
    });
  }

  const projectFilter = filter.projects?.length
    ? `AND project_key IN (${filter.projects.map(() => '?').join(', ')})`
    : '';
  for (const row of db.all<{
    key: string;
    summary: string | null;
    assignee: string | null;
    updated_at: string | null;
  }>(
    `SELECT key, summary, assignee, updated_at FROM jira_workitems
      WHERE resolved_at IS NULL AND updated_at < ? ${projectFilter}
      ORDER BY updated_at`,
    [threshold, ...(filter.projects?.map((key) => key.toUpperCase()) ?? [])],
  )) {
    items.push({
      kind: 'workitem',
      ref: row.key,
      title: row.summary,
      owner: row.assignee,
      updatedAt: row.updated_at,
      ageHours: hoursBetween(row.updated_at, now),
    });
  }

  const oldest = items.toSorted((a, b) => (b.ageHours ?? 0) - (a.ageHours ?? 0));

  return {
    kind: 'stale',
    threshold,
    items: filter.limit ? oldest.slice(0, filter.limit) : oldest,
    counts: {
      issues: items.filter((item) => item.kind === 'issue').length,
      pullRequests: items.filter((item) => item.kind === 'pull-request').length,
      workitems: items.filter((item) => item.kind === 'workitem').length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Flaky workflow steps                                                        */
/* -------------------------------------------------------------------------- */

export interface FlakyStep {
  workflow: string | null;
  job: string | null;
  step: string | null;
  runs: number;
  failures: number;
  failureRate: number | null;
  /** Runs where this step failed and a later attempt of the same run passed. */
  retriedGreen: number;
}

export interface FlakyReport {
  kind: 'flaky';
  steps: FlakyStep[];
  minRuns: number;
}

/**
 * Steps ordered by how often they fail.
 *
 * `retriedGreen` is the honest flakiness signal: the same step failing on one
 * attempt of a run and passing on another means the failure was not caused by
 * the code under test.
 */
export function flakySteps(
  db: Database,
  options: {
    minRuns?: number;
    since?: string | undefined;
    repos?: string[] | undefined;
    limit?: number | undefined;
  } = {},
): FlakyReport {
  const minRuns = options.minRuns ?? 5;
  const where: string[] = ['s.conclusion IS NOT NULL'];
  const params: Array<string | number> = [];

  if (options.since) {
    where.push('j.started_at >= ?');
    params.push(options.since);
  }
  if (options.repos?.length) {
    where.push(`j.repo_full_name IN (${options.repos.map(() => '?').join(', ')})`);
    params.push(...options.repos);
  }

  const rows = db.all<{
    workflow: string | null;
    job: string | null;
    step: string | null;
    runs: number;
    failures: number;
  }>(
    `SELECT r.workflow_name AS workflow, j.name AS job, s.name AS step,
            COUNT(*) AS runs,
            SUM(CASE WHEN s.conclusion = 'failure' THEN 1 ELSE 0 END) AS failures
       FROM gh_workflow_steps s
       JOIN gh_workflow_jobs j ON j.id = s.job_id AND j.host = s.host
       LEFT JOIN gh_workflow_runs r ON r.id = j.run_id AND r.host = j.host
      WHERE ${where.join(' AND ')}
      GROUP BY r.workflow_name, j.name, s.name
     HAVING runs >= ?
      ORDER BY failures * 1.0 / runs DESC, runs DESC`,
    [...params, minRuns],
  );

  // A step that failed on one attempt of a run and passed on another is flaky
  // rather than broken.
  const retried = new Map<string, number>();
  for (const row of db.all<{ job: string | null; step: string | null; total: number }>(
    `SELECT j.name AS job, s.name AS step, COUNT(DISTINCT j.run_id) AS total
       FROM gh_workflow_steps s
       JOIN gh_workflow_jobs j ON j.id = s.job_id AND j.host = s.host
      WHERE s.conclusion = 'failure'
        AND EXISTS (
          SELECT 1 FROM gh_workflow_steps s2
            JOIN gh_workflow_jobs j2 ON j2.id = s2.job_id AND j2.host = s2.host
           WHERE j2.run_id = j.run_id AND j2.name = j.name AND s2.name = s.name
             AND s2.conclusion = 'success'
        )
      GROUP BY j.name, s.name`,
  )) {
    retried.set(`${row.job}|${row.step}`, row.total);
  }

  return {
    kind: 'flaky',
    minRuns,
    steps: rows
      .map((row) => ({
        workflow: row.workflow,
        job: row.job,
        step: row.step,
        runs: row.runs,
        failures: row.failures,
        failureRate: percent(row.failures, row.runs),
        retriedGreen: retried.get(`${row.job}|${row.step}`) ?? 0,
      }))
      .filter((row) => row.failures > 0)
      .slice(0, options.limit ?? 25),
  };
}

/* -------------------------------------------------------------------------- */
/* Sprint report                                                               */
/* -------------------------------------------------------------------------- */

export interface SprintReport {
  kind: 'sprint';
  sprint: {
    id: number;
    name: string | null;
    state: string | null;
    startDate: string | null;
    endDate: string | null;
    goal: string | null;
  };
  items: number;
  done: number;
  storyPoints: number;
  storyPointsDone: number;
  completionRate: number | null;
  byAssignee: Array<{ assignee: string; items: number; done: number; points: number }>;
  byStatus: Array<{ status: string; items: number }>;
  /** Work items moved into or out of this sprint after it started. */
  scopeChanges: Array<{ key: string; when: string | null; from: string | null; to: string | null }>;
}

export function sprintReport(db: Database, sprintId: number): SprintReport | null {
  const sprint = db.get<{
    id: number;
    name: string | null;
    state: string | null;
    start_date: string | null;
    end_date: string | null;
    goal: string | null;
  }>('SELECT id, name, state, start_date, end_date, goal FROM jira_sprints WHERE id = ?', [
    sprintId,
  ]);
  if (!sprint) return null;

  const items = db.all<{
    key: string;
    summary: string | null;
    status: string | null;
    category: string | null;
    assignee: string | null;
    points: number | null;
  }>(
    `SELECT w.key, w.summary, w.status, w.status_category AS category, w.assignee,
            w.story_points AS points
       FROM jira_workitems w
       JOIN jira_sprint_workitems m ON m.workitem_id = w.id AND m.site = w.site
      WHERE m.sprint_id = ?
      ORDER BY w.key`,
    [sprintId],
  );

  const done = items.filter((item) => item.category === 'Done');
  const points = items.reduce((sum, item) => sum + (item.points ?? 0), 0);
  const pointsDone = done.reduce((sum, item) => sum + (item.points ?? 0), 0);

  const byAssignee = new Map<string, { items: number; done: number; points: number }>();
  for (const item of items) {
    const key = item.assignee ?? '(unassigned)';
    const entry = byAssignee.get(key) ?? { items: 0, done: 0, points: 0 };
    entry.items += 1;
    if (item.category === 'Done') entry.done += 1;
    entry.points += item.points ?? 0;
    byAssignee.set(key, entry);
  }

  const byStatus = new Map<string, number>();
  for (const item of items) {
    const status = item.status ?? 'unknown';
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }

  // Sprint field changes recorded after the sprint started are scope changes.
  const scopeChanges = sprint.start_date
    ? db
        .all<{
          itemKey: string;
          changedAt: string | null;
          fromSprint: string | null;
          toSprint: string | null;
        }>(
          `SELECT workitem_key AS itemKey, created_at AS changedAt,
                from_string AS fromSprint, to_string AS toSprint
           FROM jira_changelog
          WHERE field = 'Sprint' AND created_at >= ?
            AND (from_string LIKE ? OR to_string LIKE ?)
          ORDER BY created_at`,
          [sprint.start_date, `%${sprint.name ?? ''}%`, `%${sprint.name ?? ''}%`],
        )
        .map((row) => ({
          key: row.itemKey,
          when: row.changedAt,
          from: row.fromSprint,
          to: row.toSprint,
        }))
    : [];

  return {
    kind: 'sprint',
    sprint: {
      id: sprint.id,
      name: sprint.name,
      state: sprint.state,
      startDate: sprint.start_date,
      endDate: sprint.end_date,
      goal: sprint.goal,
    },
    items: items.length,
    done: done.length,
    storyPoints: points,
    storyPointsDone: pointsDone,
    completionRate: percent(done.length, items.length),
    byAssignee: [...byAssignee.entries()]
      .map(([assignee, entry]) => ({
        assignee,
        items: entry.items,
        done: entry.done,
        points: entry.points,
      }))
      .toSorted((a, b) => b.items - a.items),
    byStatus: [...byStatus.entries()]
      .map(([status, count]) => ({ status, items: count }))
      .toSorted((a, b) => b.items - a.items),
    scopeChanges,
  };
}

/*
 * Burndown and velocity live next door, in sprint.ts, because they read a
 * different table: `sprintReport` above asks the current tables what a sprint
 * looks like now, and those two ask `state_changes` what shape it took.
 */
export { sprintBurndown, sprintVelocity } from './sprint.js';
export type {
  BurndownDay,
  ScopeChange,
  SprintBurndown,
  SprintMeta,
  Velocity,
  VelocitySprint,
} from './sprint.js';

/*
 * Where the work sits and how long it sits there. Like the sprint reports next
 * door, these read `state_changes` rather than the current tables — the status
 * an item is in now says nothing about Tuesday.
 */
export { cumulativeFlow, statusTimes } from './flow.js';
export type { CumulativeFlow, FlowDay, FlowFilter, StatusDuration, StatusTimes } from './flow.js';
