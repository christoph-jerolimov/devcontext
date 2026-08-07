import type { Database } from '../database.js';
import { searchIndexUsable, WEIGHTS } from '../../search/index.js';
import { toMatchQuery } from '../../search/query.js';
import { limitClause, orderClause, WhereBuilder } from './filters.js';
import type { PagingOptions } from './filters.js';

export interface WorkitemRow {
  site: string;
  id: string;
  key: string;
  project_key: string;
  summary: string | null;
  description: string | null;
  type: string | null;
  status: string | null;
  status_category: string | null;
  resolution: string | null;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  parent_key: string | null;
  epic_key: string | null;
  story_points: number | null;
  sprint_id: number | null;
  sprint_name: string | null;
  labels: string | null;
  components: string | null;
  fix_versions: string | null;
  created_at: string | null;
  updated_at: string | null;
  resolved_at: string | null;
  due_date: string | null;
  url: string | null;
  custom_fields: string | null;
}

export interface JiraCommentRow {
  id: string;
  workitem_key: string;
  author: string | null;
  body: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ChangelogRow {
  uid: string;
  workitem_key: string;
  author: string | null;
  created_at: string | null;
  field: string | null;
  from_string: string | null;
  to_string: string | null;
}

export interface SprintRow {
  site: string;
  id: number;
  board_id: number | null;
  name: string | null;
  state: string | null;
  goal: string | null;
  start_date: string | null;
  end_date: string | null;
  complete_date: string | null;
  workitem_count?: number;
}

export interface JiraProjectRow {
  site: string;
  id: string;
  key: string;
  name: string | null;
  project_type: string | null;
  lead: string | null;
  workitem_count?: number;
}

export interface WorkitemFilter extends PagingOptions {
  projects?: string[] | undefined;
  sites?: string[] | undefined;
  types?: string[] | undefined;
  statuses?: string[] | undefined;
  statusCategories?: string[] | undefined;
  assignee?: string | undefined;
  reporter?: string | undefined;
  labels?: string[] | undefined;
  components?: string[] | undefined;
  sprint?: string | undefined;
  epic?: string | undefined;
  parent?: string | undefined;
  resolved?: boolean | undefined;
  search?: string | undefined;
  keys?: string[] | undefined;
  createdSince?: string | undefined;
  createdBefore?: string | undefined;
  updatedSince?: string | undefined;
  /** Only work items that have not been touched since this timestamp. */
  updatedBefore?: string | undefined;
  sort?: 'updated' | 'created' | 'key' | 'status' | undefined;
  order?: 'asc' | 'desc' | undefined;
}

function applyWorkitemFilters(where: WhereBuilder, filter: WorkitemFilter): WhereBuilder {
  where.addIn(
    'project_key',
    filter.projects?.map((value) => value.toUpperCase()),
  );
  where.addIn('site', filter.sites);
  where.addIn(
    'key',
    filter.keys?.map((value) => value.toUpperCase()),
  );
  if (filter.types && filter.types.length > 0) {
    const placeholders = filter.types.map(() => '?').join(', ');
    where.add(
      `LOWER(type) IN (${placeholders})`,
      ...filter.types.map((value) => value.toLowerCase()),
    );
  }
  if (filter.statuses && filter.statuses.length > 0) {
    const placeholders = filter.statuses.map(() => '?').join(', ');
    where.add(
      `LOWER(status) IN (${placeholders})`,
      ...filter.statuses.map((value) => value.toLowerCase()),
    );
  }
  if (filter.statusCategories && filter.statusCategories.length > 0) {
    const placeholders = filter.statusCategories.map(() => '?').join(', ');
    where.add(
      `LOWER(status_category) IN (${placeholders})`,
      ...filter.statusCategories.map((value) => value.toLowerCase()),
    );
  }
  where.addIf(filter.assignee, 'LOWER(assignee) LIKE ?', `%${filter.assignee?.toLowerCase()}%`);
  where.addIf(filter.reporter, 'LOWER(reporter) LIKE ?', `%${filter.reporter?.toLowerCase()}%`);
  where.addIf(filter.epic, 'epic_key = ?', filter.epic?.toUpperCase());
  where.addIf(filter.parent, 'parent_key = ?', filter.parent?.toUpperCase());
  where.addIf(filter.sprint, 'LOWER(sprint_name) LIKE ?', `%${filter.sprint?.toLowerCase()}%`);
  where.addIf(filter.createdSince, 'created_at >= ?', filter.createdSince);
  where.addIf(filter.createdBefore, 'created_at < ?', filter.createdBefore);
  where.addIf(filter.updatedSince, 'updated_at >= ?', filter.updatedSince);
  where.addIf(filter.updatedBefore, 'updated_at < ?', filter.updatedBefore);
  if (filter.resolved !== undefined) {
    where.add(filter.resolved ? 'resolved_at IS NOT NULL' : 'resolved_at IS NULL');
  }
  for (const label of filter.labels ?? []) {
    where.add('LOWER(labels) LIKE ?', `%"${label.toLowerCase()}"%`);
  }
  for (const component of filter.components ?? []) {
    where.add('LOWER(components) LIKE ?', `%"${component.toLowerCase()}"%`);
  }
  where.addSearch(['summary', 'description'], filter.search);
  return where;
}

export function listWorkitems(db: Database, filter: WorkitemFilter = {}): WorkitemRow[] {
  const where = applyWorkitemFilters(new WhereBuilder(), filter);
  const paging = limitClause(filter);
  const sort = filter.sort ?? 'updated';
  const column =
    sort === 'key'
      ? 'key'
      : sort === 'status'
        ? 'status'
        : sort === 'created'
          ? 'created_at'
          : 'updated_at';
  return db.all<WorkitemRow>(
    `SELECT * FROM jira_workitems ${where.sql} ${orderClause(column, filter.order ?? 'desc', 'key')}${paging.sql}`,
    [...where.values, ...paging.params],
  );
}

export function getWorkitem(db: Database, key: string): WorkitemRow | undefined {
  return db.get<WorkitemRow>('SELECT * FROM jira_workitems WHERE key = ?', [key.toUpperCase()]);
}

/**
 * The matching work item keys, most relevant first, or `null` when there is no
 * usable index and the caller has to scan.
 *
 * More keys are fetched than the caller asked for, because the filters below
 * still remove some of them; the surplus keeps a filtered search from coming
 * back short.
 */
function rankedKeys(db: Database, query: string, filter: WorkitemFilter): string[] | null {
  if (!searchIndexUsable(db)) return null;

  const match = toMatchQuery(query);
  if (match === null) return [];

  const wanted = (filter.limit && filter.limit > 0 ? filter.limit : 50) + (filter.offset ?? 0);
  try {
    return db
      .all<{ ref: string }>(
        `SELECT ref FROM search_index
          WHERE search_index MATCH ? AND kind = 'workitem'
          ORDER BY bm25(search_index, ${WEIGHTS})
          LIMIT ?`,
        [match, wanted * 10 + 200],
      )
      .map((row) => row.ref);
  } catch {
    // FTS5 rejected the expression; the scan below still answers.
    return null;
  }
}

/**
 * Full text search across work items and their comments, most relevant first.
 *
 * It goes through the FTS index when there is one, so the cost is proportional
 * to the number of matches rather than to every description and comment in the
 * database. The scan below is the fallback for a SQLite build without FTS5, or
 * for a database that has not been synced since the index was introduced.
 */
export function searchWorkitems(
  db: Database,
  query: string,
  filter: WorkitemFilter = {},
): WorkitemRow[] {
  const paging = limitClause(filter);

  const ranked = rankedKeys(db, query, filter);
  if (ranked !== null) {
    if (ranked.length === 0) return [];

    const where = applyWorkitemFilters(new WhereBuilder(), filter);
    where.addIn('key', ranked);
    const rows = db.all<WorkitemRow>(`SELECT * FROM jira_workitems ${where.sql}`, where.values);

    // The index decided the order; the filters only removed rows from it.
    const position = new Map(ranked.map((key, index) => [key, index]));
    const sorted = rows.toSorted((a, b) => (position.get(a.key) ?? 0) - (position.get(b.key) ?? 0));
    const offset = filter.offset ?? 0;
    return filter.limit && filter.limit > 0
      ? sorted.slice(offset, offset + filter.limit)
      : sorted.slice(offset);
  }

  const where = applyWorkitemFilters(new WhereBuilder(), filter);
  const pattern = `%${query.toLowerCase()}%`;
  where.add(
    `(LOWER(key) LIKE ?
      OR LOWER(COALESCE(summary, '')) LIKE ?
      OR LOWER(COALESCE(description, '')) LIKE ?
      OR id IN (SELECT workitem_id FROM jira_comments WHERE LOWER(COALESCE(body, '')) LIKE ?))`,
    pattern,
    pattern,
    pattern,
    pattern,
  );
  return db.all<WorkitemRow>(
    `SELECT * FROM jira_workitems ${where.sql}
      ORDER BY
        CASE
          WHEN LOWER(key) LIKE ? THEN 0
          WHEN LOWER(COALESCE(summary, '')) LIKE ? THEN 1
          ELSE 2
        END,
        updated_at DESC${paging.sql}`,
    [...where.values, pattern, pattern, ...paging.params],
  );
}

export function listJiraComments(db: Database, workitemKey: string): JiraCommentRow[] {
  return db.all<JiraCommentRow>(
    `SELECT * FROM jira_comments WHERE workitem_key = ? ORDER BY created_at ASC, id ASC`,
    [workitemKey.toUpperCase()],
  );
}

export function listChangelog(db: Database, workitemKey: string): ChangelogRow[] {
  return db.all<ChangelogRow>(
    `SELECT * FROM jira_changelog WHERE workitem_key = ? ORDER BY created_at ASC, uid ASC`,
    [workitemKey.toUpperCase()],
  );
}

export function listLinks(
  db: Database,
  workitemKey: string,
): Array<{
  type: string | null;
  direction: string;
  related_key: string | null;
  related_summary: string | null;
}> {
  return db.all(
    `SELECT type, direction, related_key, related_summary
       FROM jira_links WHERE workitem_key = ? ORDER BY direction, related_key`,
    [workitemKey.toUpperCase()],
  );
}

export function listSprints(
  db: Database,
  options: {
    sites?: string[] | undefined;
    boardIds?: number[] | undefined;
    states?: string[] | undefined;
    search?: string | undefined;
  } & PagingOptions = {},
): SprintRow[] {
  const where = new WhereBuilder().addIn('s.site', options.sites);
  if (options.states && options.states.length > 0) {
    const placeholders = options.states.map(() => '?').join(', ');
    where.add(
      `LOWER(s.state) IN (${placeholders})`,
      ...options.states.map((value) => value.toLowerCase()),
    );
  }
  if (options.boardIds && options.boardIds.length > 0) {
    where.add(`s.board_id IN (${options.boardIds.map(() => '?').join(', ')})`, ...options.boardIds);
  }
  where.addSearch(['s.name', 's.goal'], options.search);
  const paging = limitClause(options);

  return db.all<SprintRow>(
    `SELECT s.*,
            (SELECT COUNT(*) FROM jira_sprint_workitems m
              WHERE m.site = s.site AND m.sprint_id = s.id) AS workitem_count
       FROM jira_sprints s
       ${where.sql}
      ORDER BY COALESCE(s.start_date, s.complete_date, '') DESC, s.id DESC${paging.sql}`,
    [...where.values, ...paging.params],
  );
}

export function listSprintWorkitems(db: Database, sprintId: number): WorkitemRow[] {
  return db.all<WorkitemRow>(
    `SELECT w.* FROM jira_workitems w
       JOIN jira_sprint_workitems m ON m.site = w.site AND m.workitem_id = w.id
      WHERE m.sprint_id = ?
      ORDER BY w.key`,
    [sprintId],
  );
}

export function listJiraProjects(db: Database): JiraProjectRow[] {
  return db.all<JiraProjectRow>(
    `SELECT p.*,
            (SELECT COUNT(*) FROM jira_workitems w
              WHERE w.site = p.site AND w.project_key = p.key) AS workitem_count
       FROM jira_projects p
      ORDER BY p.key`,
  );
}

export function listJiraFields(
  db: Database,
  options: { onlyMapped?: boolean; search?: string | undefined } = {},
): Array<{
  site: string;
  id: string;
  name: string | null;
  mapped_name: string | null;
  custom: number;
  schema_type: string | null;
}> {
  const where = new WhereBuilder();
  if (options.onlyMapped) where.add('mapped_name IS NOT NULL');
  where.addSearch(['id', 'name', 'mapped_name'], options.search);
  return db.all(`SELECT * FROM jira_fields ${where.sql} ORDER BY custom DESC, name`, where.values);
}

export function jiraStats(db: Database): Record<string, number> {
  return {
    projects: db.count('jira_projects'),
    workitems: db.count('jira_workitems'),
    openWorkitems: db.count('jira_workitems', 'resolved_at IS NULL'),
    comments: db.count('jira_comments'),
    changelogEntries: db.count('jira_changelog'),
    links: db.count('jira_links'),
    attachments: db.count('jira_attachments'),
    boards: db.count('jira_boards'),
    sprints: db.count('jira_sprints'),
  };
}
