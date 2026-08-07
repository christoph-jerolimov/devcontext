import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { EXAMPLE_CONFIG } from '../config/example.js';
import { CliError } from '../util/errors.js';
import { writeTextFile } from '../util/fs.js';
import { createCommandLogger } from './shared.js';
import type { GlobalOptions } from './shared.js';

export function createInitCommand(): Command {
  return new Command('init')
    .description('write a commented devcontext.yaml into the current directory')
    .option('-f, --force', 'overwrite an existing configuration file')
    .option('--path <file>', 'where to write the configuration', 'devcontext.yaml')
    .action(async (options: { force?: boolean; path: string }, self: Command) => {
      const logger = createCommandLogger(self.optsWithGlobals<GlobalOptions>());
      const target = resolve(process.cwd(), options.path);

      if (existsSync(target) && !options.force) {
        throw new CliError(`${target} already exists.`, { hint: 'Pass --force to overwrite it.' });
      }

      await writeTextFile(target, EXAMPLE_CONFIG);
      logger.info(`Wrote ${target}`);
      logger.info(
        'Next: set GITHUB_TOKEN / JIRA_API_TOKEN, adjust the repositories and projects, then run "devcontext sync".',
      );
    });
}
