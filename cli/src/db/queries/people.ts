/**
 * Filtering and counting by person rather than by spelling.
 *
 * Two things live here. The first is the `WHERE` fragments that turn a
 * resolved `PersonSelection` into SQL — one place, so the issue list, the pull
 * request list and the merged ticket list all agree on what "by this team"
 * means. The second is the roll up behind `devcontext people`: how much each
 * configured person actually appears in the data, which is the only way to
 * notice that a mapping is missing an identity.
 */

import type { BindValue, Database } from '../database.js';

/** SQL and the values it binds, ready to be folded into a bigger statement. */
export interface Clause {
  sql: string;
  params: BindValue[];
}

const EMPTY: Clause = { sql: '', params: [] };

/**
 * Where a person's name can appear on one row.
 *
 * `json` marks a column holding a JSON array of names — GitHub's `assignees` —
 * which has to be matched with `LIKE` rather than compared.
 */
export interface PersonColumn {
  column: string;
  json?: boolean;
}

/**
 * `any of these columns names one of these people`.
 *
 * The two empty cases mean opposite things, and getting them the same way round
 * is the whole point:
 *
 * - `undefined` is *no filter*. Nobody was selected, so every row qualifies.
 * - `[]` is *a filter nothing satisfies*. Somebody was selected and turned out
 *   to have no identity on this source — a Jira-only colleague asked about on
 *   the GitHub side. The honest answer there is no rows, not all of them.
 *
 * The second case is easy to get wrong and impossible to spot afterwards: the
 * query returns every issue in the repository and looks like a busy team.
 */
export function anyPerson(
  columns: readonly PersonColumn[],
  identities: readonly string[] | undefined,
): Clause {
  if (identities === undefined || columns.length === 0) return EMPTY;
  if (identities.length === 0) return { sql: '0', params: [] };

  const parts: string[] = [];
  const params: BindValue[] = [];

  for (const { column, json } of columns) {
    if (json) {
      for (const identity of identities) {
        parts.push(`LOWER(${column}) LIKE ?`);
        params.push(`%"${identity}"%`);
      }
    } else {
      parts.push(`LOWER(${column}) IN (${identities.map(() => '?').join(', ')})`);
      params.push(...identities);
    }
  }

  return { sql: `(${parts.join(' OR ')})`, params };
}

/**
 * `this column is not a bot`.
 *
 * Configured bots first, then GitHub's own `[bot]` suffix, so a repository gets
 * the obvious automations excluded without configuring anything and can still
 * name the service account whose login gives nothing away.
 *
 * A row with no author at all survives: a deleted GitHub account leaves the
 * column null, and that is a person whose name is gone, not a robot.
 */
export function notABot(column: string, bots: readonly string[] | undefined): Clause {
  const params: BindValue[] = [];
  const parts = [`LOWER(${column}) NOT LIKE '%[bot]'`];

  if (bots && bots.length > 0) {
    parts.push(`LOWER(${column}) NOT IN (${bots.map(() => '?').join(', ')})`);
    params.push(...bots);
  }

  return { sql: `(${column} IS NULL OR (${parts.join(' AND ')}))`, params };
}

/** The mirror image of `notABot`, for a list that wants only the automations. */
export function isABot(column: string, bots: readonly string[] | undefined): Clause {
  const params: BindValue[] = [];
  const parts = [`LOWER(${column}) LIKE '%[bot]'`];

  if (bots && bots.length > 0) {
    parts.push(`LOWER(${column}) IN (${bots.map(() => '?').join(', ')})`);
    params.push(...bots);
  }

  return { sql: `(${parts.join(' OR ')})`, params };
}

/** How often one identity appears, counted per place it can appear. */
export interface IdentityActivity {
  source: 'github' | 'jira';
  identity: string;
  /** GitHub issues authored, or Jira work items reported. */
  authored: number;
  /** GitHub issues and pull requests assigned, or Jira work items assigned. */
  assigned: number;
  /** Pull requests opened; always 0 on the Jira side. */
  pullRequests: number;
  /** Reviews left; always 0 on the Jira side. */
  reviews: number;
  comments: number;
  /** The newest timestamp any of the above carries. */
  lastSeen: string | null;
}

/**
 * What the data knows about one identity.
 *
 * Deliberately per identity rather than per person: the point of the number is
 * to check the mapping, and a per person total would hide the second login that
 * was spelled wrong and matches nothing.
 */
export function identityActivity(
  db: Database,
  source: 'github' | 'jira',
  identity: string,
): IdentityActivity {
  const value = identity.trim().toLowerCase();
  const like = `%"${value}"%`;

  const count = (sql: string, params: BindValue[]): number =>
    db.get<{ n: number }>(sql, params)?.n ?? 0;

  const newest = (sql: string, params: BindValue[]): string | null =>
    db.get<{ at: string | null }>(sql, params)?.at ?? null;

  if (source === 'github') {
    return {
      source,
      identity,
      authored: count(
        'SELECT COUNT(*) AS n FROM gh_issues WHERE LOWER(author) = ? AND is_pull_request = 0',
        [value],
      ),
      assigned: count('SELECT COUNT(*) AS n FROM gh_issues WHERE LOWER(assignees) LIKE ?', [like]),
      pullRequests: count('SELECT COUNT(*) AS n FROM gh_pull_requests WHERE LOWER(author) = ?', [
        value,
      ]),
      reviews: count('SELECT COUNT(*) AS n FROM gh_reviews WHERE LOWER(author) = ?', [value]),
      comments: count('SELECT COUNT(*) AS n FROM gh_comments WHERE LOWER(author) = ?', [value]),
      lastSeen: newest(
        `SELECT MAX(at) AS at FROM (
           SELECT MAX(updated_at) AS at FROM gh_issues WHERE LOWER(author) = ?
           UNION ALL SELECT MAX(created_at) FROM gh_comments WHERE LOWER(author) = ?
           UNION ALL SELECT MAX(submitted_at) FROM gh_reviews WHERE LOWER(author) = ?
         )`,
        [value, value, value],
      ),
    };
  }

  return {
    source,
    identity,
    authored: count('SELECT COUNT(*) AS n FROM jira_workitems WHERE LOWER(reporter) = ?', [value]),
    assigned: count('SELECT COUNT(*) AS n FROM jira_workitems WHERE LOWER(assignee) = ?', [value]),
    pullRequests: 0,
    reviews: 0,
    comments: count('SELECT COUNT(*) AS n FROM jira_comments WHERE LOWER(author) = ?', [value]),
    lastSeen: newest(
      `SELECT MAX(at) AS at FROM (
         SELECT MAX(updated_at) AS at FROM jira_workitems WHERE LOWER(reporter) = ? OR LOWER(assignee) = ?
         UNION ALL SELECT MAX(created_at) FROM jira_comments WHERE LOWER(author) = ?
       )`,
      [value, value, value],
    ),
  };
}

/** One name found in the data, with how often it appears and who it maps to. */
export interface UnmappedIdentity {
  source: 'github' | 'jira';
  identity: string;
  count: number;
}

/**
 * The names nobody claimed, busiest first.
 *
 * This is what makes the mapping maintainable: a colleague who joined last
 * month, or renamed their account, shows up here rather than quietly halving
 * their own numbers.
 *
 * `mapped` comes from the configuration rather than from `person_identities`,
 * for the same reason nothing else reads that table — a name added to the yaml
 * should stop being reported now, not after the next sync. The cut to `limit`
 * happens after that filter, so asking for ten unmapped names cannot come back
 * with three because seven of the busiest authors were already configured.
 */
export function unmappedIdentities(
  db: Database,
  mapped: { has(key: string): boolean },
  options: { limit?: number } = {},
): UnmappedIdentity[] {
  const rows = db.all<UnmappedIdentity>(
    `SELECT source, identity, SUM(n) AS count FROM (
         SELECT 'github' AS source, author AS identity, COUNT(*) AS n
           FROM gh_issues WHERE author IS NOT NULL AND author <> '' GROUP BY author
         UNION ALL
         SELECT 'github', author, COUNT(*) FROM gh_comments
           WHERE author IS NOT NULL AND author <> '' GROUP BY author
         UNION ALL
         SELECT 'jira', reporter, COUNT(*) FROM jira_workitems
           WHERE reporter IS NOT NULL AND reporter <> '' GROUP BY reporter
         UNION ALL
         SELECT 'jira', assignee, COUNT(*) FROM jira_workitems
           WHERE assignee IS NOT NULL AND assignee <> '' GROUP BY assignee
       )
       GROUP BY source, LOWER(identity)
       ORDER BY count DESC, identity ASC`,
  );

  const limit = options.limit && options.limit > 0 ? options.limit : 25;
  return rows
    .filter((row) => !mapped.has(`${row.source}:${row.identity.trim().toLowerCase()}`))
    .slice(0, limit);
}
