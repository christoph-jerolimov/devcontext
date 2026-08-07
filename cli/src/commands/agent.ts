import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';

import { Command } from 'commander';

import { CliError } from '../util/errors.js';
import { createCommandLogger } from './shared.js';
import type { GlobalOptions } from './shared.js';

const EVE_PACKAGE_NAME = '@devcontext/eve';

/** Walks up from `startDir` looking for the eve agent workspace. */
export function findAgentWorkspace(startDir: string = process.cwd()): string | null {
  const override = process.env['DEVCONTEXT_EVE_DIR'];
  if (override) return isAgentWorkspace(override) ? resolvePath(override) : null;

  let current = resolvePath(startDir);
  for (;;) {
    for (const candidate of [current, join(current, 'eve')]) {
      if (isAgentWorkspace(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isAgentWorkspace(dir: string): boolean {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
    return parsed.name === EVE_PACKAGE_NAME;
  } catch {
    return false;
  }
}

export function createAgentCommand(): Command {
  return new Command('agent')
    .description(`start the ${EVE_PACKAGE_NAME} agent in dev mode (experimental)`)
    .allowUnknownOption()
    .argument('[args...]', 'arguments passed through to "eve dev", e.g. --no-ui')
    .addHelpText(
      'after',
      `
Experimental. Starts the eve based devcontext agent (the ${EVE_PACKAGE_NAME}
workspace) in dev mode. The agent answers questions about the local database
through the same tools the MCP server exposes, using Anthropic models served
by Google Vertex AI.

Requires Node.js >= 24 and Google Cloud credentials:
  ANTHROPIC_VERTEX_PROJECT_ID    Google Cloud project id
  ANTHROPIC_VERTEX_LOCATION      Vertex region (default "global")

The workspace is found by walking up from the current directory (or set
DEVCONTEXT_EVE_DIR). Equivalent to "npm run agent" at the repository root.
`,
    )
    .action(async (args: string[], _options: unknown, self: Command) => {
      const globals = self.optsWithGlobals<GlobalOptions>();
      const logger = createCommandLogger(globals);

      const workspace = findAgentWorkspace();
      if (!workspace) {
        throw new CliError(`No ${EVE_PACKAGE_NAME} workspace found.`, {
          hint: 'Run from the devcontext repository, or point DEVCONTEXT_EVE_DIR at the eve workspace.',
        });
      }

      logger.raw(`Starting the experimental eve agent from ${workspace} ...`);

      // The config flag is forwarded so the agent's tools read the same
      // configuration the CLI would.
      const env = { ...process.env };
      if (globals.config) env['DEVCONTEXT_CONFIG'] = resolvePath(globals.config);
      if (globals.db) env['DEVCONTEXT_DB'] = resolvePath(globals.db);

      const child = spawn('npm', ['exec', '--', 'eve', 'dev', ...args], {
        cwd: workspace,
        env,
        stdio: 'inherit',
      });

      await new Promise<void>((resolve, reject) => {
        child.on('error', (error) =>
          reject(new CliError(`Could not start "eve dev": ${error.message}`)),
        );
        child.on('exit', (code) => {
          process.exitCode = code ?? 0;
          resolve();
        });
      });
    });
}
