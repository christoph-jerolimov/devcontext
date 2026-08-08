import { Command } from 'commander';

import { createAgentCommand } from './commands/agent.js';
import { createAuditCommand } from './commands/audit.js';
import { createDigestCommand } from './commands/digest.js';
import { createExportCommand } from './commands/export.js';
import { createGithubCommand } from './commands/github.js';
import { createInitCommand } from './commands/init.js';
import { createInsightsCommand } from './commands/insights.js';
import { createJiraCommand } from './commands/jira.js';
import { createHistoryCommand } from './commands/history.js';
import { createContributorsCommand } from './commands/contributors.js';
import { createLinksCommand } from './commands/links.js';
import { createMcpCommand } from './commands/mcp.js';
import { createSearchCommand } from './commands/search.js';
import { createServeCommand } from './commands/serve.js';
import { createStatusCommand } from './commands/status.js';
import { createSyncCommand } from './commands/sync.js';
import { createActivityCommand } from './commands/activity.js';
import { createPeopleCommand, createTeamsCommand } from './commands/people.js';
import { createTicketsCommand } from './commands/tickets.js';
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
  program.addCommand(createTicketsCommand());
  program.addCommand(createActivityCommand());
  program.addCommand(createPeopleCommand());
  program.addCommand(createTeamsCommand());
  program.addCommand(createServeCommand());
  program.addCommand(createInsightsCommand());
  program.addCommand(createDigestCommand());
  program.addCommand(createLinksCommand());
  program.addCommand(createContributorsCommand());
  program.addCommand(createHistoryCommand());
  program.addCommand(createAuditCommand());
  program.addCommand(createMcpCommand());
  program.addCommand(createAgentCommand());

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
  devcontext serve                            open the React viewer on the local data
  devcontext insights                         cycle time, review latency, WIP, stale, flaky steps
  devcontext digest --since 1w -o markdown    a weekly summary to paste into a standup
  devcontext links PLAT-42                    pull requests and issues that reference a ticket
  devcontext audit                            what is stored locally and what a sync fetches
  devcontext audit secrets                    credentials pasted into tickets and CI logs
  devcontext mcp --tools                      list the tools the MCP server exposes
  devcontext agent                            start the eve based agent in dev mode (experimental)
`,
  );

  return program;
}
