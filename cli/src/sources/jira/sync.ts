import type { JiraProjectTarget } from '../../config/types.js';
import type { SyncMode } from '../../db/journal.js';
import { SYNC_PHASES } from '../../sync/types.js';
import type { SyncContext, SyncPhase, TargetPlan, TargetSyncResult } from '../../sync/types.js';
import { CliError, errorMessage } from '../../util/errors.js';
import { arr, num, str } from '../../util/json.js';
import type { JsonObject } from '../../util/json.js';
import { nowIso } from '../../util/time.js';
import { boardCount, sprintsPerBoard } from '../../sync/estimates.js';
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

  let runId = 0;

  return {
    label: targetName,
    survey: () => syncer.survey(),

    begin: () => {
      runId = ctx.journal.startRun({
        projectKey: ctx.projectKey,
        source: 'jira',
        target: targetName,
        mode,
      });
      syncer.attachRun(runId);
    },

    runPhase: (phase) => syncer.runPhase(phase),

    finish: (error) => {
      const base = {
        runId,
        source: 'jira' as const,
        target: targetName,
        mode,
        apiCalls: syncer.apiCalls,
        items: syncer.items,
      };

      if (error !== null) {
        const message = errorMessage(error);
        syncer.abandonOpenOperations(error);
        ctx.journal.finishRun(runId, {
          status: 'failed',
          apiCalls: base.apiCalls,
          apiCallsExpected: ctx.progress.expectedApiCallCount,
          itemsSynced: base.items,
          error: message,
          details: syncer.summary,
        });
        return { ...base, status: 'failed', error: message };
      }

      ctx.journal.finishRun(runId, {
        status: 'completed',
        apiCalls: base.apiCalls,
        apiCallsExpected: ctx.progress.expectedApiCallCount,
        itemsSynced: base.items,
        details: syncer.summary,
      });
      return { ...base, status: 'completed' };
    },
  };
}

/** Syncs one Jira project into the database, sizing it first. */
export async function syncJiraProject(
  target: JiraProjectTarget,
  ctx: SyncContext,
): Promise<TargetSyncResult> {
  const plan = planJiraProject(target, ctx);
  await plan.survey();
  plan.begin();
  for (const phase of SYNC_PHASES) {
    try {
      await plan.runPhase(phase);
    } catch (error) {
      return plan.finish(error);
    }
  }
  return plan.finish(null);
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

/** A resource whose work spans more than one phase, still being accounted. */
interface OpenOperation {
  id: number;
  cursorBefore: string | null;
  /** Accumulated across phases: the global counter also moves for other targets. */
  calls: number;
}

interface WorkitemRef {
  id: string;
  key: string;
}

class JiraProjectSyncer {
  readonly summary: Record<string, number> = {};
  private readonly jiraCtx: JiraContext;
  /** What the survey counted, and for which query, so the walk can reuse it. */
  private surveyed: { jql: string; total: number | null } | null = null;

  /**
   * Work items whose comments or history the search response did not carry in
   * full, so a request each is still owed. The rest were written in phase one
   * and are not here at all.
   */
  private readonly needComments: WorkitemRef[] = [];
  private readonly needChangelog: WorkitemRef[] = [];
  private readonly needWorklogs: WorkitemRef[] = [];
  private workitemCount = 0;
  private workitemsCursor: string | null = null;

  private readonly boardIds: number[] = [];
  private readonly sprintIds: number[] = [];
  private sprintItems = 0;

  private readonly openOperations = new Map<string, OpenOperation>();

  /*
   * The progress counters are global and every target now moves them, so a
   * delta taken across a phase would bill this target for the others' work.
   */
  private ownCalls = 0;
  private ownItems = 0;

  get apiCalls(): number {
    return this.ownCalls;
  }

  get items(): number {
    return this.ownItems;
  }

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
   * Boards and sprints cannot be counted through the API without listing them,
   * which is the work itself — but the last sync already listed them, and
   * neither the number of boards nor the sprints per board moves much between
   * two runs. So the stored figures price both, and on a first sync only the
   * listing itself is counted, as before.
   */
  async survey(): Promise<void> {
    const { sync } = this.target;

    // The project and the field catalogue, one call each, always.
    this.ctx.progress.expectFor(`${this.scopePrefix}:project`, 2);
    if (sync.boards || sync.sprints) this.surveyBoards();

    if (!sync.workitems) return;

    const scope = `${this.scopePrefix}:workitems`;
    // Two counts, because the search and the follow ups are bounded
    // differently now: every work item is listed, and only the ones that
    // changed can owe a request. Without a `since` the second is free.
    const jql = this.buildJql(null);
    const listed = await this.client.count(jql);
    if (listed === null) return;

    const detailsSince = this.resolveSince(scope);
    const changed =
      detailsSince === null
        ? listed
        : ((await this.client.count(this.buildJql(detailsSince))) ?? listed);

    // Kept so the walk does not pay for the same count a second time.
    this.surveyed = { jql, total: listed };
    this.ctx.progress.expectFor(scope, this.workitemCalls(listed, changed));
  }

  /**
   * Prices the board listing, the sprint listing per board and the membership
   * call per sprint, from what the last sync stored.
   *
   * Each of the three phases replaces its own figure with the exact one as
   * soon as it knows it, so a project that gained or lost a board since
   * yesterday is corrected within the run rather than at the end of it.
   */
  private surveyBoards(): void {
    const { db } = this.ctx;
    const { site, projectKey } = this.jiraCtx;

    // Configured board ids need no listing call at all.
    const configured = this.target.boardIds.length;
    this.ctx.progress.expectFor(`${this.scopePrefix}:boards`, configured > 0 ? 0 : 1);

    const boards = configured > 0 ? configured : boardCount(db, site, projectKey);
    if (boards === null) return;

    this.ctx.progress.expectFor(`${this.scopePrefix}:board_sprints`, boards);
    if (!this.target.sync.sprints) return;

    const perBoard = sprintsPerBoard(db, site, projectKey);
    if (perBoard === null) return;
    this.ctx.progress.expectFor(
      `${this.scopePrefix}:sprint_members`,
      Math.round(boards * perBoard),
    );
  }

  /** The count, for a run that skipped the survey (a targeted sync). */
  private async countForSync(jql: string, scope: string): Promise<number | null> {
    this.ctx.progress.expect(1);
    const total = await this.client.count(jql);
    if (total !== null) this.ctx.progress.expectFor(scope, this.workitemCalls(total, total));
    return total;
  }

  /**
   * The count call, the pages it implies for `listed` work items, and the
   * follow ups the `changed` ones can owe.
   */
  private workitemCalls(listed: number, changed: number): number {
    const { sync } = this.target;
    const perItem = (sync.comments ? 1 : 0) + (sync.changelog ? 1 : 0) + (sync.worklogs ? 1 : 0);
    return 1 + Math.max(1, Math.ceil(listed / this.ctx.config.sync.pageSize)) + changed * perItem;
  }

  async runPhase(phase: SyncPhase): Promise<void> {
    if (phase === 'lists') return this.listEverything();
    if (phase === 'items') return this.fetchNamedItems();
    return this.fetchItemDetails();
  }

  /**
   * Phase one: the project, the field catalogue, every page of the search, and
   * the board listing.
   *
   * A Jira search already carries the work item in full, and usually its
   * comments and history too, so most of a project lands here without a request
   * per item. Only the ones the response truncated are left owing.
   */
  private async listEverything(): Promise<void> {
    const { sync } = this.target;

    this.announce('project');
    // Sized by the survey; a targeted run has no survey, so it seeds it here.
    this.ctx.progress.expectFor(`${this.scopePrefix}:project`, 2);
    await this.slice('project', () => this.syncProject());
    await this.slice('project', () => this.syncFields());

    if (sync.workitems) {
      this.announce('workitems');
      this.beginOperation('workitems');
      await this.slice('workitems', () => this.listWorkitems());
    }

    if (sync.boards || sync.sprints) {
      this.announce('boards');
      this.beginOperation('sprints');
      await this.slice('sprints', () => this.listBoards());
    }
  }

  /** Phase two: the sprints hanging off each board the listing named. */
  private async fetchNamedItems(): Promise<void> {
    if (!this.target.sync.sprints || this.boardIds.length === 0) return;
    this.announce('sprints');
    await this.slice('sprints', () => this.listSprints());
  }

  /** Phase three: what hangs off an individual work item or sprint. */
  private async fetchItemDetails(): Promise<void> {
    const { sync } = this.target;

    if (sync.workitems) {
      this.announce('comments and history');
      await this.slice('workitems', () => this.fetchWorkitemDetails());
      this.endOperation('workitems', {
        items: this.workitemCount,
        cursor: this.workitemsCursor,
      });
    }

    if (sync.boards || sync.sprints) {
      if (sync.sprints) {
        this.announce('sprint membership');
        await this.slice('sprints', () => this.fetchSprintMembership());
      }
      this.endOperation('sprints', { items: this.sprintItems, cursor: nowIso() });
    }
  }

  private announce(what: string): void {
    this.ctx.progress.setPhase(`${this.targetName}: ${what}`);
  }

  /** Runs a slice of one resource's work, billing it to that resource. */
  private async slice<T>(resource: string, fn: () => Promise<T>): Promise<T> {
    const callsBefore = this.ctx.progress.apiCallCount;
    const itemsBefore = this.ctx.progress.itemCount;
    try {
      return await fn();
    } finally {
      const calls = this.ctx.progress.apiCallCount - callsBefore;
      this.ownCalls += calls;
      this.ownItems += this.ctx.progress.itemCount - itemsBefore;
      const open = this.openOperations.get(resource);
      if (open) open.calls += calls;
    }
  }

  private beginOperation(resource: string): void {
    if (this.openOperations.has(resource)) return;
    const scope = `${this.scopePrefix}:${resource}`;
    const cursorBefore = this.ctx.journal.getCursor(scope);
    this.openOperations.set(resource, {
      id: this.ctx.journal.startOperation({ runId: this.runId, resource, scope, cursorBefore }),
      cursorBefore,
      calls: 0,
    });
  }

  /**
   * Closes a resource and advances its cursor, which happens here and nowhere
   * else — so a resource spanning phases only ends in the last one, and a
   * cursor never claims work items are synced whose history was never fetched.
   */
  private endOperation(resource: string, stats: OperationStats): void {
    const open = this.openOperations.get(resource);
    if (!open) return;
    this.openOperations.delete(resource);

    const scope = `${this.scopePrefix}:${resource}`;
    const cursor = stats.cursor ?? open.cursorBefore;
    this.summary[resource] = stats.items;

    this.ctx.journal.finishOperation(open.id, {
      status: 'completed',
      apiCalls: open.calls,
      itemsSynced: stats.items,
      cursorAfter: cursor,
    });
    if (!this.ctx.dryRun) {
      this.ctx.journal.setState({
        scope,
        source: 'jira',
        target: this.targetName,
        resource,
        cursor,
        runId: this.runId,
        fullSync: this.mode === 'initial',
      });
    }
  }

  /** Marks whatever was still in flight as failed, without moving its cursor. */
  abandonOpenOperations(error: unknown): void {
    const message = errorMessage(error);
    for (const open of this.openOperations.values()) {
      this.ctx.journal.finishOperation(open.id, {
        status: 'failed',
        apiCalls: open.calls,
        itemsSynced: 0,
        error: message,
      });
    }
    this.openOperations.clear();
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

  private async listWorkitems(): Promise<void> {
    const scope = `${this.scopePrefix}:workitems`;
    /*
     * Bounds the follow up requests, not the search.
     *
     * Every work item is listed every time, because how many were open on a
     * past day cannot be answered from the ones that changed since — the
     * balance carried in from before is exactly what would be missing. A Jira
     * search returns the item in full anyway, so listing all of them costs
     * pages rather than requests per item.
     */
    const detailsSince = this.resolveSince(scope);
    const jql = this.buildJql(null);

    this.ctx.progress.log(`JQL: ${jql}`);

    // The survey already asked, for this very JQL; asking again would cost a
    // call and could only return the same answer.
    const total =
      this.surveyed?.jql === jql ? this.surveyed.total : await this.countForSync(jql, scope);
    const pageSize = this.ctx.config.sync.pageSize;
    if (total !== null) {
      this.ctx.progress.log(`${total} work item(s) match in ${this.target.projectKey}.`);
    }

    let newestUpdate = detailsSince;
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
        const updatedAt = this.writeWorkitemRow(raw, detailsSince);
        if (updatedAt && (!newestUpdate || updatedAt > newestUpdate)) newestUpdate = updatedAt;
        this.workitemCount += 1;
        this.ctx.progress.recordItems();
      }

      if (page.isLast || page.issues.length === 0) break;
      nextPageToken = page.nextPageToken;
      startAt = page.startAt;
      if (nextPageToken === null && startAt === 0) break;
    }

    this.workitemsCursor = newestUpdate ?? nowIso();
  }

  /**
   * Writes everything the search response carries for one work item: the item,
   * its labels, links and attachments, and its comments and history when the
   * response holds them in full.
   *
   * Where it was truncated the key is remembered instead, so the request that
   * completes it is made in the detail phase with the other per item requests.
   */
  private writeWorkitemRow(raw: JsonObject, detailsSince: string | null = null): string | null {
    const { sync } = this.target;
    const workitem = { id: str(raw, 'id') ?? '', key: str(raw, 'key') ?? '' };
    const syncedAt = nowIso();
    const updated = str(raw, 'fields', 'updated');
    const updatedAt = updated ? new Date(updated).toISOString() : null;
    // Listed either way; only the follow up requests are bounded by `since`.
    const stale = detailsSince !== null && updatedAt !== null && updatedAt < detailsSince;

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

    if (sync.comments) {
      const embedded = (raw['fields'] as JsonObject | undefined)?.['comment'];
      const comments = arr(embedded, 'comments') as JsonObject[];
      const total = num(embedded, 'total');
      if (total !== null && comments.length >= total) this.writeComments(comments, workitem);
      else if (!stale) this.needComments.push(workitem);
    }

    if (sync.changelog) {
      const embedded = raw['changelog'];
      const histories = arr(embedded, 'histories') as JsonObject[];
      const total = num(embedded, 'total');
      if (total !== null && histories.length >= total) this.writeChangelog(histories, workitem);
      else if (!stale) this.needChangelog.push(workitem);
    }

    // Worklogs are never embedded, so they always owe a request.
    if (sync.worklogs && !stale) this.needWorklogs.push(workitem);

    return updatedAt;
  }

  /** The follow up requests the search response left owing. */
  private async fetchWorkitemDetails(): Promise<void> {
    for (const workitem of this.needComments) {
      this.writeComments(await this.client.comments(workitem.key), workitem);
    }
    for (const workitem of this.needChangelog) {
      this.writeChangelog(await this.client.changelog(workitem.key), workitem);
    }
    for (const workitem of this.needWorklogs) {
      await this.syncWorklogs(workitem);
    }
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

    this.writeWorkitemRow(raw);
    await this.fetchWorkitemDetails();
    this.ctx.progress.recordItems();
  }

  private writeComments(comments: JsonObject[], workitem: WorkitemRef): void {
    const syncedAt = nowIso();
    for (const comment of comments) {
      this.write('jira_comments', map.mapComment(comment, this.jiraCtx, workitem, syncedAt));
    }
  }

  private writeChangelog(entries: JsonObject[], workitem: WorkitemRef): void {
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

  /** The boards of the project. One call, or none when they are configured. */
  private async listBoards(): Promise<void> {
    const syncedAt = nowIso();
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

    for (const board of boards) {
      const boardId = num(board, 'id') ?? 0;
      if (boardId === 0) continue;
      this.write(
        'jira_boards',
        map.mapBoard(board, this.jiraCtx.site, this.target.projectKey, syncedAt),
      );
      this.boardIds.push(boardId);
      this.sprintItems += 1;
    }

    // One call per board is now exact, where before it was a guess.
    this.ctx.progress.expectFor(`${this.scopePrefix}:board_sprints`, this.boardIds.length);
  }

  /** The sprints of every board — a list per item, so the item phase. */
  private async listSprints(): Promise<void> {
    const syncedAt = nowIso();

    for (const boardId of this.boardIds) {
      const sprints = await this.client.sprints(boardId);
      for (const sprint of sprints) {
        const sprintId = num(sprint, 'id') ?? 0;
        this.write('jira_sprints', map.mapSprint(sprint, this.jiraCtx.site, boardId, syncedAt));
        this.sprintIds.push(sprintId);
        this.sprintItems += 1;
        this.ctx.progress.recordItems();
      }
    }

    // And one call per sprint, also exact now that they have all been listed.
    this.ctx.progress.expectFor(`${this.scopePrefix}:sprint_members`, this.sprintIds.length);
  }

  /** Which work items are in each sprint. */
  private async fetchSprintMembership(): Promise<void> {
    for (const sprintId of this.sprintIds) {
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
