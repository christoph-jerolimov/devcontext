import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { buildDetectedConfig, detectEnvironment } from '../config/detect.js';
import type { DetectedEnvironment } from '../config/detect.js';
import { EXAMPLE_CONFIG } from '../config/example.js';
import { CliError } from '../util/errors.js';
import { writeTextFile } from '../util/fs.js';
import { printOutput } from '../output/format.js';
import { createCommandLogger } from './shared.js';
import type { GlobalOptions } from './shared.js';

export function createInitCommand(): Command {
  return new Command('init')
    .description('write a devcontext.yaml, detecting the GitHub repository of this directory')
    .option('-f, --force', 'overwrite an existing configuration file')
    .option('--path <file>', 'where to write the configuration', 'devcontext.yaml')
    .option('--example', 'write the fully commented example instead of a detected configuration')
    .option('--detect', 'detect only: print what was found and write nothing')
    .option(
      '--repo <repo>',
      'use this repository instead of the detected one, repeatable',
      collectRepo,
      [],
    )
    .option('--all-remotes', 'include every git remote, not just the first one (origin)')
    .option('--project <key>', 'project key to use in the generated configuration')
    .option('--since <when>', 'how far back the initial sync should reach', '12mo')
    .action(
      async (
        options: {
          force?: boolean;
          path: string;
          example?: boolean;
          detect?: boolean;
          repo: string[];
          allRemotes?: boolean;
          project?: string;
          since: string;
        },
        self: Command,
      ) => {
        const logger = createCommandLogger(self.optsWithGlobals<GlobalOptions>());
        const detected = detectEnvironment();
        const repositories = resolveRepositories(
          detected,
          options.repo,
          options.allRemotes === true,
        );

        if (options.detect) {
          printOutput(describe(detected, repositories));
          return;
        }

        const target = resolve(process.cwd(), options.path);
        if (existsSync(target) && !options.force) {
          throw new CliError(`${target} already exists.`, {
            hint: 'Pass --force to overwrite it.',
          });
        }

        const useExample = options.example === true || repositories.length === 0;
        const content = useExample
          ? EXAMPLE_CONFIG
          : buildDetectedConfig({
              repositories,
              ...(options.project ? { projectKey: options.project } : {}),
              ...(detected.token?.source === 'env' ? { tokenEnv: detected.token.variable } : {}),
              since: options.since,
            });

        await writeTextFile(target, content);
        logger.info(`Wrote ${target}`);

        if (useExample && options.example !== true) {
          logger.warn(
            'No GitHub repository was detected from the git remotes here, so the commented example was written instead.',
          );
          logger.raw(
            '  Edit the projects section, or run "devcontext init --force --repo owner/name".',
          );
        } else if (!useExample) {
          for (const repository of repositories) {
            logger.info(`Detected ${repository.fullName} (remote ${repository.remote})`);
          }
          const skipped = detected.repositories.length - repositories.length;
          if (skipped > 0 && options.repo.length === 0) {
            logger.info(
              `Ignored ${skipped} other git remote(s); pass --all-remotes to include them.`,
            );
          }
        }

        reportToken(detected, logger);
        logger.info('Next: run "devcontext sync".');
      },
    );
}

function collectRepo(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * `--repo owner/name` wins over detection, but keeps the detected host.
 * Only the first remote (origin) is used unless `--all-remotes` is given:
 * syncing the upstream of a fork is rarely what someone means.
 */
function resolveRepositories(
  detected: DetectedEnvironment,
  explicit: string[],
  allRemotes: boolean,
): DetectedEnvironment['repositories'] {
  if (explicit.length === 0) {
    return allRemotes ? detected.repositories : detected.repositories.slice(0, 1);
  }

  return explicit.map((entry) => {
    const [owner, name] = entry.split('/');
    if (!owner || !name) {
      throw new CliError(`--repo expects "owner/name", got "${entry}".`);
    }
    const match = detected.repositories.find((repository) => repository.fullName === entry);
    return {
      fullName: entry,
      owner,
      name,
      remote: match?.remote ?? 'manual',
      host: match?.host ?? 'github.com',
      url: match?.url ?? `https://github.com/${entry}`,
    };
  });
}

function describe(
  detected: DetectedEnvironment,
  repositories: DetectedEnvironment['repositories'],
): string {
  const lines: string[] = [];

  if (repositories.length === 0) {
    lines.push('No GitHub repository found in the git remotes of this directory.');
  } else {
    lines.push('Repositories:');
    for (const repository of repositories) {
      lines.push(
        `  ${repository.fullName}  (remote ${repository.remote}, host ${repository.host})`,
      );
    }
  }

  lines.push('');
  lines.push(`Token: ${describeToken(detected)}`);
  return lines.join('\n');
}

function describeToken(detected: DetectedEnvironment): string {
  if (detected.token === null) return 'none found';
  if (detected.token.source === 'env') return `found in $${detected.token.variable}`;
  return 'available through the gh CLI (`gh auth token`)';
}

function reportToken(
  detected: DetectedEnvironment,
  logger: ReturnType<typeof createCommandLogger>,
): void {
  if (detected.token === null) {
    logger.warn('No GitHub token found. Export GITHUB_TOKEN before syncing private data.');
    return;
  }
  if (detected.token.source === 'env') {
    logger.info(`Using the token in $${detected.token.variable}.`);
    return;
  }
  logger.info(
    'The gh CLI has a token. devcontext reads $GITHUB_TOKEN, so export it: export GITHUB_TOKEN=$(gh auth token)',
  );
}
