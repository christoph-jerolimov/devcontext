import type { ResolvedConfig } from '../config/types.js';
import type { Database } from '../db/database.js';
import type { SyncJournal, SyncMode, SyncStatus } from '../db/journal.js';
import type { Logger } from '../util/logger.js';
import type { ProgressReporter } from './progress.js';

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
