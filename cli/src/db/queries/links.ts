import type { Database } from '../database.js';
import { limitClause, WhereBuilder } from './filters.js';
import type { PagingOptions } from './filters.js';
import type { CrossLinkRow } from '../../links/build.js';

export interface LinkFilter extends PagingOptions {
  /** Either side of the link matches this reference (`acme/platform#42`, `PLAT-7`). */
  ref?: string | undefined;
  fromSource?: string | undefined;
  toSource?: string | undefined;
  via?: string[] | undefined;
  minConfidence?: 'high' | 'medium' | undefined;
}

export function listLinks(db: Database, filter: LinkFilter = {}): CrossLinkRow[] {
  const where = new WhereBuilder();

  if (filter.ref) {
    const ref = normaliseRef(filter.ref);
    where.add('(from_ref = ? OR to_ref = ?)', ref, ref);
  }
  where.addIf(filter.fromSource, 'from_source = ?', filter.fromSource);
  where.addIf(filter.toSource, 'to_source = ?', filter.toSource);
  where.addIn('via', filter.via);
  if (filter.minConfidence === 'high') where.add("confidence = 'high'");

  const paging = limitClause(filter);
  return db.all<CrossLinkRow>(
    `SELECT * FROM cross_links ${where.sql}
      ORDER BY CASE confidence WHEN 'high' THEN 0 ELSE 1 END, from_ref, to_ref${paging.sql}`,
    [...where.values, ...paging.params],
  );
}

/** Everything linked to `ref`, in both directions, deduplicated. */
export function linksFor(
  db: Database,
  ref: string,
): Array<{ ref: string; source: string; kind: string; via: string; confidence: string }> {
  const normalised = normaliseRef(ref);
  const rows = db.all<CrossLinkRow>('SELECT * FROM cross_links WHERE from_ref = ? OR to_ref = ?', [
    normalised,
    normalised,
  ]);

  const byRef = new Map<
    string,
    { ref: string; source: string; kind: string; via: string; confidence: string }
  >();

  for (const row of rows) {
    const isFrom = row.from_ref === normalised;
    const other = {
      ref: isFrom ? row.to_ref : row.from_ref,
      source: isFrom ? row.to_source : row.from_source,
      kind: isFrom ? row.to_kind : row.from_kind,
      via: row.via,
      confidence: row.confidence,
    };
    const existing = byRef.get(other.ref);
    // Keep the strongest reason a link exists.
    if (!existing || (existing.confidence !== 'high' && other.confidence === 'high')) {
      byRef.set(other.ref, other);
    }
  }

  return [...byRef.values()].toSorted((a, b) => a.ref.localeCompare(b.ref));
}

/** Jira keys referenced by a GitHub issue or pull request. */
export function jiraKeysFor(db: Database, repo: string, number: number): string[] {
  return linksFor(db, `${repo}#${number}`)
    .filter((link) => link.source === 'jira')
    .map((link) => link.ref);
}

/** GitHub issues and pull requests referencing a work item. */
export function githubRefsFor(
  db: Database,
  key: string,
): Array<{ ref: string; kind: string; via: string }> {
  return linksFor(db, key)
    .filter((link) => link.source === 'github')
    .map((link) => ({ ref: link.ref, kind: link.kind, via: link.via }));
}

export function linkStats(db: Database): Record<string, number> {
  const rows = db.all<{ via: string; total: number }>(
    'SELECT via, COUNT(*) AS total FROM cross_links GROUP BY via ORDER BY via',
  );
  const stats: Record<string, number> = { links: db.count('cross_links') };
  for (const row of rows) stats[row.via] = row.total;
  return stats;
}

/** `plat-7` -> `PLAT-7`, `acme/platform#42` unchanged. */
export function normaliseRef(ref: string): string {
  const trimmed = ref.trim();
  return trimmed.includes('#') ? trimmed : trimmed.toUpperCase();
}
