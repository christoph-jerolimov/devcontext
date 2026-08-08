/**
 * Who touched each item, and in what capacity.
 *
 * "Who worked on this ticket" is a question the stored rows can nearly answer
 * and never quite do. The author is a column on the item; the reviewers are
 * rows in `gh_reviews`; the commenters in `gh_comments` and `jira_comments`;
 * the people who actually wrote the code in `gh_commits`. Answering it meant a
 * join nobody wants to write twice, so in practice it got answered with the
 * author column alone — which names the one person guaranteed not to have done
 * the reviewing.
 *
 * ## Why the capacity is the whole point
 *
 * A flat list of names is the easy version and the useless one. "Involved"
 * flattens the person who wrote it, the person who reviewed it and the person
 * who left one drive-by comment into the same word, and no decision anybody
 * makes from this list treats those the same. So each row carries a role, and
 * a count — the difference between having been present and having carried it.
 *
 * ## Why it is derived
 *
 * Nothing here calls an API. Every name it records is already in the database,
 * which makes the table disposable: it is dropped and rebuilt on every sync,
 * exactly like the cross references and the state history. An existing
 * database gets contributors without fetching a byte, and a role added later
 * appears everywhere at once rather than only on items synced since.
 */

import type { BindValue, Database } from '../db/database.js';

export interface ContributorStats {
  items: number;
  contributions: number;
}

/**
 * The capacities, in the order a reader wants them.
 *
 * Roughly "how much of this is theirs", which is the order a list of names is
 * read in: whoever raised and carried the work first, whoever weighed in last.
 */
export const CONTRIBUTOR_ROLES = [
  'author',
  'reporter',
  'assignee',
  'committer',
  'worked',
  'reviewer',
  'review_requested',
  'commenter',
  'merged_by',
] as const;

export type ContributorRole = (typeof CONTRIBUTOR_ROLES)[number];

/** What each role means, for the places that have to explain themselves. */
export const ROLE_DESCRIPTIONS: Record<ContributorRole, string> = {
  author: 'opened it',
  reporter: 'reported it on somebody else’s behalf',
  assignee: 'it was assigned to them',
  committer: 'wrote commits on it',
  worked: 'logged work against it',
  reviewer: 'reviewed it',
  review_requested: 'was asked to review it, and has not yet',
  commenter: 'commented on it',
  merged_by: 'merged it',
};

/**
 * One statement per role per source.
 *
 * Each returns the same six columns so the insert is written once. Written out
 * rather than generated because every one reaches its identity differently —
 * a column here, a JSON array there, a join to a third table — and a generator
 * hiding that would be longer than the statements it replaced.
 *
 * `NULLIF(x, '')` throughout: an absent author is stored as an empty string in
 * places and as NULL in others, and a contributor called "" is a row that
 * looks like a person until somebody tries to click it.
 */
const SOURCES: ReadonlyArray<{ role: ContributorRole; sql: string }> = [
  // --- GitHub issues and pull requests ------------------------------------
  {
    role: 'author',
    sql: `
      SELECT 'github' AS source,
             repo_full_name || '#' || number AS ref,
             CASE WHEN is_pull_request = 1 THEN 'pull_request' ELSE 'issue' END AS kind,
             repo_full_name AS container,
             author AS identity,
             1 AS events, created_at AS first_at, created_at AS last_at
        FROM gh_issues
       WHERE NULLIF(author, '') IS NOT NULL`,
  },
  {
    role: 'assignee',
    sql: `
      SELECT 'github' AS source,
             i.repo_full_name || '#' || i.number AS ref,
             CASE WHEN i.is_pull_request = 1 THEN 'pull_request' ELSE 'issue' END AS kind,
             i.repo_full_name AS container,
             a.value AS identity,
             1 AS events, i.created_at AS first_at, i.updated_at AS last_at
        FROM gh_issues i, JSON_EACH(COALESCE(NULLIF(i.assignees, ''), '[]')) a
       WHERE NULLIF(a.value, '') IS NOT NULL`,
  },
  {
    role: 'commenter',
    sql: `
      SELECT 'github' AS source,
             c.repo_full_name || '#' || c.issue_number AS ref,
             CASE WHEN i.is_pull_request = 1 THEN 'pull_request' ELSE 'issue' END AS kind,
             c.repo_full_name AS container,
             c.author AS identity,
             COUNT(*) AS events, MIN(c.created_at) AS first_at, MAX(c.created_at) AS last_at
        FROM gh_comments c
        LEFT JOIN gh_issues i ON i.host = c.host AND i.id = c.issue_id
       WHERE NULLIF(c.author, '') IS NOT NULL
       GROUP BY c.repo_full_name, c.issue_number, c.author, i.is_pull_request`,
  },
  {
    // An inline note on the diff is somebody saying something, the same as any
    // other comment. Counting it as a review would make one reviewer look like
    // several, and the review row below already records the verdict.
    role: 'commenter',
    sql: `
      SELECT 'github' AS source,
             rc.repo_full_name || '#' || rc.pr_number AS ref,
             'pull_request' AS kind,
             rc.repo_full_name AS container,
             rc.author AS identity,
             COUNT(*) AS events, MIN(rc.created_at) AS first_at, MAX(rc.created_at) AS last_at
        FROM gh_review_comments rc
       WHERE NULLIF(rc.author, '') IS NOT NULL
       GROUP BY rc.repo_full_name, rc.pr_number, rc.author`,
  },
  {
    role: 'reviewer',
    sql: `
      SELECT 'github' AS source,
             r.repo_full_name || '#' || r.pr_number AS ref,
             'pull_request' AS kind,
             r.repo_full_name AS container,
             r.author AS identity,
             COUNT(*) AS events, MIN(r.submitted_at) AS first_at, MAX(r.submitted_at) AS last_at
        FROM gh_reviews r
       WHERE NULLIF(r.author, '') IS NOT NULL
       GROUP BY r.repo_full_name, r.pr_number, r.author`,
  },
  {
    /*
     * Asked, and has not answered.
     *
     * GitHub drops a login from requested_reviewers the moment they submit, so
     * what remains is exactly the outstanding asks. Recording it as `reviewer`
     * would say somebody reviewed a pull request they have not looked at.
     */
    role: 'review_requested',
    sql: `
      SELECT 'github' AS source,
             p.repo_full_name || '#' || p.number AS ref,
             'pull_request' AS kind,
             p.repo_full_name AS container,
             rr.value AS identity,
             1 AS events, p.created_at AS first_at, p.updated_at AS last_at
        FROM gh_pull_requests p,
             JSON_EACH(COALESCE(NULLIF(p.requested_reviewers, ''), '[]')) rr
       WHERE NULLIF(rr.value, '') IS NOT NULL`,
  },
  {
    role: 'committer',
    sql: `
      SELECT 'github' AS source,
             c.repo_full_name || '#' || c.pr_number AS ref,
             'pull_request' AS kind,
             c.repo_full_name AS container,
             -- The login when GitHub matched the commit to an account, and the
             -- name off the commit itself when it did not. A commit written
             -- from an unmatched email is still work somebody did.
             COALESCE(NULLIF(c.author_login, ''), NULLIF(c.author_name, '')) AS identity,
             COUNT(*) AS events, MIN(c.authored_at) AS first_at, MAX(c.authored_at) AS last_at
        FROM gh_commits c
       WHERE c.pr_number IS NOT NULL
         AND COALESCE(NULLIF(c.author_login, ''), NULLIF(c.author_name, '')) IS NOT NULL
       GROUP BY c.repo_full_name, c.pr_number,
                COALESCE(NULLIF(c.author_login, ''), NULLIF(c.author_name, ''))`,
  },
  {
    role: 'merged_by',
    sql: `
      SELECT 'github' AS source,
             repo_full_name || '#' || number AS ref,
             'pull_request' AS kind,
             repo_full_name AS container,
             merged_by AS identity,
             1 AS events, merged_at AS first_at, merged_at AS last_at
        FROM gh_pull_requests
       WHERE NULLIF(merged_by, '') IS NOT NULL`,
  },

  // --- Jira ---------------------------------------------------------------
  {
    role: 'author',
    sql: `
      SELECT 'jira' AS source, key AS ref, 'workitem' AS kind, project_key AS container,
             COALESCE(NULLIF(creator, ''), NULLIF(reporter, '')) AS identity,
             1 AS events, created_at AS first_at, created_at AS last_at
        FROM jira_workitems
       WHERE COALESCE(NULLIF(creator, ''), NULLIF(reporter, '')) IS NOT NULL`,
  },
  {
    /*
     * Only when it differs from the creator.
     *
     * Jira sets both to the same person on most tickets, and a role that
     * repeats the author on every row says nothing. When they differ it says
     * something real: somebody filed this on somebody else's behalf.
     */
    role: 'reporter',
    sql: `
      SELECT 'jira' AS source, key AS ref, 'workitem' AS kind, project_key AS container,
             reporter AS identity,
             1 AS events, created_at AS first_at, created_at AS last_at
        FROM jira_workitems
       WHERE NULLIF(reporter, '') IS NOT NULL
         AND COALESCE(NULLIF(creator, ''), reporter) <> reporter`,
  },
  {
    role: 'assignee',
    sql: `
      SELECT 'jira' AS source, key AS ref, 'workitem' AS kind, project_key AS container,
             assignee AS identity,
             1 AS events, created_at AS first_at, updated_at AS last_at
        FROM jira_workitems
       WHERE NULLIF(assignee, '') IS NOT NULL`,
  },
  {
    role: 'commenter',
    sql: `
      SELECT 'jira' AS source, c.workitem_key AS ref, 'workitem' AS kind,
             w.project_key AS container,
             c.author AS identity,
             COUNT(*) AS events, MIN(c.created_at) AS first_at, MAX(c.created_at) AS last_at
        FROM jira_comments c
        LEFT JOIN jira_workitems w ON w.site = c.site AND w.id = c.workitem_id
       WHERE NULLIF(c.author, '') IS NOT NULL AND w.project_key IS NOT NULL
       GROUP BY c.workitem_key, w.project_key, c.author`,
  },
  {
    /*
     * Logged time against it — the implementation work itself, rather than the
     * conversation around it. The only record of somebody who did the work
     * without ever being the assignee.
     */
    role: 'worked',
    sql: `
      SELECT 'jira' AS source, w.key AS ref, 'workitem' AS kind, w.project_key AS container,
             l.author AS identity,
             COUNT(*) AS events, MIN(l.started_at) AS first_at, MAX(l.started_at) AS last_at
        FROM jira_worklogs l
        JOIN jira_workitems w ON w.site = l.site AND w.id = l.workitem_id
       WHERE NULLIF(l.author, '') IS NOT NULL
       GROUP BY w.key, w.project_key, l.author`,
  },
];

/**
 * Rebuilds the whole table.
 *
 * Rebuilt rather than appended to, for the same reason the state history is: a
 * sync that filled in comments the last one missed has to change what the
 * earlier rows say, and a reviewer who was removed from a pull request should
 * stop being one.
 */
export function buildContributors(db: Database): ContributorStats {
  return db.transaction(() => {
    db.exec('DELETE FROM contributors');

    for (const entry of SOURCES) {
      /*
       * ON CONFLICT rather than a plain insert: one identity can reach the
       * same role by two routes — a comment on the conversation and a note on
       * the diff are both comments — and the counts have to add up rather than
       * the second one losing.
       */
      db.run(
        `INSERT INTO contributors (source, ref, kind, container, identity, role, events, first_at, last_at)
         SELECT source, ref, kind, container, identity, ?, events, first_at, last_at
           FROM (${entry.sql})
         WHERE TRUE
         ON CONFLICT (source, ref, identity, role) DO UPDATE SET
           events   = events + excluded.events,
           first_at = MIN(COALESCE(first_at, excluded.first_at), COALESCE(excluded.first_at, first_at)),
           last_at  = MAX(COALESCE(last_at,  excluded.last_at),  COALESCE(excluded.last_at,  last_at))`,
        [entry.role] as BindValue[],
      );
    }

    const counted = db.get<{ items: number; contributions: number }>(
      `SELECT COUNT(DISTINCT source || ' ' || ref) AS items, COUNT(*) AS contributions
         FROM contributors`,
    );

    return { items: counted?.items ?? 0, contributions: counted?.contributions ?? 0 };
  });
}
