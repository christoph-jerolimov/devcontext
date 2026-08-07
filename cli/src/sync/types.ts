import type { ResolvedConfig } from '../config/types.js';
import type { Database } from '../db/database.js';
import type { SyncJournal, SyncMode, SyncStatus } from '../db/journal.js';
import type { Logger } from '../util/logger.js';
import type { ProgressReporter } from './progress.js';

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
  run: () => Promise<TargetSyncResult>;
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
