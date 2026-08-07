import type { JiraProjectTarget } from '../../config/types.js';
import type { SyncMode } from '../../db/journal.js';
import type { SyncContext, TargetPlan, TargetSyncResult } from '../../sync/types.js';
import { CliError, errorMessage } from '../../util/errors.js';
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

/**
 * Prepares one Jira project so it can be sized before anything is synced.
 *
 * The run is not opened in the journal until `run()`, so a survey that fails
 * leaves nothing half started behind it.
 */
export function planJiraProject(target: JiraProjectTarget, ctx: SyncContext): TargetPlan {
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
  const syncer = new JiraProjectSyncer(client, target, ctx, mode, scopePrefix, targetName);

  return {
    label: targetName,
    survey: () => syncer.survey(),
    run: () => runJiraProject(ctx, syncer, mode, targetName),
  };
}

/** Syncs one Jira project into the database, sizing it first. */
export async function syncJiraProject(
  target: JiraProjectTarget,
  ctx: SyncContext,
): Promise<TargetSyncResult> {
  const plan = planJiraProject(target, ctx);
  await plan.survey();
  return plan.run();
}

async function runJiraProject(
  ctx: SyncContext,
  syncer: JiraProjectSyncer,
  mode: SyncMode,
  targetName: string,
): Promise<TargetSyncResult> {
  const runId = ctx.journal.startRun({
    projectKey: ctx.projectKey,
    source: 'jira',
    target: targetName,
    mode,
  });
  syncer.attachRun(runId);

  const callsAtStart = ctx.progress.apiCallCount;
  const itemsAtStart = ctx.progress.itemCount;

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

/** Syncs one work item immediately, without moving any cursor. */
export async function syncJiraWorkitem(
  target: JiraProjectTarget,
  ctx: SyncContext,
  key: string,
): Promise<TargetSyncResult> {
  const client = new JiraClient({
    site: target.site,
    settings: ctx.config.sync,
    progress: ctx.progress,
    logger: ctx.logger,
  });

  const targetName = `${target.site.name}/${target.projectKey}`;
  const runId = ctx.journal.startRun({
    projectKey: ctx.projectKey,
    source: 'jira',
    target: targetName,
    mode: 'targeted',
  });

  const callsAtStart = ctx.progress.apiCallCount;
  const itemsAtStart = ctx.progress.itemCount;
  const syncer = new JiraProjectSyncer(
    client,
    target,
    ctx,
    'targeted',
    `jira:${targetName}`,
    targetName,
  );
  syncer.attachRun(runId);

  const base = {
    runId,
    source: 'jira' as const,
    target: key.toUpperCase(),
    mode: 'targeted' as const,
  };

  try {
    await syncer.syncSingleWorkitem(key.toUpperCase());
    const result: TargetSyncResult = {
      ...base,
      status: 'completed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      items: ctx.progress.itemCount - itemsAtStart,
    };
    ctx.journal.finishRun(runId, {
      status: 'completed',
      apiCalls: result.apiCalls,
      apiCallsExpected: ctx.progress.expectedApiCallCount,
      itemsSynced: result.items,
      details: { key: key.toUpperCase() },
    });
    return result;
  } catch (error) {
    const message = errorMessage(error);
    ctx.journal.finishRun(runId, {
      status: 'failed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      apiCallsExpected: ctx.progress.expectedApiCallCount,
      itemsSynced: 0,
      error: message,
    });
    return {
      ...base,
      status: 'failed',
      apiCalls: ctx.progress.apiCallCount - callsAtStart,
      items: 0,
      error: message,
    };
  }
}

class JiraProjectSyncer {
  readonly summary: Record<string, number> = {};
  private readonly jiraCtx: JiraContext;
  /** What the survey counted, and for which query, so the walk can reuse it. */
  private surveyed: { jql: string; total: number | null } | null = null;

  /** Set once the journal run exists, which is after the survey. */
  private runId = 0;

  attachRun(runId: number): void {
    this.runId = runId;
  }

  constructor(
    private readonly client: JiraClient,
    private readonly target: JiraProjectTarget,
    private readonly ctx: SyncContext,
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

  /**
   * Sizes the job before doing it. Jira makes this cheap: a search reports how
   * many work items match, so one call prices the pages and every follow up
   * call each item implies.
   *
   * Boards and sprints are not counted here. Their cost depends on how many
   * boards the project has and how many sprints each board holds, which is
   * only known once the boards have been listed.
   */
  async survey(): Promise<void> {
    const { sync } = this.target;

    // The project and the field catalogue, one call each, always.
    this.ctx.progress.expectFor(`${this.scopePrefix}:project`, 2);
    // Listing the boards is one call. How many sprints hang off each, and how
    // many work items off each sprint, only the listing reveals.
    if (sync.boards || sync.sprints) this.ctx.progress.expectFor(`${this.scopePrefix}:boards`, 1);

    if (!sync.workitems) return;

    const scope = `${this.scopePrefix}:workitems`;
    const jql = this.buildJql(this.resolveSince(scope));
    const total = await this.client.count(jql);
    if (total === null) return;

    // Kept so the walk does not pay for the same count a second time.
    this.surveyed = { jql, total };
    this.ctx.progress.expectFor(scope, this.workitemCalls(total));
  }

  /** The count, for a run that skipped the survey (a targeted sync). */
  private async countForSync(jql: string, scope: string): Promise<number | null> {
    this.ctx.progress.expect(1);
    const total = await this.client.count(jql);
    if (total !== null) this.ctx.progress.expectFor(scope, this.workitemCalls(total));
    return total;
  }

  /** The count call, the pages it implies, and the follow ups per work item. */
  private workitemCalls(total: number): number {
    const { sync } = this.target;
    const perItem = (sync.comments ? 1 : 0) + (sync.changelog ? 1 : 0) + (sync.worklogs ? 1 : 0);
    return 1 + Math.max(1, Math.ceil(total / this.ctx.config.sync.pageSize)) + total * perItem;
  }

  async run(): Promise<void> {
    const { sync } = this.target;

    this.ctx.progress.setPhase(`${this.targetName}: project`);
    // Sized by the survey; a targeted run has no survey, so it seeds it here.
    this.ctx.progress.expectFor(`${this.scopePrefix}:project`, 2);
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

    this.ctx.progress.log(`JQL: ${jql}`);

    // The survey already asked, for this very JQL; asking again would cost a
    // call and could only return the same answer.
    const total =
      this.surveyed?.jql === jql ? this.surveyed.total : await this.countForSync(jql, scope);
    const pageSize = this.ctx.config.sync.pageSize;
    if (total !== null) {
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
        const updatedAt = await this.writeWorkitemPayload(raw);
        if (updatedAt && (!newestUpdate || updatedAt > newestUpdate)) newestUpdate = updatedAt;
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

  /**
   * Writes one work item with its labels, links, attachments, comments and the
   * complete history. Shared by the search walk and by a targeted sync, so both
   * store exactly the same rows.
   */
  private async writeWorkitemPayload(raw: JsonObject): Promise<string | null> {
    const { sync } = this.target;
    const workitem = { id: str(raw, 'id') ?? '', key: str(raw, 'key') ?? '' };
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
    return updatedAt ? new Date(updatedAt).toISOString() : null;
  }

  /**
   * Syncs a single work item, without touching any cursor.
   *
   * The cursor is deliberately left alone: this item may have been updated
   * after work items the regular sync has not seen yet, and moving the cursor
   * to its timestamp would skip everything in between for good. The follow up
   * sync still starts from the old cursor and writes this item again, which
   * changes nothing because every write is an upsert.
   */
  async syncSingleWorkitem(key: string): Promise<void> {
    this.ctx.progress.setPhase(key);
    this.ctx.progress.expect(2);

    const page = await this.client.search({
      jql: `key = "${key}"`,
      maxResults: 1,
      fields: ['*all'],
      expand: ['changelog', 'renderedFields'],
    });

    const [raw] = page.issues;
    if (!raw) {
      throw new CliError(`Work item ${key} was not found on ${this.target.site.baseUrl}.`, {
        hint: 'Check the key, and that the configured filter does not exclude it.',
      });
    }

    await this.writeWorkitemPayload(raw);
    this.ctx.progress.recordItems();
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

    const scope = `${this.scopePrefix}:boards`;
    let boards: JsonObject[];
    if (this.target.boardIds.length > 0) {
      boards = this.target.boardIds.map((id) => ({ id, name: `board-${id}` }));
      this.ctx.progress.expectFor(scope, 0);
    } else {
      // The survey already counted this one call; the sprint listing per board
      // is what it could not know.
      this.ctx.progress.expectFor(scope, 1);
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
