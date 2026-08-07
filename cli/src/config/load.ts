import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { CliError } from '../util/errors.js';
import { configSchema } from './schema.js';
import { resolveConfig } from './resolve.js';
import type { ResolvedConfig } from './types.js';

export const CONFIG_FILE_NAMES = [
  'devcontext.local.yaml',
  'devcontext.local.yml',
  'devcontext.yaml',
  'devcontext.yml',
  '.devcontext.yaml',
  '.devcontext.yml',
];

/** Walks up from `startDir` looking for one of the known configuration file names. */
export function findConfigFile(startDir: string = process.cwd()): string | null {
  let current = resolvePath(startDir);

  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = resolvePath(current, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Expands `${VAR}` and `${VAR:-fallback}` references in every string value. */
export function expandEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (match, name, fallback) => {
        const resolved = env[name as string];
        if (resolved !== undefined && resolved !== '') return resolved;
        if (fallback !== undefined) return fallback;
        return match;
      },
    );
  }
  if (Array.isArray(value)) return value.map((item) => expandEnv(item, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        expandEnv(item, env),
      ]),
    );
  }
  return value;
}

export interface LoadConfigOptions {
  /** Explicit path from `--config`. */
  configPath?: string | undefined;
  cwd?: string;
  now?: Date;
}

export function loadConfig(options: LoadConfigOptions = {}): ResolvedConfig {
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.configPath ?? process.env.DEVCONTEXT_CONFIG;

  const configPath = explicit
    ? isAbsolute(explicit)
      ? explicit
      : resolvePath(cwd, explicit)
    : findConfigFile(cwd);

  if (!configPath) {
    throw new CliError('No devcontext configuration file found.', {
      hint: 'Run "devcontext init" to create a devcontext.yaml, or pass --config <path>.',
    });
  }
  if (!existsSync(configPath)) {
    throw new CliError(`Configuration file not found: ${configPath}`);
  }

  return parseConfig(readFileSync(configPath, 'utf8'), {
    configPath,
    ...(options.now ? { now: options.now } : {}),
  });
}

export function parseConfig(
  source: string,
  options: { configPath: string; now?: Date },
): ResolvedConfig {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    throw new CliError(`Cannot parse ${options.configPath} as YAML: ${(error as Error).message}`);
  }

  if (document === null || document === undefined) {
    throw new CliError(`Configuration file ${options.configPath} is empty.`);
  }

  const expanded = expandEnv(document);
  const parsed = configSchema.safeParse(expanded);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${path}: ${issue.message}`;
      })
      .join('\n');
    throw new CliError(`Invalid configuration in ${options.configPath}:\n${issues}`);
  }

  return resolveConfig(parsed.data, {
    configPath: options.configPath,
    rootDir: dirname(options.configPath),
    ...(options.now ? { now: options.now } : {}),
  });
}
