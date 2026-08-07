import type { Database } from './database.js';
import { nowIso } from '../util/time.js';

/**
 * `targeted` is a sync of one named item. It writes rows but deliberately does
 * not advance any cursor, so a later incremental run still covers the window.
 */
export type SyncMode = 'initial' | 'incremental' | 'targeted';
export type SyncStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped';

export interface SyncRunRow {
  id: number;
  project_key: string | null;
  source: string;
  target: string;
  mode: SyncMode;
  status: SyncStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  api_calls: number;
  api_calls_expected: number;
  items_synced: number;
  error: string | null;
  details: string | null;
}

export interface SyncOperationRow {
  id: number;
  run_id: number;
  resource: string;
  scope: string;
  status: SyncStatus;
  started_at: string;
  finished_at: string | null;
  api_calls: number;
  items_synced: number;
  cursor_before: string | null;
  cursor_after: string | null;
  error: string | null;
}

export interface SyncStateRow {
  scope: string;
  source: string;
  target: string;
  resource: string;
  cursor: string | null;
  last_run_id: number | null;
  last_full_sync_at: string | null;
  updated_at: string;
  details: string | null;
}

/**
 * Records every sync run and remembers where the next incremental sync has to
 * continue. Both live in the database so a machine-readable history is kept.
 */
export class SyncJournal {
  constructor(private readonly db: Database) {}

  startRun(input: {
    projectKey: string | null;
    source: string;
    target: string;
    mode: SyncMode;
  }): number {
    const result = this.db.run(
      `INSERT INTO sync_runs (project_key, source, target, mode, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      [input.projectKey, input.source, input.target, input.mode, nowIso()],
    );
    return result.lastInsertRowid;
  }

  updateRunProgress(
    runId: number,
    input: { apiCalls: number; apiCallsExpected: number; itemsSynced: number },
  ): void {
    this.db.run(
      `UPDATE sync_runs SET api_calls = ?, api_calls_expected = ?, items_synced = ? WHERE id = ?`,
      [input.apiCalls, input.apiCallsExpected, input.itemsSynced, runId],
    );
  }

  finishRun(
    runId: number,
    input: {
      status: SyncStatus;
      apiCalls: number;
      apiCallsExpected: number;
      itemsSynced: number;
      error?: string | null;
      details?: unknown;
    },
  ): void {
    const run = this.getRun(runId);
    const startedAt = run ? new Date(run.started_at).getTime() : Date.now();
    this.db.run(
      `UPDATE sync_runs
          SET status = ?, finished_at = ?, duration_ms = ?, api_calls = ?,
              api_calls_expected = ?, items_synced = ?, error = ?, details = ?
        WHERE id = ?`,
      [
        input.status,
        nowIso(),
        Date.now() - startedAt,
        input.apiCalls,
        input.apiCallsExpected,
        input.itemsSynced,
        input.error ?? null,
        input.details === undefined ? null : JSON.stringify(input.details),
        runId,
      ],
    );
  }

  getRun(runId: number): SyncRunRow | undefined {
    return this.db.get<SyncRunRow>('SELECT * FROM sync_runs WHERE id = ?', [runId]);
  }

  /** Marks runs that never finished (e.g. the process was killed) as interrupted. */
  markStaleRunsInterrupted(): number {
    const result = this.db.run(
      `UPDATE sync_runs SET status = 'interrupted', finished_at = ?
        WHERE status = 'running'`,
      [nowIso()],
    );
    return result.changes;
  }

  startOperation(input: {
    runId: number;
    resource: string;
    scope: string;
    cursorBefore: string | null;
  }): number {
    const result = this.db.run(
      `INSERT INTO sync_operations (run_id, resource, scope, status, started_at, cursor_before)
       VALUES (?, ?, ?, 'running', ?, ?)`,
      [input.runId, input.resource, input.scope, nowIso(), input.cursorBefore],
    );
    return result.lastInsertRowid;
  }

  finishOperation(
    operationId: number,
    input: {
      status: SyncStatus;
      apiCalls: number;
      itemsSynced: number;
      cursorAfter?: string | null;
      error?: string | null;
    },
  ): void {
    this.db.run(
      `UPDATE sync_operations
          SET status = ?, finished_at = ?, api_calls = ?, items_synced = ?,
              cursor_after = ?, error = ?
        WHERE id = ?`,
      [
        input.status,
        nowIso(),
        input.apiCalls,
        input.itemsSynced,
        input.cursorAfter ?? null,
        input.error ?? null,
        operationId,
      ],
    );
  }

  getState(scope: string): SyncStateRow | undefined {
    return this.db.get<SyncStateRow>('SELECT * FROM sync_state WHERE scope = ?', [scope]);
  }

  getCursor(scope: string): string | null {
    return this.getState(scope)?.cursor ?? null;
  }

  setState(input: {
    scope: string;
    source: string;
    target: string;
    resource: string;
    cursor: string | null;
    runId: number | null;
    fullSync: boolean;
    details?: unknown;
  }): void {
    const existing = this.getState(input.scope);
    const lastFullSyncAt = input.fullSync ? nowIso() : (existing?.last_full_sync_at ?? null);
    this.db.run(
      `INSERT OR REPLACE INTO sync_state
         (scope, source, target, resource, cursor, last_run_id, last_full_sync_at, updated_at, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.scope,
        input.source,
        input.target,
        input.resource,
        input.cursor,
        input.runId,
        lastFullSyncAt,
        nowIso(),
        input.details === undefined ? null : JSON.stringify(input.details),
      ],
    );
  }

  listRuns(options: { limit?: number; source?: string; target?: string } = {}): SyncRunRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.source) {
      where.push('source = ?');
      params.push(options.source);
    }
    if (options.target) {
      where.push('target = ?');
      params.push(options.target);
    }
    params.push(options.limit ?? 20);
    return this.db.all<SyncRunRow>(
      `SELECT * FROM sync_runs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY started_at DESC, id DESC
        LIMIT ?`,
      params,
    );
  }

  listOperations(runId: number): SyncOperationRow[] {
    return this.db.all<SyncOperationRow>(
      'SELECT * FROM sync_operations WHERE run_id = ? ORDER BY id',
      [runId],
    );
  }

  listState(options: { source?: string; target?: string } = {}): SyncStateRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (options.source) {
      where.push('source = ?');
      params.push(options.source);
    }
    if (options.target) {
      where.push('target = ?');
      params.push(options.target);
    }
    return this.db.all<SyncStateRow>(
      `SELECT * FROM sync_state ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY scope`,
      params,
    );
  }
}
