import type { JiraProjectTarget } from '../../config/types.js';
import type { SyncMode } from '../../db/journal.js';
import type { SyncContext, TargetSyncResult } from '../../sync/types.js';
import { errorMessage } from '../../util/errors.js';
import { arr, num, str } from '../../util/json.js';
import type { JsonObject } from '../../util/json.js';
import { nowIso } from '../../util/time.js';
import { JiraClient } from './client.js';
import * as map from './map.js';
import type { JiraContext, Row } from './map.js';

interface OperationStats {
  items: number;
  cursor: string | null;
}

/** Syncs one Jira project into the database. */
export async function syncJiraProject(
  target: JiraProjectTarget,
  ctx: SyncContext,
): Promise<TargetSyncResult> {
  const client = new JiraClient({
    site: target.site,
    settings: ctx.config.sync,
    progress: ctx.progress,
    logger: ctx.logger,
  });

  const targetName = `${target.site.name}/${target.projectKey}`;
  const scopePrefix = `jira:${targetName}`;
  const hasCursor = ctx.journal.getState(`${scopePrefix}:workitems`) !== undefined;
  const mode: SyncMode = ctx.full || !hasCursor ? 'initial' : 'incremental';

  const runId = ctx.journal.startRun({
    projectKey: ctx.projectKey,
    source: 'jira',
    target: targetName,
    mode,
  });

  const callsAtStart = ctx.progress.apiCallCount;
  const itemsAtStart = ctx.progress.itemCount;
  const syncer = new JiraProjectSyncer(client, target, ctx, runId, mode, scopePrefix, targetName);

  try {
    await syncer.run();
    const result: TargetSyncResult = {
      runId,
      source: 'jira',
      target: targetName,
      mode,
      status: 'completed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      items: ctx.progress.itemCount - itemsAtStart,
    };
    ctx.journal.finishRun(runId, {
      status: 'completed',
      apiCalls: result.apiCalls,
      apiCallsExpected: ctx.progress.expectedApiCallCount,
      itemsSynced: result.items,
      details: syncer.summary,
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    ctx.journal.finishRun(runId, {
      status: 'failed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      apiCallsExpected: ctx.progress.expectedApiCallCount,
      itemsSynced: ctx.progress.itemCount - itemsAtStart,
      error: message,
      details: syncer.summary,
    });
    return {
      runId,
      source: 'jira',
      target: targetName,
      mode,
      status: 'failed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      items: ctx.progress.itemCount - itemsAtStart,
      error: message,
    };
  }
}

class JiraProjectSyncer {
  readonly summary: Record<string, number> = {};
  private readonly jiraCtx: JiraContext;

  constructor(
    private readonly client: JiraClient,
    private readonly target: JiraProjectTarget,
    private readonly ctx: SyncContext,
    private readonly runId: number,
    private readonly mode: SyncMode,
    private readonly scopePrefix: string,
    private readonly targetName: string,
  ) {
    this.jiraCtx = {
      site: target.site.name,
      projectKey: target.projectKey,
      baseUrl: target.site.baseUrl,
      fields: target.fields,
    };
  }

  async run(): Promise<void> {
    const { sync } = this.target;

    this.ctx.progress.setPhase(`${this.targetName}: project`);
    this.ctx.progress.expect(2);
    await this.syncProject();
    await this.syncFields();

    if (sync.workitems) await this.operation('workitems', () => this.syncWorkitems());
    if (sync.boards || sync.sprints) await this.operation('sprints', () => this.syncSprints());
  }

  private async operation(resource: string, fn: () => Promise<OperationStats>): Promise<void> {
    const scope = `${this.scopePrefix}:${resource}`;
    const cursorBefore = this.ctx.journal.getCursor(scope);
    const operationId = this.ctx.journal.startOperation({
      runId: this.runId,
      resource,
      scope,
      cursorBefore,
    });
    const callsBefore = this.ctx.progress.apiCallCount;
    this.ctx.progress.setPhase(`${this.targetName}: ${resource}`);

    try {
      const stats = await fn();
      this.summary[resource] = stats.items;
      this.ctx.journal.finishOperation(operationId, {
        status: 'completed',
        apiCalls: this.ctx.progress.apiCallCount - callsBefore,
        itemsSynced: stats.items,
        cursorAfter: stats.cursor ?? cursorBefore,
      });
      if (!this.ctx.dryRun) {
        this.ctx.journal.setState({
          scope,
          source: 'jira',
          target: this.targetName,
          resource,
          cursor: stats.cursor ?? cursorBefore,
          runId: this.runId,
          fullSync: this.mode === 'initial',
        });
      }
    } catch (error) {
      this.ctx.journal.finishOperation(operationId, {
        status: 'failed',
        apiCalls: this.ctx.progress.apiCallCount - callsBefore,
        itemsSynced: 0,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  private write(table: string, row: Row | null): void {
    if (!row || this.ctx.dryRun) return;
    this.ctx.db.upsert(table, row);
  }

  private async syncProject(): Promise<void> {
    const raw = await this.client.project(this.target.projectKey);
    this.write('jira_projects', map.mapProject(raw, this.jiraCtx.site, nowIso()));
    this.ctx.progress.recordItems();
  }

  private async syncFields(): Promise<void> {
    const fields = await this.client.fields();
    const syncedAt = nowIso();
    for (const field of fields) {
      this.write(
        'jira_fields',
        map.mapField(field, this.jiraCtx.site, this.target.fields, syncedAt),
      );
    }
    this.ctx.progress.recordItems(fields.length);
  }

  /** Builds the JQL used to select the work items that should be synced. */
  buildJql(since: string | null): string {
    const parts = [`project = "${this.target.projectKey}"`];
    if (this.target.filter) parts.push(`(${this.target.filter})`);
    if (since) parts.push(`updated >= "${toJqlTimestamp(since)}"`);
    return `${parts.join(' AND ')} ORDER BY updated ASC`;
  }

  private async syncWorkitems(): Promise<OperationStats> {
    const scope = `${this.scopePrefix}:workitems`;
    const since = this.resolveSince(scope);
    const jql = this.buildJql(since);
    const { sync } = this.target;

    this.ctx.progress.log(`JQL: ${jql}`);
    this.ctx.progress.expect(1);
    const total = await this.client.count(jql);
    const pageSize = this.ctx.config.sync.pageSize;
    if (total !== null) {
      // Pages plus the follow up calls that are needed per work item.
      const perItem = (sync.comments ? 1 : 0) + (sync.changelog ? 1 : 0) + (sync.worklogs ? 1 : 0);
      this.ctx.progress.expect(Math.ceil(total / pageSize) + total * perItem);
      this.ctx.progress.log(`${total} work item(s) match in ${this.target.projectKey}.`);
    }

    let items = 0;
    let newestUpdate = since;
    let nextPageToken: string | null = null;
    let startAt = 0;

    for (;;) {
      const page = await this.client.search({
        jql,
        maxResults: pageSize,
        fields: ['*all'],
        expand: ['changelog', 'renderedFields'],
        nextPageToken,
        startAt,
      });

      for (const raw of page.issues) {
        const id = str(raw, 'id') ?? '';
        const key = str(raw, 'key') ?? '';
        const workitem = { id, key };
        const syncedAt = nowIso();

        this.write('jira_workitems', map.mapWorkitem(raw, this.jiraCtx, syncedAt));
        for (const row of map.workitemLabelRows(raw, this.jiraCtx)) {
          this.write('jira_workitem_labels', row);
        }
        if (sync.links) {
          for (const row of map.mapLinks(raw, this.jiraCtx, workitem, syncedAt)) {
            this.write('jira_links', row);
          }
        }
        if (sync.attachments) {
          for (const row of map.mapAttachments(raw, this.jiraCtx, workitem, syncedAt)) {
            this.write('jira_attachments', row);
          }
        }
        if (sync.comments) await this.syncComments(raw, workitem);
        if (sync.changelog) await this.syncChangelog(raw, workitem);
        if (sync.worklogs) await this.syncWorklogs(workitem);

        const updatedAt = str(raw, 'fields', 'updated');
        if (updatedAt) {
          const iso = new Date(updatedAt).toISOString();
          if (!newestUpdate || iso > newestUpdate) newestUpdate = iso;
        }
        items += 1;
        this.ctx.progress.recordItems();
      }

      if (page.isLast || page.issues.length === 0) break;
      nextPageToken = page.nextPageToken;
      startAt = page.startAt;
      if (nextPageToken === null && startAt === 0) break;
    }

    return { items, cursor: newestUpdate ?? nowIso() };
  }

  /** Uses the comments embedded in the search response when they are complete. */
  private async syncComments(
    raw: JsonObject,
    workitem: { id: string; key: string },
  ): Promise<void> {
    const embedded = (raw['fields'] as JsonObject | undefined)?.['comment'];
    const embeddedComments = arr(embedded, 'comments') as JsonObject[];
    const total = num(embedded, 'total');

    const comments =
      total !== null && embeddedComments.length >= total
        ? embeddedComments
        : await this.client.comments(workitem.key);

    const syncedAt = nowIso();
    for (const comment of comments) {
      this.write('jira_comments', map.mapComment(comment, this.jiraCtx, workitem, syncedAt));
    }
  }

  /** The search expand carries the first page of the history only. */
  private async syncChangelog(
    raw: JsonObject,
    workitem: { id: string; key: string },
  ): Promise<void> {
    const embedded = raw['changelog'];
    const histories = arr(embedded, 'histories') as JsonObject[];
    const total = num(embedded, 'total');

    const entries =
      total !== null && histories.length >= total
        ? histories
        : await this.client.changelog(workitem.key);

    const syncedAt = nowIso();
    for (const entry of entries) {
      for (const row of map.mapChangelogEntry(entry, this.jiraCtx, workitem, syncedAt)) {
        this.write('jira_changelog', row);
      }
    }
  }

  private async syncWorklogs(workitem: { id: string; key: string }): Promise<void> {
    const worklogs = await this.client.worklogs(workitem.key);
    const syncedAt = nowIso();
    for (const worklog of worklogs) {
      this.write('jira_worklogs', map.mapWorklog(worklog, this.jiraCtx, workitem, syncedAt));
    }
  }

  /** Boards and sprints of the project, including the sprint membership. */
  private async syncSprints(): Promise<OperationStats> {
    const syncedAt = nowIso();
    let items = 0;

    let boards: JsonObject[];
    if (this.target.boardIds.length > 0) {
      boards = this.target.boardIds.map((id) => ({ id, name: `board-${id}` }));
    } else {
      this.ctx.progress.expect(1);
      boards = await this.client.boards(this.target.projectKey);
    }

    this.ctx.progress.expect(boards.length);

    for (const board of boards) {
      const boardId = num(board, 'id') ?? 0;
      if (boardId === 0) continue;
      this.write(
        'jira_boards',
        map.mapBoard(board, this.jiraCtx.site, this.target.projectKey, syncedAt),
      );
      items += 1;

      if (!this.target.sync.sprints) continue;

      const sprints = await this.client.sprints(boardId);
      this.ctx.progress.expect(sprints.length);

      for (const sprint of sprints) {
        const sprintId = num(sprint, 'id') ?? 0;
        this.write('jira_sprints', map.mapSprint(sprint, this.jiraCtx.site, boardId, syncedAt));
        items += 1;
        this.ctx.progress.recordItems();

        const members = await this.client.sprintIssueKeys(sprintId);
        for (const member of members) {
          this.write('jira_sprint_workitems', {
            site: this.jiraCtx.site,
            sprint_id: sprintId,
            workitem_id: member.id,
            workitem_key: member.key,
          });
        }
      }
    }

    return { items, cursor: syncedAt };
  }

  private resolveSince(scope: string): string | null {
    if (this.ctx.full) return this.target.since;
    const cursor = this.ctx.journal.getCursor(scope);
    // JQL only understands minutes and evaluates the timestamp in the time zone
    // of the Jira user, so the cursor is rewound a little. Re-fetched work items
    // are simply written again.
    return cursor ? withOverlap(cursor) : this.target.since;
  }
}

/** Rewinds a cursor by `minutes` so nothing falls through at the boundary. */
export function withOverlap(iso: string, minutes = 5): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Date(date.getTime() - minutes * 60_000).toISOString();
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** JQL wants `yyyy/MM/dd HH:mm` (or `yyyy-MM-dd HH:mm`) instead of ISO 8601. */
export function toJqlTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}
