/**
 * GitHub issues and Jira work items as one list.
 *
 * They are the same thing to a person — a ticket somebody has to deal with —
 * and different things to the database, which stores them in different tables
 * with different columns and different words for the same idea. This module is
 * where that difference is reconciled, once, so no caller has to.
 *
 * Pull requests are deliberately not here. A pull request is a change, not a
 * request for one, and it already has a list of its own.
 */

import type { Database } from '../database.js';

export interface Ticket {
  source: 'github' | 'jira';
  /** `acme/platform#42` or `PLAT-7`. Unique across both. */
  ref: string;
  /** The repository or the Jira project — whichever the ticket lives in. */
  container: string;
  /** GitHub's issue type, or Jira's, or `Issue` for a repository with none. */
  type: string;
  title: string | null;
  /** The word the source uses: `open`, `closed`, `In Progress`, `Done`. */
  status: string | null;
  /** Normalised to `open` or `closed`, so both sides can be counted together. */
  state: 'open' | 'closed';
  assignee: string | null;
  author: string | null;
  updated_at: string | null;
  created_at: string | null;
  url: string | null;
}

export interface TicketFilter {
  /** `github`, `jira`, or both when omitted. */
  sources?: string[];
  /** Repository full names and Jira project keys, mixed freely. */
  containers?: string[];
  types?: string[];
  state?: 'open' | 'closed' | 'all';
  search?: string;
  assignee?: string;
  limit?: number;
  offset?: number;
}

export interface TicketTypeCount {
  source: 'github' | 'jira';
  type: string;
  /** How many tickets carry it, after every other filter is applied. */
  count: number;
}

/**
 * The type of a GitHub issue.
 *
 * GitHub only started offering typed issues recently and most repositories
 * still have none, so the fallback is the word for what it is. Saying `Issue`
 * rather than leaving it blank keeps the type filter usable on a repository
 * that never adopted them — the alternative is a dropdown entry called
 * "(none)" matching almost everything.
 */
const GITHUB_TYPE = `COALESCE(NULLIF(json_extract(raw, '$.type.name'), ''), 'Issue')`;

/**
 * Jira has no open/closed flag, only a status and the category it belongs to.
 * "Done" is the category that means finished, which is the same rule the state
 * history uses — the two would be worth nothing if they disagreed.
 */
const JIRA_STATE = `CASE WHEN LOWER(COALESCE(status_category, '')) = 'done' THEN 'closed' ELSE 'open' END`;

interface Clause {
  sql: string;
  params: Array<string | number>;
}

/** `column IN (?, ?, ?)`, or nothing at all when the list is empty. */
function anyOf(column: string, values: string[] | undefined): Clause {
  if (!values || values.length === 0) return { sql: '', params: [] };
  return {
    sql: ` AND ${column} IN (${values.map(() => '?').join(', ')})`,
    params: [...values],
  };
}

/**
 * The two halves of the union, each already filtered.
 *
 * Built as a pair rather than one string so a caller asking for only one
 * source does not pay for a scan of the other's table.
 */
function halves(filter: TicketFilter): Array<{ source: 'github' | 'jira'; select: Clause }> {
  const wanted = new Set(filter.sources?.length ? filter.sources : ['github', 'jira']);
  const out: Array<{ source: 'github' | 'jira'; select: Clause }> = [];

  if (wanted.has('github')) {
    const params: Array<string | number> = [];
    let sql = `
      SELECT 'github' AS source,
             repo_full_name || '#' || number AS ref,
             repo_full_name AS container,
             ${GITHUB_TYPE} AS type,
             title,
             state AS status,
             state AS state,
             json_extract(assignees, '$[0]') AS assignee,
             author,
             updated_at,
             created_at,
             html_url AS url
        FROM gh_issues
       WHERE is_pull_request = 0`;

    const container = anyOf('repo_full_name', filter.containers);
    sql += container.sql;
    params.push(...container.params);

    const type = anyOf(GITHUB_TYPE, filter.types);
    sql += type.sql;
    params.push(...type.params);

    if (filter.state && filter.state !== 'all') {
      sql += ' AND state = ?';
      params.push(filter.state);
    }
    if (filter.search) {
      sql += ' AND (title LIKE ? OR body LIKE ?)';
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    if (filter.assignee) {
      sql += ' AND assignees LIKE ?';
      params.push(`%${filter.assignee}%`);
    }

    out.push({ source: 'github', select: { sql, params } });
  }

  if (wanted.has('jira')) {
    const params: Array<string | number> = [];
    let sql = `
      SELECT 'jira' AS source,
             key AS ref,
             project_key AS container,
             COALESCE(NULLIF(type, ''), 'Unknown') AS type,
             summary AS title,
             status AS status,
             ${JIRA_STATE} AS state,
             assignee,
             reporter AS author,
             updated_at,
             created_at,
             url
        FROM jira_workitems
       WHERE 1 = 1`;

    const container = anyOf('project_key', filter.containers);
    sql += container.sql;
    params.push(...container.params);

    const type = anyOf(`COALESCE(NULLIF(type, ''), 'Unknown')`, filter.types);
    sql += type.sql;
    params.push(...type.params);

    if (filter.state && filter.state !== 'all') {
      sql += ` AND ${JIRA_STATE} = ?`;
      params.push(filter.state);
    }
    if (filter.search) {
      sql += ' AND (summary LIKE ? OR description LIKE ?)';
      params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    if (filter.assignee) {
      sql += ' AND assignee LIKE ?';
      params.push(`%${filter.assignee}%`);
    }

    out.push({ source: 'jira', select: { sql, params } });
  }

  return out;
}

export function listTickets(db: Database, filter: TicketFilter = {}): Ticket[] {
  const parts = halves(filter);
  if (parts.length === 0) return [];

  const sql = `${parts.map((part) => part.select.sql).join('\n UNION ALL\n')}
     ORDER BY updated_at DESC NULLS LAST
     LIMIT ? OFFSET ?`;
  const params = [
    ...parts.flatMap((part) => part.select.params),
    filter.limit ?? 100,
    filter.offset ?? 0,
  ];

  return db.all<Ticket>(sql, params);
}

export function countTickets(db: Database, filter: TicketFilter = {}): number {
  const parts = halves(filter);
  if (parts.length === 0) return 0;

  const sql = `SELECT COUNT(*) AS total FROM (
    ${parts.map((part) => part.select.sql).join('\n UNION ALL\n')}
  )`;
  const row = db.get<{ total: number }>(
    sql,
    parts.flatMap((part) => part.select.params),
  );
  return row?.total ?? 0;
}

/**
 * Every type present, with how many tickets carry it.
 *
 * Read off the data rather than listed anywhere, so a Jira project that
 * invents a type gets a filter entry without anybody editing a constant — and
 * a type nobody uses does not appear at all.
 *
 * Every filter except `types` is applied, so the counts describe the list the
 * caller is actually looking at. Applying `types` as well would leave each
 * type showing only itself.
 */
export function ticketTypes(db: Database, filter: TicketFilter = {}): TicketTypeCount[] {
  const parts = halves({ ...filter, types: undefined, limit: undefined, offset: undefined });
  if (parts.length === 0) return [];

  const sql = `SELECT source, type, COUNT(*) AS count FROM (
    ${parts.map((part) => part.select.sql).join('\n UNION ALL\n')}
  ) GROUP BY source, type
    -- Source breaks the last tie: both sides can have a type called "Bug", and
    -- an order that leaves those two in whatever sequence SQLite felt like
    -- makes the filter list reshuffle between requests.
    ORDER BY count DESC, type, source`;

  return db.all<TicketTypeCount>(
    sql,
    parts.flatMap((part) => part.select.params),
  );
}

/** Every repository and Jira project that has at least one ticket. */
export function ticketContainers(
  db: Database,
  filter: TicketFilter = {},
): Array<{ source: 'github' | 'jira'; container: string; count: number }> {
  const parts = halves({ ...filter, containers: undefined, limit: undefined, offset: undefined });
  if (parts.length === 0) return [];

  const sql = `SELECT source, container, COUNT(*) AS count FROM (
    ${parts.map((part) => part.select.sql).join('\n UNION ALL\n')}
  ) GROUP BY source, container ORDER BY source, container`;

  return db.all<{ source: 'github' | 'jira'; container: string; count: number }>(
    sql,
    parts.flatMap((part) => part.select.params),
  );
}
