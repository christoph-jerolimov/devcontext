import type { ResolvedConfig } from '../config/types.js';
import type { Database } from '../db/database.js';
import type { SyncJournal, SyncMode, SyncStatus } from '../db/journal.js';
import type { Logger } from '../util/logger.js';
import type { ProgressReporter } from './progress.js';

/**
 * The three passes every target makes, in order.
 *
 * The split is by how the data is reached, not by what it is:
 *
 * - `lists` walks the collections — every page of issues, of workflow runs, of
 *   work items, for every target — and writes what those pages already carry.
 * - `items` fetches the individual things a list only named: the detailed pull
 *   request payload, the sprints hanging off each board.
 * - `details` fetches what hangs off an individual item: comments, timelines,
 *   reviews, changed files, the jobs of a run, the membership of a sprint.
 *
 * Every target finishes a phase before any target starts the next one. That
 * ordering is what makes the remaining work knowable: once the lists are in,
 * the exact number of issues, pull requests and runs is known, so phases two
 * and three can be priced instead of estimated.
 */
export const SYNC_PHASES = ['lists', 'items', 'details'] as const;

export type SyncPhase = (typeof SYNC_PHASES)[number];

/**
 * One target, prepared but not started.
 *
 * Splitting the survey from the run is what lets every target be priced before
 * any of them is synced, so the expected total is right from the first percent
 * instead of climbing each time another repository or resource is reached.
 */
export interface TargetPlan {
  label: string;
  survey: () => Promise<void>;
  /** Opens the journal run. Called once, before the first phase. */
  begin: () => void;
  /** Runs one phase. Called in `SYNC_PHASES` order, at most once each. */
  runPhase: (phase: SyncPhase) => Promise<void>;
  /**
   * Closes the journal run and reports what happened.
   *
   * Takes the error from whichever phase failed, because the phases are driven
   * from outside now and the plan no longer sees the throw itself.
   */
  finish: (error: unknown | null) => TargetSyncResult;
}

export interface SyncContext {
  db: Database;
  journal: SyncJournal;
  progress: ProgressReporter;
  logger: Logger;
  config: ResolvedConfig;
  /** Ignore stored cursors and download everything again. */
  full: boolean;
  /** Fetch from the APIs but do not write to the database or the outputs. */
  dryRun: boolean;
  projectKey: string;
  /** Aborts the work in flight when the person asks the sync to stop. */
  signal?: AbortSignal;
  /**
   * Resources this target already finished in the run being resumed.
   *
   * Empty unless `--resume` was asked for. A resource is only listed when its
   * operation completed, which is also when its cursor moved — so skipping it
   * cannot lose anything.
   */
  alreadyDone?: ReadonlySet<string>;
}

export interface TargetSyncResult {
  runId: number;
  source: 'github' | 'jira';
  target: string;
  mode: SyncMode;
  status: SyncStatus;
  apiCalls: number;
  items: number;
  error?: string;
}
