import { silenceSqliteExperimentalWarning } from './util/warnings.js';

silenceSqliteExperimentalWarning();

const { createProgram } = await import('./cli.js');
const { isCliError } = await import('./util/errors.js');
const { createLogger } = await import('./util/logger.js');

const logger = createLogger(process.argv.includes('--verbose') ? 'debug' : 'info');

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (isCliError(error)) {
    logger.error(error.message);
    if (error.hint) logger.raw(`  hint: ${error.hint}`);
    process.exitCode = error.exitCode;
  } else if (
    error instanceof Error &&
    'code' in error &&
    error.code === 'commander.helpDisplayed'
  ) {
    process.exitCode = 0;
  } else {
    logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
