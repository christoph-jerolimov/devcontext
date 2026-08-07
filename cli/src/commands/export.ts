import { Command } from 'commander';

import { loadConfig } from '../config/load.js';
import { Database } from '../db/database.js';
import { exportOutputs } from '../exporters/index.js';
import { printOutput, renderKeyValues } from '../output/format.js';
import { parseOutputFormat } from '../output/format.js';
import { collect, createCommandLogger } from './shared.js';
import type { GlobalOptions } from './shared.js';
import { addOutputOptions } from './shared.js';

export function createExportCommand(): Command {
  const command = new Command('export')
    .description('write the yaml / markdown / json outputs again from the database')
    .option('-r, --repo <repo>', 'only this repository, repeatable', collect, [])
    .option('-p, --project <key>', 'only this Jira project key, repeatable', collect, [])
    .option('--no-workflow-runs', 'skip the workflow run documents');

  return addOutputOptions(command).action(
    async (options: Record<string, unknown>, self: Command) => {
      const globals = self.optsWithGlobals<GlobalOptions>();
      const logger = createCommandLogger(globals);
      const config = loadConfig({ configPath: globals.config });
      const databasePath = globals.db ?? config.databasePath;

      const db = Database.open(databasePath, { create: false, readOnly: true });
      try {
        const repos = options['repo'] as string[];
        const projects = options['project'] as string[];

        const summary = await exportOutputs({
          db,
          config,
          logger,
          repos: repos.length > 0 ? repos : undefined,
          jiraProjects: projects.length > 0 ? projects.map((key) => key.toUpperCase()) : undefined,
          includeWorkflowRuns: options['workflowRuns'] !== false,
        });

        const format = parseOutputFormat(globals.output);
        if (format === 'json') {
          printOutput(JSON.stringify(summary, null, 2));
          return;
        }
        printOutput(
          renderKeyValues(
            [
              ['Files', summary.files],
              ...Object.entries(summary.byTarget).map(
                ([target, count]) => [target, count] as [string, number],
              ),
            ],
            format,
          ),
        );
      } finally {
        db.close();
      }
    },
  );
}
