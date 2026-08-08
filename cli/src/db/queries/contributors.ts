/**
 * Reading the contributor table back.
 *
 * Two questions, and the second is the one that could not be asked before:
 *
 * - **Who worked on this item** — the names on one issue, pull request or work
 *   item, with what each of them did.
 * - **Who worked on this epic** — the same, rolled up over everything beneath
 *   it: the child work items, and the pull requests that reference any of them.
 *   Nobody contributes to an epic directly; an epic is a heading. Asked without
 *   the rollup it answers "the person who created the heading", which is true
 *   and useless.
 */

import type { BindValue, Database } from '../database.js';

export interface Contribution {
  source: 'github' | 'jira';
  ref: string;
  kind: string;
  container: string;
  identity: string;
  role: string;
  events: number;
  first_at: string | null;
  last_at: string | null;
}

export interface ContributorSummary {
  identity: string;
  source: 'github' | 'jira';
  /** Every capacity they acted in, in the table's order. */
  roles: string[];
  /** Which items, so a name can be followed back to the work. */
  refs: string[];
  events: number;
  first_at: string | null;
  last_at: string | null;
}

/** Board order for the roles, so two lists of names read the same way. */
const ROLE_ORDER = `CASE role
    WHEN 'author' THEN 0
    WHEN 'reporter' THEN 1
    WHEN 'assignee' THEN 2
    WHEN 'committer' THEN 3
    WHEN 'worked' THEN 4
    WHEN 'reviewer' THEN 5
    WHEN 'review_requested' THEN 6
    WHEN 'commenter' THEN 7
    WHEN 'merged_by' THEN 8
    ELSE 9 END`;

export function contributionsOf(db: Database, refs: string[]): Contribution[] {
  if (refs.length === 0) return [];

  return db.all<Contribution>(
    `SELECT source, ref, kind, container, identity, role, events, first_at, last_at
       FROM contributors
      WHERE ref IN (${refs.map(() => '?').join(', ')})
      ORDER BY ${ROLE_ORDER}, events DESC, identity`,
    refs,
  );
}

/**
 * The same rows folded to one per person.
 *
 * Per raw identity rather than per configured person, like everything else that
 * reports names: the caller has the directory and can resolve them, and folding
 * here would hide the login nobody has mapped yet — which is the row worth
 * seeing.
 */
export function contributorsOf(db: Database, refs: string[]): ContributorSummary[] {
  const rows = contributionsOf(db, refs);
  const byIdentity = new Map<string, ContributorSummary>();

  for (const row of rows) {
    const key = `${row.source} ${row.identity.toLowerCase()}`;
    const found = byIdentity.get(key);
    if (!found) {
      byIdentity.set(key, {
        identity: row.identity,
        source: row.source,
        roles: [row.role],
        refs: [row.ref],
        events: row.events,
        first_at: row.first_at,
        last_at: row.last_at,
      });
      continue;
    }

    if (!found.roles.includes(row.role)) found.roles.push(row.role);
    if (!found.refs.includes(row.ref)) found.refs.push(row.ref);
    found.events += row.events;
    found.first_at = earlier(found.first_at, row.first_at);
    found.last_at = later(found.last_at, row.last_at);
  }

  // Busiest first, and the roles already arrived in board order, so whoever
  // authored something outranks whoever commented on it once.
  return [...byIdentity.values()].toSorted(
    (a, b) => b.events - a.events || a.identity.localeCompare(b.identity),
  );
}

/** The earlier of two timestamps, either of which may be missing. */
function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * Everything beneath a reference, including itself.
 *
 * Two hops, and both are needed for an epic to answer honestly:
 *
 * - **down the Jira hierarchy**, so a feature reaches its stories and an epic
 *   reaches everything under both;
 * - **across the cross references**, so a story reaches the pull requests that
 *   implemented it — which is where the committers and reviewers are, and
 *   there is no other route to them from a Jira key.
 *
 * Bounded rather than recursive-until-quiet: a parent cycle in Jira is rare and
 * entirely possible, and a builder that hangs on one is worse than one that
 * stops a level short and says so.
 */
export function descendantsOf(db: Database, ref: string, depth = 6): string[] {
  const seen = new Set<string>([ref]);
  let frontier = [ref];

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    const params: BindValue[] = frontier;
    const holes = frontier.map(() => '?').join(', ');

    const children = db.all<{ key: string }>(
      `SELECT key FROM jira_workitems WHERE parent_key IN (${holes})`,
      params,
    );
    // Both directions: a pull request links to a ticket as readily as the
    // other way round, and which side stored it depends on where the reference
    // was written.
    const linked = db.all<{ key: string }>(
      `SELECT to_ref AS key FROM cross_links WHERE from_ref IN (${holes})
       UNION
       SELECT from_ref AS key FROM cross_links WHERE to_ref IN (${holes})`,
      [...params, ...params],
    );

    for (const row of [...children, ...linked]) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      next.push(row.key);
    }
    frontier = next;
  }

  return [...seen];
}
