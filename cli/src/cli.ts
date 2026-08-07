import { Command } from 'commander';

import { createDigestCommand } from './commands/digest.js';
import { createExportCommand } from './commands/export.js';
import { createGithubCommand } from './commands/github.js';
import { createInitCommand } from './commands/init.js';
import { createInsightsCommand } from './commands/insights.js';
import { createJiraCommand } from './commands/jira.js';
import { createLinksCommand } from './commands/links.js';
import { createMcpCommand } from './commands/mcp.js';
import { createSearchCommand } from './commands/search.js';
import { createStatusCommand } from './commands/status.js';
import { createSyncCommand } from './commands/sync.js';
import { createWebCommand } from './commands/web.js';
import { VERSION } from './version.js';

export { VERSION };

export function createProgram(): Command {
  const program = new Command('devcontext')
    .description(
      'Sync GitHub and Jira into a local SQLite database (plus yaml and markdown mirrors) and query it offline.',
    )
    .version(VERSION)
    .option('-c, --config <path>', 'path to devcontext.yaml')
    .option('--db <path>', 'override the database path from the configuration')
    .option('-v, --verbose', 'log every request')
    .option('-q, --quiet', 'only log errors')
    .showHelpAfterError();

  program.addCommand(createInitCommand());
  program.addCommand(createSyncCommand());
  program.addCommand(createStatusCommand());
  program.addCommand(createExportCommand());
  program.addCommand(createSearchCommand());
  program.addCommand(createGithubCommand());
  program.addCommand(createJiraCommand());
  program.addCommand(createWebCommand());
  program.addCommand(createInsightsCommand());
  program.addCommand(createDigestCommand());
  program.addCommand(createLinksCommand());
  program.addCommand(createMcpCommand());

  program.addHelpText(
    'after',
    `
Examples:
  devcontext init                             write a commented devcontext.yaml
  devcontext sync                             incremental sync of every project
  devcontext sync --full --source github      download everything from GitHub again
  devcontext sync --only PLAT-42              refresh one ticket now, then sync the rest
  devcontext search "rate limit"              everything mentioning it, ranked
  devcontext gh issues --repo acme/platform   open issues of one repository
  devcontext gh issues --stale 90d --list     issue ids that have been quiet for 90 days
  devcontext gh prs 42 -o markdown            one pull request with reviews as markdown
  devcontext gh runs --conclusion failure     failed workflow runs
  devcontext jira stories --sprint "Sprint 7" stories of a sprint
  devcontext jira search "rate limit" -o json search work items and their comments
  devcontext web                              open the React viewer on the local data
  devcontext insights                         cycle time, review latency, WIP, stale, flaky steps
  devcontext digest --since 1w -o markdown    a weekly summary to paste into a standup
  devcontext links PLAT-42                    pull requests and issues that reference a ticket
  devcontext mcp --tools                      list the tools the MCP server exposes
`,
  );

  return program;
}
