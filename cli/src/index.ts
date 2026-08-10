/** Public API of the devcontext CLI package, for scripts that embed it. */

export { createProgram, VERSION } from './cli.js';
export { loadConfig, parseConfig, findConfigFile } from './config/load.js';
export { resolveConfig } from './config/resolve.js';
export type * from './config/types.js';
export { Database, parseJsonColumn } from './db/database.js';
export { SyncJournal } from './db/journal.js';
export * as githubQueries from './db/queries/github.js';
export * as jiraQueries from './db/queries/jira.js';
export * as historyQueries from './db/queries/history.js';
export * as ticketQueries from './db/queries/tickets.js';
export * as peopleQueries from './db/queries/people.js';
export * as activityQueries from './db/queries/activity.js';
export { Directory, looksLikeBot } from './people/directory.js';
export type { PersonSelection } from './people/directory.js';
export * as insights from './insights/index.js';
export { buildDigest } from './insights/digest.js';
export { buildStateHistory } from './history/build.js';
export { runSync } from './sync/runner.js';
export { nullLogger } from './util/logger.js';
export type { Logger } from './util/logger.js';
export type { RunSyncOptions, SyncSummary } from './sync/runner.js';
export { exportOutputs } from './exporters/index.js';
export { buildIssueDocument, buildPullRequestDocument } from './documents/github.js';
export { buildWorkitemDocument, buildSprintDocument } from './documents/jira.js';
export { startWebServer } from './web/server.js';
export { TOOLS as mcpTools, TOOLS_BY_NAME as mcpToolsByName } from './mcp/tools.js';
export type { Tool as McpTool, ToolContext as McpToolContext } from './mcp/tools.js';
