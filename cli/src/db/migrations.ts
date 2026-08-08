/**
 * Bringing an existing database up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` builds a new database correctly and does
 * nothing at all to an old one, so a column added to the schema needs an
 * explicit step here. Every step is written to be safe to run twice, because
 * the cheapest migration framework is one that does not need to remember what
 * it has already done.
 */

import type { Database } from './database.js';

/** Adds a column when it is missing, and says nothing when it is not. */
export function ensureColumn(db: Database, table: string, column: string, type: string): boolean {
  const columns = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (columns.length === 0) return false; // The table itself does not exist yet.
  if (columns.some((row) => row.name === column)) return false;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}

/**
 * Schema 4: which per-item resources have been fetched for each item.
 *
 * The backfill is the interesting half. Without it, every row in an existing
 * database has no record of its details, so the first sync after upgrading
 * would refetch the comments and timeline of every issue inside the configured
 * window — on a large repository, tens of thousands of requests nobody asked
 * for, to rebuild rows that were already correct.
 *
 * So what was fetched is inferred instead, per repository, from whether the
 * tables hold anything for it. These are repository-level settings: if any
 * issue in a repository has a stored comment then `issueComments` was on for
 * that repository, whatever any individual issue's own comment count happens
 * to be. Inferring per item would be wrong in the obvious way — an issue
 * nobody ever commented on has no comment rows and never will.
 *
 * The inference can only be too generous in one direction: a repository where
 * a resource was on but produced no rows anywhere is treated as never having
 * had it, and gets fetched once. That is the harmless direction.
 */
export function backfillDetailParts(db: Database): void {
  const repositories = db.all<{ repo_full_name: string }>(
    `SELECT DISTINCT repo_full_name FROM gh_issues`,
  );

  for (const { repo_full_name: repo } of repositories) {
    const has = (table: string): boolean =>
      (db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE repo_full_name = ? LIMIT 1`,
        [repo],
      )?.n ?? 0) > 0;

    const issueParts: string[] = [];
    if (has('gh_comments')) issueParts.push('comments');
    if (has('gh_events')) issueParts.push('timeline');

    const pullParts = [...issueParts];
    if (has('gh_reviews')) pullParts.push('reviews');
    if (has('gh_review_comments')) pullParts.push('review_comments');
    if (has('gh_commits')) pullParts.push('commits');
    // Changed files are keyed on the pull request's own id and carry no
    // repository name of their own, so this one goes through the join.
    const files =
      db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM gh_pull_request_files f
           JOIN gh_pull_requests p ON p.host = f.host AND p.id = f.pr_id
          WHERE p.repo_full_name = ? LIMIT 1`,
        [repo],
      )?.n ?? 0;
    if (files > 0) pullParts.push('files');

    /*
     * `synced_at` stands in for when the details were fetched. It is not
     * exact — it is when the row was last written — but it only has to be
     * non-null, which is what says "the details phase has run for this item".
     */
    // Pull requests live in gh_issues too, and want more resources than a
    // plain issue does, so they are stamped separately.
    db.run(
      `UPDATE gh_issues
          SET details_parts = ?, details_synced_at = synced_at
        WHERE repo_full_name = ? AND is_pull_request = 0 AND details_synced_at IS NULL`,
      [JSON.stringify(issueParts), repo],
    );
    db.run(
      `UPDATE gh_issues
          SET details_parts = ?, details_synced_at = synced_at
        WHERE repo_full_name = ? AND is_pull_request = 1 AND details_synced_at IS NULL`,
      [JSON.stringify(pullParts), repo],
    );
  }
}

/**
 * Every step needed to get from `from` to the current schema.
 *
 * Steps run in order and each is idempotent, so a database several versions
 * behind gets all of them and one already current gets none.
 */
export function migrateFrom(db: Database, from: number): void {
  if (from < 4) {
    ensureColumn(db, 'gh_issues', 'details_parts', 'TEXT');
    ensureColumn(db, 'gh_issues', 'details_synced_at', 'TEXT');
    backfillDetailParts(db);
  }
}
