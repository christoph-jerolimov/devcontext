/**
 * What the last sync can tell the next one about the size of this one.
 *
 * Two costs cannot be probed from either API before the work starts: how many
 * jobs a workflow run has, and how many sprints hang off a board. There is no
 * endpoint that answers either without listing them, which is the work itself.
 *
 * But they are not unknowable, only unaskable — the database already holds the
 * answer from last time, and neither ratio moves much between two syncs. A
 * repository whose runs averaged four jobs yesterday will not average one
 * today.
 *
 * Every function here returns `null` when there is no history to go on, which
 * on a first sync is always. The caller falls back to a constant and the walk
 * corrects it, exactly as before.
 */

import type { Database } from '../db/database.js';

/** The mean, or null when the sample is empty. Keeps the SQL out of the caller. */
function ratio(db: Database, sql: string, params: string[]): number | null {
  const row = db.get<{ parents: number; children: number }>(sql, params);
  if (!row || row.parents === 0) return null;
  return row.children / row.parents;
}

/**
 * Jobs per workflow run, from the runs already stored for this repository.
 *
 * Counted over runs that actually have jobs. A run whose jobs were never
 * fetched — because `workflowJobs` was off, or the sync stopped early — would
 * otherwise drag the average towards zero and make the next sync predict too
 * little.
 */
export function jobsPerWorkflowRun(
  db: Database,
  host: string,
  repoFullName: string,
): number | null {
  return ratio(
    db,
    `SELECT COUNT(DISTINCT run_id) AS parents, COUNT(*) AS children
       FROM gh_workflow_jobs
      WHERE host = ? AND repo_full_name = ?`,
    [host, repoFullName],
  );
}

/** How many boards this project had last time, so the per board calls can be priced. */
export function boardCount(db: Database, site: string, projectKey: string): number | null {
  const row = db.get<{ total: number }>(
    'SELECT COUNT(*) AS total FROM jira_boards WHERE site = ? AND project_key = ?',
    [site, projectKey],
  );
  return row && row.total > 0 ? row.total : null;
}

/**
 * Sprints per board, over the boards of this project.
 *
 * Boards with no sprints are real — a kanban board has none — so they are part
 * of the sample rather than filtered out of it.
 */
export function sprintsPerBoard(db: Database, site: string, projectKey: string): number | null {
  return ratio(
    db,
    `SELECT (SELECT COUNT(*) FROM jira_boards
              WHERE site = ? AND project_key = ?) AS parents,
            (SELECT COUNT(*) FROM jira_sprints
              WHERE site = ?
                AND board_id IN (SELECT id FROM jira_boards
                                  WHERE site = ? AND project_key = ?)) AS children`,
    [site, projectKey, site, site, projectKey],
  );
}
