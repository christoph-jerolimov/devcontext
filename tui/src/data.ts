/**
 * Everything the views read, in one place.
 *
 * The web viewer reaches the database through an HTTP API because a browser
 * cannot open a file. A terminal can, so the TUI queries it directly — the
 * same functions the server calls, one process fewer, and no port to pick.
 */

import {
  buildDigest,
  Database,
  githubQueries,
  historyQueries,
  insights,
  jiraQueries,
  loadConfig,
} from '@devcontext/cli';
import type { ResolvedConfig } from '@devcontext/cli';

export interface Store {
  config: ResolvedConfig;
  db: Database;
  close: () => void;
}

/** Read only, because nothing here should ever be able to change the mirror. */
export function openStore(options: { config?: string; db?: string }): Store {
  const config = loadConfig(options.config === undefined ? {} : { configPath: options.config });
  const db = Database.open(options.db ?? config.databasePath, { create: false, readOnly: true });
  return { config, db, close: () => void db.close() };
}

export { buildDigest, githubQueries, historyQueries, insights, jiraQueries };
