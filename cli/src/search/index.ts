import type { Database } from '../db/database.js';
import { parseJsonColumn } from '../db/database.js';
import { toLikePattern, toMatchQuery } from './query.js';

export interface SearchHit {
  ref: string;
  kind: 'issue' | 'pull-request' | 'workitem';
  source: 'github' | 'jira';
  container: string;
  state: string | null;
  title: string | null;
  updatedAt: string | null;
  url: string | null;
  /** The matching text with the query terms marked, when the index built it. */
  snippet: string | null;
  /** Lower is better; `null` when the result came from the fallback scan. */
  score: number | null;
}

export interface SearchOptions {
  kinds?: Array<SearchHit['kind']> | undefined;
  containers?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /** Treat the last word as a prefix so results appear while typing. */
  prefix?: boolean | undefined;
}

export interface SearchIndexStats {
  rows: number;
  issues: number;
  pullRequests: number;
  workitems: number;
}

/** Whether this SQLite build has FTS5, so the index table could be created. */
export function searchIndexAvailable(db: Database): boolean {
  return db.tableExists('search_index');
}

/**
 * Whether searching should go through the index.
 *
 * An empty index is treated as unusable on purpose: a database that was synced
 * before the index existed has the rows but not the entries, and answering
 * "nothing found" there would be wrong. Scanning covers it until the next sync
 * fills the index in.
 */
export function searchIndexUsable(db: Database): boolean {
  if (!searchIndexAvailable(db)) return false;
  // `LIMIT 1` rather than a count: this runs on every search, and counting an
  // FTS table walks all of it, which would make each query cost O(corpus).
  return db.get('SELECT 1 AS present FROM search_index LIMIT 1') !== undefined;
}

export interface BuildOptions {
  /**
   * Only reindex items written at or after this timestamp — the start of a
   * sync run. Omit for a full rebuild.
   */
  since?: string | undefined;
}

/**
 * Builds the index from the rows already in the database.
 *
 * With `since` it touches only what the last sync wrote, which is what makes an
 * incremental sync of three changed issues stay fast on a repository of a
 * hundred thousand. An item counts as changed when its own row was written *or*
 * one of its comments or reviews was, because those are indexed with it.
 *
 * Without `since` it rebuilds everything, which is the honest thing to do after
 * a full sync and is what `devcontext search --rebuild` runs: nothing survives
 * it, so a deleted item cannot leave a stale entry behind.
 */
export function buildSearchIndex(db: Database, options: BuildOptions = {}): SearchIndexStats {
  if (!searchIndexAvailable(db)) {
    return { rows: 0, issues: 0, pullRequests: 0, workitems: 0 };
  }

  const { since } = options;

  return db.transaction(() => {
    if (since === undefined) db.run('DELETE FROM search_index');

    const issues = indexGithubIssues(db, since);
    const pullRequests = indexPullRequests(db, since);
    const workitems = indexWorkitems(db, since);

    return {
      rows: issues + pullRequests + workitems,
      issues,
      pullRequests,
      workitems,
    };
  });
}

/** Removes the entries an incremental pass is about to rewrite. */
function clearRefs(db: Database, kind: string, refs: string[]): void {
  for (let start = 0; start < refs.length; start += 400) {
    const batch = refs.slice(start, start + 400);
    db.run(
      `DELETE FROM search_index WHERE kind = ? AND ref IN (${batch.map(() => '?').join(', ')})`,
      [kind, ...batch],
    );
  }
}

interface IndexRow {
  ref: string;
  kind: string;
  source: string;
  container: string;
  state: string;
  updated_at: string;
  url: string;
  title: string;
  body: string;
  comments: string;
  people: string;
  labels: string;
}

function insert(db: Database, row: IndexRow): void {
  db.run(
    `INSERT INTO search_index
       (ref, title, body, comments, people, labels, kind, source, container, state, updated_at, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.ref,
      row.title,
      row.body,
      row.comments,
      row.people,
      row.labels,
      row.kind,
      row.source,
      row.container,
      row.state,
      row.updated_at,
      row.url,
    ],
  );
}

function joinLabels(value: unknown): string {
  return parseJsonColumn<string[]>(value, []).join(' ');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Groups child rows (comments, reviews) by the item they belong to.
 *
 * `ids` restricts the read to the items actually being indexed. Without it an
 * incremental pass over three issues would still pull every comment in the
 * database into memory, which is most of what a rebuild costs.
 */
function groupByParent<Id extends number | string>(
  db: Database,
  sql: string,
  ids: Id[] | null,
  parentColumn: string,
): Map<Id, string> {
  const map = new Map<Id, string>();
  if (ids !== null && ids.length === 0) return map;

  const batches: Array<{ sql: string; params: Array<number | string> }> =
    ids === null
      ? [{ sql, params: [] }]
      : chunk(ids, 400).map((batch) => ({
          sql: `${sql} AND ${parentColumn} IN (${batch.map(() => '?').join(', ')})`,
          params: batch,
        }));

  for (const batch of batches) {
    for (const row of db.all<{ parent: Id | null; text: string | null }>(batch.sql, batch.params)) {
      if (row.parent === null) continue;
      map.set(row.parent, `${map.get(row.parent) ?? ''}\n${row.text ?? ''}`);
    }
  }
  return map;
}

function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    batches.push(values.slice(start, start + size));
  }
  return batches;
}

const GH_COMMENTS_SQL = `SELECT issue_id AS parent, body AS text FROM gh_comments
   WHERE body IS NOT NULL AND body != ''`;

/**
 * `WHERE` for an incremental pass: the item itself changed, or something that
 * is indexed *with* it did.
 */
function changedSince(
  since: string | undefined,
  childClauses: string[],
): { clause: string | null; params: string[] } {
  if (since === undefined) return { clause: null, params: [] };
  const clauses = ['synced_at >= ?', ...childClauses];
  return { clause: `(${clauses.join(' OR ')})`, params: clauses.map(() => since) };
}

/** Joins the fixed conditions of a query with the optional incremental one. */
function whereClause(fixed: string[], incremental: string | null): string {
  const all = incremental === null ? fixed : [...fixed, incremental];
  return all.length > 0 ? ` WHERE ${all.join(' AND ')}` : '';
}

function indexGithubIssues(db: Database, since?: string): number {
  const changed = changedSince(since, [
    'id IN (SELECT issue_id FROM gh_comments WHERE synced_at >= ?)',
  ]);

  const rows = db.all<Record<string, unknown>>(
    `SELECT id, repo_full_name, number, title, body, state, author, assignees, labels,
            updated_at, html_url
       FROM gh_issues${whereClause(['is_pull_request = 0'], changed.clause)}`,
    changed.params,
  );
  if (rows.length === 0) return 0;

  if (since !== undefined) {
    clearRefs(
      db,
      'issue',
      rows.map((row) => `${text(row['repo_full_name'])}#${String(row['number'])}`),
    );
  }

  const ids = since === undefined ? null : rows.map((row) => Number(row['id']));
  const comments = groupByParent<number>(db, GH_COMMENTS_SQL, ids, 'issue_id');

  for (const row of rows) {
    insert(db, {
      ref: `${text(row['repo_full_name'])}#${String(row['number'])}`,
      kind: 'issue',
      source: 'github',
      container: text(row['repo_full_name']),
      state: text(row['state']),
      updated_at: text(row['updated_at']),
      url: text(row['html_url']),
      title: text(row['title']),
      body: text(row['body']),
      comments: comments.get(Number(row['id'])) ?? '',
      people: [text(row['author']), joinLabels(row['assignees'])].join(' ').trim(),
      labels: joinLabels(row['labels']),
    });
  }
  return rows.length;
}

function indexPullRequests(db: Database, since?: string): number {
  const changed = changedSince(since, [
    'id IN (SELECT pr_id FROM gh_reviews WHERE synced_at >= ?)',
    'id IN (SELECT issue_id FROM gh_comments WHERE synced_at >= ?)',
  ]);

  const rows = db.all<Record<string, unknown>>(
    `SELECT id, repo_full_name, number, title, body, state, merged, author, assignees, labels,
            head_ref, base_ref, updated_at, html_url
       FROM gh_pull_requests${whereClause([], changed.clause)}`,
    changed.params,
  );
  if (rows.length === 0) return 0;

  if (since !== undefined) {
    clearRefs(
      db,
      'pull-request',
      rows.map((row) => `${text(row['repo_full_name'])}#${String(row['number'])}`),
    );
  }

  const ids = since === undefined ? null : rows.map((row) => Number(row['id']));
  const comments = groupByParent<number>(db, GH_COMMENTS_SQL, ids, 'issue_id');
  const reviews = groupByParent<number>(
    db,
    `SELECT pr_id AS parent, COALESCE(author, '') || ' ' || COALESCE(body, '') AS text
       FROM gh_reviews WHERE 1 = 1`,
    ids,
    'pr_id',
  );

  for (const row of rows) {
    const id = Number(row['id']);
    insert(db, {
      ref: `${text(row['repo_full_name'])}#${String(row['number'])}`,
      kind: 'pull-request',
      source: 'github',
      container: text(row['repo_full_name']),
      state: row['merged'] === 1 ? 'merged' : text(row['state']),
      updated_at: text(row['updated_at']),
      url: text(row['html_url']),
      title: text(row['title']),
      // The branch names belong with the body: people search for them.
      body: [text(row['body']), text(row['head_ref']), text(row['base_ref'])].join('\n'),
      comments: `${comments.get(id) ?? ''}\n${reviews.get(id) ?? ''}`.trim(),
      people: [text(row['author']), joinLabels(row['assignees'])].join(' ').trim(),
      labels: joinLabels(row['labels']),
    });
  }
  return rows.length;
}

function indexWorkitems(db: Database, since?: string): number {
  const changed = changedSince(since, [
    'id IN (SELECT workitem_id FROM jira_comments WHERE synced_at >= ?)',
  ]);

  const rows = db.all<Record<string, unknown>>(
    `SELECT id, key, project_key, summary, description, status, type, assignee, reporter,
            labels, components, updated_at, url
       FROM jira_workitems${whereClause([], changed.clause)}`,
    changed.params,
  );
  if (rows.length === 0) return 0;

  if (since !== undefined) {
    clearRefs(
      db,
      'workitem',
      rows.map((row) => text(row['key'])),
    );
  }

  const comments = groupByParent<string>(
    db,
    `SELECT workitem_id AS parent, body AS text FROM jira_comments
       WHERE body IS NOT NULL AND body != ''`,
    since === undefined ? null : rows.map((row) => text(row['id'])),
    'workitem_id',
  );

  for (const row of rows) {
    insert(db, {
      ref: text(row['key']),
      kind: 'workitem',
      source: 'jira',
      container: text(row['project_key']),
      state: text(row['status']),
      updated_at: text(row['updated_at']),
      url: text(row['url']),
      title: text(row['summary']),
      body: text(row['description']),
      comments: comments.get(text(row['id'])) ?? '',
      people: [text(row['assignee']), text(row['reporter'])].join(' ').trim(),
      labels: [joinLabels(row['labels']), joinLabels(row['components']), text(row['type'])]
        .join(' ')
        .trim(),
    });
  }
  return rows.length;
}

/*
 * A title hit should always beat a hit buried in the twentieth comment, so the
 * columns carry different weights. bm25() assigns them by column position, so
 * this list has to stay in the order the table declares: ref, title, body,
 * comments, people, labels. The UNINDEXED columns after those contribute
 * nothing and are left at the default.
 */
export const WEIGHTS = '12.0, 10.0, 2.0, 1.0, 3.0, 3.0';

interface HitRow {
  ref: string;
  kind: string;
  source: string;
  container: string;
  state: string;
  updated_at: string;
  url: string;
  title: string;
  snippet: string | null;
  score: number;
}

/** One search across issues, pull requests and work items. */
export function searchAll(db: Database, query: string, options: SearchOptions = {}): SearchHit[] {
  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;

  if (!searchIndexUsable(db)) return fallbackSearch(db, query, options);

  const match = toMatchQuery(query, { prefixLast: options.prefix ?? true });
  if (match === null) return [];

  const clauses: string[] = ['search_index MATCH ?'];
  const params: Array<string | number> = [match];

  if (options.kinds?.length) {
    clauses.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
    params.push(...options.kinds);
  }
  if (options.containers?.length) {
    clauses.push(`container IN (${options.containers.map(() => '?').join(', ')})`);
    params.push(...options.containers);
  }

  let rows: HitRow[];
  try {
    rows = db.all<HitRow>(
      `SELECT ref, kind, source, container, state, updated_at, url, title,
              snippet(search_index, -1, '[', ']', '…', 24) AS snippet,
              bm25(search_index, ${WEIGHTS}) AS score
         FROM search_index
        WHERE ${clauses.join(' AND ')}
        ORDER BY score
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  } catch {
    // A query FTS5 still refuses (an unbalanced quote, say) should return
    // something useful rather than an error the user cannot act on.
    return fallbackSearch(db, query, options);
  }

  return rows.map((row) => ({
    ref: row.ref,
    kind: row.kind as SearchHit['kind'],
    source: row.source as SearchHit['source'],
    container: row.container,
    state: row.state || null,
    title: row.title || null,
    updatedAt: row.updated_at || null,
    url: row.url || null,
    snippet: row.snippet,
    score: row.score,
  }));
}

/**
 * Scans the tables directly. Only reached when SQLite was built without FTS5
 * or before the first sync has built the index.
 */
function fallbackSearch(db: Database, query: string, options: SearchOptions): SearchHit[] {
  const pattern = toLikePattern(query);
  if (pattern === '%%') return [];

  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;
  const kinds = new Set(options.kinds ?? ['issue', 'pull-request', 'workitem']);
  const containers = options.containers?.length ? new Set(options.containers) : null;

  const hits: SearchHit[] = [];

  const push = (hit: SearchHit): void => {
    if (!kinds.has(hit.kind)) return;
    if (containers && !containers.has(hit.container)) return;
    hits.push(hit);
  };

  // Issues and pull requests are read from their own tables, mirroring how the
  // index is built: a pull request is also a row in `gh_issues`, so scanning
  // that table alone would either miss them or list them twice.
  if (kinds.has('issue')) {
    for (const row of db.all<Record<string, unknown>>(
      `SELECT repo_full_name, number, title, state, updated_at, html_url
         FROM gh_issues
        WHERE is_pull_request = 0
          AND (LOWER(COALESCE(title, '')) LIKE ?
            OR LOWER(COALESCE(body, '')) LIKE ?
            OR id IN (SELECT issue_id FROM gh_comments WHERE LOWER(COALESCE(body, '')) LIKE ?))
        ORDER BY updated_at DESC`,
      [pattern, pattern, pattern],
    )) {
      push({
        ref: `${text(row['repo_full_name'])}#${String(row['number'])}`,
        kind: 'issue',
        source: 'github',
        container: text(row['repo_full_name']),
        state: text(row['state']) || null,
        title: text(row['title']) || null,
        updatedAt: text(row['updated_at']) || null,
        url: text(row['html_url']) || null,
        snippet: null,
        score: null,
      });
    }
  }

  if (kinds.has('pull-request')) {
    for (const row of db.all<Record<string, unknown>>(
      `SELECT repo_full_name, number, title, state, merged, updated_at, html_url
         FROM gh_pull_requests
        WHERE LOWER(COALESCE(title, '')) LIKE ?
           OR LOWER(COALESCE(body, '')) LIKE ?
           OR LOWER(COALESCE(head_ref, '')) LIKE ?
           OR id IN (SELECT pr_id FROM gh_reviews WHERE LOWER(COALESCE(body, '')) LIKE ?)
        ORDER BY updated_at DESC`,
      [pattern, pattern, pattern, pattern],
    )) {
      push({
        ref: `${text(row['repo_full_name'])}#${String(row['number'])}`,
        kind: 'pull-request',
        source: 'github',
        container: text(row['repo_full_name']),
        state: row['merged'] === 1 ? 'merged' : text(row['state']) || null,
        title: text(row['title']) || null,
        updatedAt: text(row['updated_at']) || null,
        url: text(row['html_url']) || null,
        snippet: null,
        score: null,
      });
    }
  }

  if (kinds.has('workitem')) {
    for (const row of db.all<Record<string, unknown>>(
      `SELECT key, project_key, summary, status, updated_at, url
         FROM jira_workitems
        WHERE LOWER(key) LIKE ?
           OR LOWER(COALESCE(summary, '')) LIKE ?
           OR LOWER(COALESCE(description, '')) LIKE ?
           OR id IN (SELECT workitem_id FROM jira_comments WHERE LOWER(COALESCE(body, '')) LIKE ?)
        ORDER BY updated_at DESC`,
      [pattern, pattern, pattern, pattern],
    )) {
      push({
        ref: text(row['key']),
        kind: 'workitem',
        source: 'jira',
        container: text(row['project_key']),
        state: text(row['status']) || null,
        title: text(row['summary']) || null,
        updatedAt: text(row['updated_at']) || null,
        url: text(row['url']) || null,
        snippet: null,
        score: null,
      });
    }
  }

  return hits
    .toSorted((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(offset, offset + limit);
}
