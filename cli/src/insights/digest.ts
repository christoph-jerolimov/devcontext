import type { Database } from '../db/database.js';
import { staleItems, wip } from './index.js';
import type { StaleItem } from './index.js';

export interface DigestOptions {
  since: string;
  until?: string | undefined;
  repos?: string[] | undefined;
  projects?: string[] | undefined;
  /** Only activity by these people (GitHub logins or Jira display names). */
  people?: string[] | undefined;
  limit?: number | undefined;
  /** Age at which open work is called out as stale; omit to skip the section. */
  staleAfter?: string | undefined;
}

export interface DigestEntry {
  ref: string;
  title: string | null;
  who: string | null;
  at: string | null;
  url: string | null;
  detail?: string | undefined;
}

export interface PersonActivity {
  person: string;
  pullRequestsOpened: number;
  pullRequestsMerged: number;
  reviews: number;
  issuesClosed: number;
  workitemsFinished: number;
  comments: number;
  total: number;
}

export interface Digest {
  kind: 'digest';
  since: string;
  until: string;
  github: {
    pullRequestsOpened: DigestEntry[];
    pullRequestsMerged: DigestEntry[];
    issuesOpened: DigestEntry[];
    issuesClosed: DigestEntry[];
    reviews: number;
    comments: number;
    failedRuns: DigestEntry[];
  };
  jira: {
    created: DigestEntry[];
    started: DigestEntry[];
    finished: DigestEntry[];
    comments: number;
  };
  people: PersonActivity[];
  /** Still in flight at the end of the window. */
  inFlight: { workitems: number; pullRequests: number; drafts: number };
  stale: StaleItem[];
  /** True when nothing at all happened, so callers can say so plainly. */
  quiet: boolean;
}

/** A status name that means somebody has picked the work up. */
const IN_PROGRESS = /in progress|in review|in development|doing|started/i;
/** A status name that means the work is finished. */
const DONE = /^(done|closed|resolved|complete|completed|shipped)$/i;

interface EventRow {
  ref: string;
  title: string | null;
  who: string | null;
  at: string | null;
  url: string | null;
}

/**
 * What changed in a window, in the shape a standup or a weekly update needs:
 * what shipped, what started, who did it, and what is stuck.
 */
export function buildDigest(db: Database, options: DigestOptions): Digest {
  const until = options.until ?? new Date().toISOString();
  const { since } = options;
  const limit = options.limit ?? 20;

  const repoFilter = (column = 'repo_full_name'): string =>
    options.repos?.length ? `AND ${column} IN (${options.repos.map(() => '?').join(', ')})` : '';
  const repoParams = options.repos ?? [];
  const projectFilter = (column = 'project_key'): string =>
    options.projects?.length
      ? `AND ${column} IN (${options.projects.map(() => '?').join(', ')})`
      : '';
  const projectParams = options.projects?.map((key) => key.toUpperCase()) ?? [];

  const people = options.people?.map((person) => person.toLowerCase());
  const matchesPerson = (name: string | null): boolean =>
    !people || (name !== null && people.includes(name.toLowerCase()));

  const events = (sql: string, params: Array<string | number | null>): DigestEntry[] =>
    db
      .all<EventRow>(sql, params)
      .filter((row) => matchesPerson(row.who))
      .map((row) => ({ ref: row.ref, title: row.title, who: row.who, at: row.at, url: row.url }));

  /* --- GitHub ------------------------------------------------------------ */

  const pullRequestsOpened = events(
    `SELECT repo_full_name || '#' || number AS ref, title, author AS who,
            created_at AS at, html_url AS url
       FROM gh_pull_requests
      WHERE created_at >= ? AND created_at < ? ${repoFilter()}
      ORDER BY created_at DESC`,
    [since, until, ...repoParams],
  );

  // Credited to whoever pressed merge, falling back to the author when GitHub
  // did not record it (older data, or a merge through the API).
  const pullRequestsMerged = events(
    `SELECT repo_full_name || '#' || number AS ref, title,
            COALESCE(merged_by, author) AS who, merged_at AS at, html_url AS url
       FROM gh_pull_requests
      WHERE merged_at >= ? AND merged_at < ? ${repoFilter()}
      ORDER BY merged_at DESC`,
    [since, until, ...repoParams],
  );

  const issuesOpened = events(
    `SELECT repo_full_name || '#' || number AS ref, title, author AS who,
            created_at AS at, html_url AS url
       FROM gh_issues
      WHERE is_pull_request = 0 AND created_at >= ? AND created_at < ? ${repoFilter()}
      ORDER BY created_at DESC`,
    [since, until, ...repoParams],
  );

  const issuesClosed = events(
    `SELECT repo_full_name || '#' || number AS ref, title,
            COALESCE(closed_by, author) AS who, closed_at AS at, html_url AS url
       FROM gh_issues
      WHERE is_pull_request = 0 AND closed_at >= ? AND closed_at < ? ${repoFilter()}
      ORDER BY closed_at DESC`,
    [since, until, ...repoParams],
  );

  const failedRuns = db
    .all<EventRow & { branch: string | null }>(
      `SELECT CAST(id AS TEXT) AS ref, workflow_name AS title, head_branch AS branch,
              NULL AS who, created_at AS at, html_url AS url
         FROM gh_workflow_runs
        WHERE conclusion = 'failure' AND created_at >= ? AND created_at < ? ${repoFilter()}
        ORDER BY created_at DESC`,
      [since, until, ...repoParams],
    )
    .map((row) => ({
      ref: row.ref,
      title: row.title,
      who: null,
      at: row.at,
      url: row.url,
      detail: row.branch ?? undefined,
    }));

  /* --- Jira -------------------------------------------------------------- */

  const created = events(
    `SELECT key AS ref, summary AS title, reporter AS who, created_at AS at, url
       FROM jira_workitems
      WHERE created_at >= ? AND created_at < ? ${projectFilter()}
      ORDER BY created_at DESC`,
    [since, until, ...projectParams],
  );

  // Status moves come from the changelog, so "started" and "finished" describe
  // what actually happened in the window rather than the item's current state.
  const statusMoves = db.all<EventRow & { toStatus: string | null }>(
    `SELECT c.workitem_key AS ref, w.summary AS title, c.author AS who, c.created_at AS at,
            c.to_string AS toStatus, w.url
       FROM jira_changelog c
       JOIN jira_workitems w ON w.site = c.site AND w.key = c.workitem_key
      WHERE c.field = 'status' AND c.created_at >= ? AND c.created_at < ?
            ${projectFilter('w.project_key')}
      ORDER BY c.created_at DESC`,
    [since, until, ...projectParams],
  );

  const started: DigestEntry[] = [];
  const finished: DigestEntry[] = [];
  const seenStarted = new Set<string>();
  const seenFinished = new Set<string>();

  for (const move of statusMoves) {
    const to = move.toStatus?.trim();
    if (!to || !matchesPerson(move.who)) continue;
    const entry: DigestEntry = {
      ref: move.ref,
      title: move.title,
      who: move.who,
      at: move.at,
      url: move.url,
      detail: to,
    };
    // Rows arrive newest first, so the first match per item is the latest move.
    if (DONE.test(to)) {
      if (!seenFinished.has(move.ref)) {
        seenFinished.add(move.ref);
        finished.push(entry);
      }
    } else if (IN_PROGRESS.test(to) && !seenStarted.has(move.ref)) {
      seenStarted.add(move.ref);
      started.push(entry);
    }
  }

  /* --- Counts and people -------------------------------------------------- */

  // `--person` narrows these too, so the headline counts and the per person
  // table always describe the same set of activity.
  const authors = (sql: string, params: Array<string | number | null>): Array<string | null> =>
    db
      .all<{ author: string | null }>(sql, params)
      .map((row) => row.author)
      .filter((author) => matchesPerson(author));

  const reviews = authors(
    `SELECT author FROM gh_reviews
      WHERE submitted_at >= ? AND submitted_at < ? ${repoFilter()}`,
    [since, until, ...repoParams],
  );
  const githubComments = authors(
    `SELECT author FROM gh_comments
      WHERE created_at >= ? AND created_at < ? ${repoFilter()}`,
    [since, until, ...repoParams],
  );
  const jiraComments = authors(
    `SELECT c.author FROM jira_comments c
       JOIN jira_workitems w ON w.site = c.site AND w.id = c.workitem_id
      WHERE c.created_at >= ? AND c.created_at < ? ${projectFilter('w.project_key')}`,
    [since, until, ...projectParams],
  );

  const activity = new Map<string, PersonActivity>();
  const bump = (
    name: string | null,
    field: keyof Omit<PersonActivity, 'person' | 'total'>,
  ): void => {
    if (name === null || !matchesPerson(name)) return;
    const entry = activity.get(name) ?? {
      person: name,
      pullRequestsOpened: 0,
      pullRequestsMerged: 0,
      reviews: 0,
      issuesClosed: 0,
      workitemsFinished: 0,
      comments: 0,
      total: 0,
    };
    entry[field] += 1;
    entry.total += 1;
    activity.set(name, entry);
  };

  for (const entry of pullRequestsOpened) bump(entry.who, 'pullRequestsOpened');
  for (const entry of pullRequestsMerged) bump(entry.who, 'pullRequestsMerged');
  for (const entry of issuesClosed) bump(entry.who, 'issuesClosed');
  for (const entry of finished) bump(entry.who, 'workitemsFinished');
  for (const author of reviews) bump(author, 'reviews');
  for (const author of [...githubComments, ...jiraComments]) bump(author, 'comments');

  const flight = wip(db, { repos: options.repos, projects: options.projects });
  const stale = options.staleAfter
    ? staleItems(db, options.staleAfter, {
        repos: options.repos,
        projects: options.projects,
        limit,
      }).items
    : [];

  const total =
    pullRequestsOpened.length +
    pullRequestsMerged.length +
    issuesOpened.length +
    issuesClosed.length +
    created.length +
    started.length +
    finished.length +
    reviews.length +
    githubComments.length +
    jiraComments.length;

  return {
    kind: 'digest',
    since,
    until,
    github: {
      pullRequestsOpened: pullRequestsOpened.slice(0, limit),
      pullRequestsMerged: pullRequestsMerged.slice(0, limit),
      issuesOpened: issuesOpened.slice(0, limit),
      issuesClosed: issuesClosed.slice(0, limit),
      reviews: reviews.length,
      comments: githubComments.length,
      failedRuns: failedRuns.slice(0, limit),
    },
    jira: {
      created: created.slice(0, limit),
      started: started.slice(0, limit),
      finished: finished.slice(0, limit),
      comments: jiraComments.length,
    },
    people: [...activity.values()].toSorted((a, b) => b.total - a.total),
    inFlight: {
      workitems: flight.workitems,
      pullRequests: flight.openPullRequests,
      drafts: flight.draftPullRequests,
    },
    stale,
    quiet: total === 0,
  };
}
