import { Option } from 'commander';
import type { Command } from 'commander';

import { loadConfig } from '../config/load.js';
import type { ResolvedConfig } from '../config/types.js';
import { Database } from '../db/database.js';
import { Directory } from '../people/directory.js';
import type { PersonSelection } from '../people/directory.js';
import { CliError } from '../util/errors.js';
import { createLogger } from '../util/logger.js';
import type { Logger, LogLevel } from '../util/logger.js';
import { resolveTimeExpression } from '../util/time.js';
import { OUTPUT_FORMATS, parseOutputFormat } from '../output/format.js';
import type { OutputFormat } from '../output/format.js';

export interface GlobalOptions {
  config?: string;
  db?: string;
  output?: string;
  list?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  limit?: string;
}

export interface CommandContext {
  config: ResolvedConfig;
  db: Database;
  logger: Logger;
  format: OutputFormat;
  list: boolean;
  limit: number | undefined;
  close(): void;
}

export function createCommandLogger(options: GlobalOptions): Logger {
  const level: LogLevel = options.quiet ? 'error' : options.verbose ? 'debug' : 'info';
  return createLogger(level);
}

/** Loads the configuration and opens the database for a read only command. */
export function openReadContext(command: Command): CommandContext {
  const options = command.optsWithGlobals<GlobalOptions>();
  const logger = createCommandLogger(options);
  const config = loadConfig({ configPath: options.config });
  const databasePath = options.db ?? config.databasePath;

  const db = Database.open(databasePath, { create: false, readOnly: true });

  return {
    config,
    db,
    logger,
    format: parseOutputFormat(options.output),
    list: Boolean(options.list),
    limit: parseLimit(options.limit),
    close: () => db.close(),
  };
}

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError(`--limit expects a positive number, got "${value}".`);
  }
  return parsed === 0 ? undefined : Math.floor(parsed);
}

/** `--output` and `--list` are available on every command. */
export function addOutputOptions(command: Command): Command {
  return command
    .addOption(
      new Option('-o, --output <format>', 'output format')
        .choices([...OUTPUT_FORMATS])
        .default('default'),
    )
    .option('--list', 'print bare identifiers only, one per line (for shell scripts)');
}

/** Filters shared by every list command. */
export function addListOptions(command: Command): Command {
  return addOutputOptions(command)
    .option('-n, --limit <count>', 'maximum number of rows (0 for no limit)', '50')
    .option('--offset <count>', 'skip this many rows')
    .option('--search <text>', 'match text in the title / summary / body');
}

/**
 * `--person`, `--team` and the two bot switches.
 *
 * Separate from `addListOptions` because they only mean something on a list
 * whose rows have an author: the workflow run list has an actor and no author,
 * and offering the filter there would promise something it cannot deliver.
 */
export function addPeopleFilterOptions(command: Command): Command {
  return command
    .option('--person <id>', 'only items involving this configured person, repeatable', collect)
    .option('--team <id>', 'only items involving a member of this team, repeatable', collect)
    .option('--me', 'shorthand for --person <the id me: names in devcontext.yaml>')
    .option('--no-bots', 'hide items written by a bot')
    .option('--bots-only', 'only items written by a bot');
}

export interface PeopleFilterOptions {
  person?: string[];
  team?: string[];
  me?: boolean;
  /** Commander turns `--no-bots` into `bots: false`; unset means include them. */
  bots?: boolean;
  botsOnly?: boolean;
}

/**
 * The people options resolved against the configuration.
 *
 * `selection` is undefined when neither `--person` nor `--team` was given, and
 * an unknown id throws — see `Directory.select`.
 */
export function readPeopleFilter(
  config: ResolvedConfig,
  options: PeopleFilterOptions,
): {
  directory: Directory;
  selection: PersonSelection | undefined;
  excludeBots: boolean;
  onlyBots: boolean;
} {
  const directory = Directory.from(config);
  /*
   * `--me` is sugar for naming yourself, so it goes in as one more person and
   * is refused by the same code when the configuration does not say who you
   * are. Combining it with `--person` is allowed and means both.
   */
  const named = options.me === true ? [...(options.person ?? []), 'me'] : options.person;
  const selection = directory.select({ people: named, teams: options.team });
  return {
    directory,
    selection,
    excludeBots: options.bots === false,
    onlyBots: options.botsOnly === true,
  };
}

export function addTimeFilterOptions(command: Command): Command {
  return command
    .option('--created-since <when>', 'created at or after (30d, 6w, 2024-01-31)')
    .option('--created-before <when>', 'created before (30d, 6w, 2024-01-31)')
    .option('--updated-since <when>', 'updated at or after (30d, 6w, 2024-01-31)')
    .option('--updated-before <when>', 'updated before, i.e. untouched since then')
    .option('--stale <duration>', 'only items not updated for this long (e.g. 90d)');
}

export interface TimeFilters {
  createdSince?: string | undefined;
  createdBefore?: string | undefined;
  updatedSince?: string | undefined;
  updatedBefore?: string | undefined;
}

export function readTimeFilters(options: Record<string, unknown>): TimeFilters {
  const value = (key: string): string | undefined => {
    const raw = options[key];
    return typeof raw === 'string' && raw !== '' ? resolveTimeExpression(raw) : undefined;
  };

  const filters: TimeFilters = {
    createdSince: value('createdSince'),
    createdBefore: value('createdBefore'),
    updatedSince: value('updatedSince'),
    updatedBefore: value('updatedBefore'),
  };

  const stale = value('stale');
  if (stale && !filters.updatedBefore) filters.updatedBefore = stale;
  return filters;
}

export function readOffset(options: Record<string, unknown>): number | undefined {
  const raw = options['offset'];
  if (typeof raw !== 'string' || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

/** Collects repeatable options such as `--label bug --label ui`. */
export function collect(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  ];
}

export function requireRows<T>(rows: T[], message: string): T {
  const [first] = rows;
  if (first === undefined) throw new CliError(message);
  return first;
}
