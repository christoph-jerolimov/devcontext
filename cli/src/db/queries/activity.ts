/**
 * Everything that happened, newest first, across both platforms.
 *
 * The other lists answer "what is the state of things". This one answers "what
 * did people do", which is a different question and cannot be derived from the
 * first: an issue that was opened, argued over and closed looks, in the issue
 * list, exactly like one nobody ever touched.
 *
 * Three kinds, and deliberately only three:
 *
 * - **status** — opened, closed, reopened, merged, or moved to another Jira
 *   status. The transitions that change what somebody has to do next.
 * - **comment** — issue, pull request and work item comments, plus the inline
 *   comments left on a diff. All of them are somebody saying something.
 * - **review** — a verdict on a pull request: approved, changes requested,
 *   commented, dismissed.
 *
 * Labels, assignment changes and renames are in `gh_events` and reachable with
 * SQL, but they are bookkeeping rather than activity, and a feed that lists
 * every label a triage bot ever applied buries the four things that mattered.
 */

import type { BindValue, Database } from '../database.js';
import { anyPerson, isABot, notABot } from './people.js';

export type ActivityKind = 'status' | 'comment' | 'review';

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['status', 'comment', 'review'];

export interface ActivityEvent {
  source: 'github' | 'jira';
  kind: ActivityKind;
  /** `opened`, `closed`, `reopened`, `merged`, `commented`, `approved`, ... */
  action: string;
  /** `acme/platform#42` or `PLAT-7`. */
  ref: string;
  container: string;
  /** The item's title, so a row in the feed reads on its own. */
  title: string | null;
  /** The login or display name as stored; `person` says who that is. */
  actor: string | null;
  at: string;
  /** The Jira status moved to, or the text of what was said. Trimmed short. */
  detail: string | null;
  url: string | null;
}

export interface ActivityFilter {
  /** ISO timestamp; events at or after it. */
  since?: string | undefined;
  /** ISO timestamp; events strictly before it. */
  until?: string | undefined;
  sources?: string[] | undefined;
  /** Repository full names and Jira project keys, mixed freely. */
  containers?: string[] | undefined;
  kinds?: string[] | undefined;
  /**
   * The identities of the selected people, per source.
   *
   * Same rule as everywhere else: absent means no filter, and an empty list on
   * one side means the selected people have no presence there, so that side
   * matches nothing rather than everything.
   */
  people?: { github: string[]; jira: string[] } | undefined;
  excludeBots?: boolean | undefined;
  onlyBots?: boolean | undefined;
  bots?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

interface Part {
  source: 'github' | 'jira';
  kind: ActivityKind;
  sql: string;
  params: BindValue[];
}

/** How much of a comment body the feed carries. */
const EXCERPT = 240;

/**
 * One `SELECT` per thing that can happen.
 *
 * Written out rather than generated because every one of them reaches its
 * title and its actor differently, and a generator hiding that would be longer
 * than the eight statements it replaced.
 *
 * Every one names all ten columns, rather than letting the first `SELECT` of
 * the union name them for the rest. Which part comes first depends on the
 * filters — ask for Jira status changes alone and the outer `WHERE at >= ?`
 * would otherwise be reading a column nothing ever named.
 */
function parts(filter: ActivityFilter): Part[] {
  const wantSource = new Set(filter.sources?.length ? filter.sources : ['github', 'jira']);
  const wantKind = new Set(filter.kinds?.length ? filter.kinds : ACTIVITY_KINDS);

  const all: Part[] = [];

  if (wantSource.has('github')) {
    // Opened. There is no `opened` row in the timeline — GitHub does not emit
    // one — so it comes from the item itself.
    all.push({
      source: 'github',
      kind: 'status',
      sql: `
        SELECT 'github' AS source, 'status' AS kind,
               CASE WHEN i.is_pull_request = 1 THEN 'opened pull request' ELSE 'opened' END AS action,
               i.repo_full_name || '#' || i.number AS ref,
               i.repo_full_name AS container,
               i.title AS title,
               i.author AS actor,
               i.created_at AS at,
               NULL AS detail,
               i.html_url AS url
          FROM gh_issues i
         WHERE i.created_at IS NOT NULL`,
      params: [],
    });

    all.push({
      source: 'github',
      kind: 'status',
      sql: `
        SELECT 'github' AS source, 'status' AS kind,
               e.event AS action,
               e.repo_full_name || '#' || e.issue_number AS ref,
               e.repo_full_name AS container,
               i.title AS title,
               e.actor AS actor,
               e.created_at AS at,
               NULL AS detail,
               i.html_url AS url
          FROM gh_events e
          LEFT JOIN gh_issues i ON i.host = e.host AND i.id = e.issue_id
         WHERE e.event IN ('closed', 'reopened', 'merged') AND e.created_at IS NOT NULL`,
      params: [],
    });

    all.push({
      source: 'github',
      kind: 'comment',
      sql: `
        SELECT 'github' AS source, 'comment' AS kind, 'commented' AS action,
               c.repo_full_name || '#' || c.issue_number AS ref,
               c.repo_full_name AS container,
               i.title AS title,
               c.author AS actor,
               c.created_at AS at,
               SUBSTR(c.body, 1, ${String(EXCERPT)}) AS detail,
               c.html_url AS url
          FROM gh_comments c
          LEFT JOIN gh_issues i ON i.host = c.host AND i.id = c.issue_id
         WHERE c.created_at IS NOT NULL`,
      params: [],
    });

    all.push({
      source: 'github',
      kind: 'comment',
      sql: `
        SELECT 'github' AS source, 'comment' AS kind, 'commented on the diff' AS action,
               rc.repo_full_name || '#' || rc.pr_number AS ref,
               rc.repo_full_name AS container,
               p.title AS title,
               rc.author AS actor,
               rc.created_at AS at,
               SUBSTR(rc.body, 1, ${String(EXCERPT)}) AS detail,
               rc.html_url AS url
          FROM gh_review_comments rc
          LEFT JOIN gh_pull_requests p ON p.host = rc.host AND p.id = rc.pr_id
         WHERE rc.created_at IS NOT NULL`,
      params: [],
    });

    all.push({
      source: 'github',
      kind: 'review',
      sql: `
        SELECT 'github' AS source, 'review' AS kind,
               CASE LOWER(COALESCE(r.state, ''))
                 WHEN 'approved' THEN 'approved'
                 WHEN 'changes_requested' THEN 'requested changes'
                 WHEN 'dismissed' THEN 'review dismissed'
                 ELSE 'reviewed'
               END AS action,
               r.repo_full_name || '#' || r.pr_number AS ref,
               r.repo_full_name AS container,
               p.title AS title,
               r.author AS actor,
               r.submitted_at AS at,
               SUBSTR(NULLIF(r.body, ''), 1, ${String(EXCERPT)}) AS detail,
               r.html_url AS url
          FROM gh_reviews r
          LEFT JOIN gh_pull_requests p ON p.host = r.host AND p.id = r.pr_id
         WHERE r.submitted_at IS NOT NULL`,
      params: [],
    });
  }

  if (wantSource.has('jira')) {
    all.push({
      source: 'jira',
      kind: 'status',
      sql: `
        SELECT 'jira' AS source, 'status' AS kind, 'created' AS action,
               w.key AS ref, w.project_key AS container, w.summary AS title,
               COALESCE(NULLIF(w.creator, ''), w.reporter) AS actor,
               w.created_at AS at,
               w.type AS detail,
               w.url AS url
          FROM jira_workitems w
         WHERE w.created_at IS NOT NULL`,
      params: [],
    });

    // Only the status field. The changelog holds every field ever edited, and
    // "changed the description" is not a status change however it is stored.
    all.push({
      source: 'jira',
      kind: 'status',
      sql: `
        SELECT 'jira' AS source, 'status' AS kind,
               'moved to ' || COALESCE(cl.to_string, '?') AS action,
               cl.workitem_key AS ref, w.project_key AS container, w.summary AS title,
               cl.author AS actor,
               cl.created_at AS at,
               -- Prefixed, because a bare "To Do" under "moved to In Progress"
               -- reads as the destination rather than the origin.
               CASE WHEN COALESCE(cl.from_string, '') = '' THEN NULL
                    ELSE 'from ' || cl.from_string END AS detail,
               w.url AS url
          FROM jira_changelog cl
          LEFT JOIN jira_workitems w ON w.site = cl.site AND w.id = cl.workitem_id
         WHERE LOWER(COALESCE(cl.field, '')) = 'status' AND cl.created_at IS NOT NULL`,
      params: [],
    });

    all.push({
      source: 'jira',
      kind: 'comment',
      sql: `
        SELECT 'jira' AS source, 'comment' AS kind, 'commented' AS action,
               c.workitem_key AS ref, w.project_key AS container, w.summary AS title,
               c.author AS actor,
               c.created_at AS at,
               SUBSTR(c.body, 1, ${String(EXCERPT)}) AS detail,
               w.url AS url
          FROM jira_comments c
          LEFT JOIN jira_workitems w ON w.site = c.site AND w.id = c.workitem_id
         WHERE c.created_at IS NOT NULL`,
      params: [],
    });
  }

  return all.filter((part) => wantKind.has(part.kind));
}

/**
 * The filters every part shares, applied to the union rather than to each
 * statement.
 *
 * The columns are already named the same by then, so one `WHERE` covers eight
 * different tables and cannot drift between them — which it would, written
 * eight times.
 */
function outerWhere(filter: ActivityFilter): { sql: string; params: BindValue[] } {
  const clauses: string[] = [];
  const params: BindValue[] = [];

  const add = (sql: string, ...values: BindValue[]): void => {
    clauses.push(sql);
    params.push(...values);
  };

  if (filter.since) add('at >= ?', filter.since);
  if (filter.until) add('at < ?', filter.until);

  if (filter.containers?.length) {
    add(`container IN (${filter.containers.map(() => '?').join(', ')})`, ...filter.containers);
  }

  /*
   * The person filter is per source, and the union has already mixed the two.
   * So it is written as "a GitHub row matching a GitHub identity, or a Jira row
   * matching a Jira one" — which also gets the empty-list case right on each
   * side independently.
   */
  if (filter.people) {
    const github = anyPerson([{ column: 'actor' }], filter.people.github);
    const jira = anyPerson([{ column: 'actor' }], filter.people.jira);
    add(
      `((source = 'github' AND ${github.sql}) OR (source = 'jira' AND ${jira.sql}))`,
      ...github.params,
      ...jira.params,
    );
  }

  if (filter.excludeBots === true) {
    const clause = notABot('actor', filter.bots);
    add(clause.sql, ...clause.params);
  }
  if (filter.onlyBots === true) {
    const clause = isABot('actor', filter.bots);
    add(clause.sql, ...clause.params);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function union(filter: ActivityFilter): { sql: string; params: BindValue[] } | null {
  const selected = parts(filter);
  if (selected.length === 0) return null;

  return {
    sql: selected.map((part) => part.sql).join('\n UNION ALL\n'),
    params: selected.flatMap((part) => part.params),
  };
}

export function listActivity(db: Database, filter: ActivityFilter = {}): ActivityEvent[] {
  const inner = union(filter);
  if (!inner) return [];
  const where = outerWhere(filter);

  return db.all<ActivityEvent>(
    `SELECT * FROM (${inner.sql}) ${where.sql}
      ORDER BY at DESC, ref, kind
      LIMIT ? OFFSET ?`,
    [...inner.params, ...where.params, filter.limit ?? 100, filter.offset ?? 0],
  );
}

export function countActivity(db: Database, filter: ActivityFilter = {}): number {
  const inner = union(filter);
  if (!inner) return 0;
  const where = outerWhere(filter);

  return (
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (${inner.sql}) ${where.sql}`, [
      ...inner.params,
      ...where.params,
    ])?.n ?? 0
  );
}

export interface ActivityByActor {
  source: 'github' | 'jira';
  actor: string;
  status: number;
  comments: number;
  reviews: number;
  total: number;
  lastSeen: string;
}

/**
 * Who was busy in the window, busiest first.
 *
 * Per raw identity rather than per person, for the same reason
 * `people --identities` is: this is also the view that shows a login nobody
 * mapped, and rolling it into a person would hide exactly that.
 */
export function activityByActor(db: Database, filter: ActivityFilter = {}): ActivityByActor[] {
  const inner = union(filter);
  if (!inner) return [];
  const where = outerWhere(filter);

  return db.all<ActivityByActor>(
    `SELECT source, actor,
            SUM(kind = 'status')  AS status,
            SUM(kind = 'comment') AS comments,
            SUM(kind = 'review')  AS reviews,
            COUNT(*)              AS total,
            MAX(at)               AS lastSeen
       FROM (${inner.sql})
       ${where.sql}${where.sql ? ' AND' : 'WHERE'} actor IS NOT NULL AND actor <> ''
      GROUP BY source, LOWER(actor)
      ORDER BY total DESC, actor ASC
      LIMIT ?`,
    [...inner.params, ...where.params, filter.limit && filter.limit > 0 ? filter.limit : 50],
  );
}
