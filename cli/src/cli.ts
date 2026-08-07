import { Command } from 'commander';

import { createExportCommand } from './commands/export.js';
import { createGithubCommand } from './commands/github.js';
import { createInitCommand } from './commands/init.js';
import { createJiraCommand } from './commands/jira.js';
import { createStatusCommand } from './commands/status.js';
import { createSyncCommand } from './commands/sync.js';
import { createWebCommand } from './commands/web.js';

export const VERSION = '0.1.0';

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
  program.addCommand(createGithubCommand());
  program.addCommand(createJiraCommand());
  program.addCommand(createWebCommand());

  program.addHelpText(
    'after',
    `
Examples:
  devcontext init                             write a commented devcontext.yaml
  devcontext sync                             incremental sync of every project
  devcontext sync --full --source github      download everything from GitHub again
  devcontext gh issues --repo acme/platform   open issues of one repository
  devcontext gh issues --stale 90d --list     issue ids that have been quiet for 90 days
  devcontext gh prs 42 -o markdown            one pull request with reviews as markdown
  devcontext gh runs --conclusion failure     failed workflow runs
  devcontext jira stories --sprint "Sprint 7" stories of a sprint
  devcontext jira search "rate limit" -o json search work items and their comments
  devcontext web                              open the React viewer on the local data
`,
  );

  return program;
}
