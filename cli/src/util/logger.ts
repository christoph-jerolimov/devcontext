export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  level: LogLevel;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  /** Writes without a level prefix; used for progress lines. */
  raw(message: string): void;
}

const COLOR = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
};

/** All logger output goes to stderr so that stdout stays a clean data channel. */
export function createLogger(level: LogLevel = 'info'): Logger {
  const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
  const paint = (color: string, text: string) =>
    useColor ? `${color}${text}${COLOR.reset}` : text;

  const write = (target: LogLevel, prefix: string, message: string) => {
    if (LEVELS[logger.level] < LEVELS[target]) return;
    process.stderr.write(`${prefix}${message}\n`);
  };

  const logger: Logger = {
    level,
    error: (message) => write('error', paint(COLOR.red, 'error: '), message),
    warn: (message) => write('warn', paint(COLOR.yellow, 'warn:  '), message),
    info: (message) => write('info', paint(COLOR.blue, 'info:  '), message),
    debug: (message) => write('debug', paint(COLOR.dim, 'debug: '), message),
    raw: (message) => {
      if (LEVELS[logger.level] === LEVELS.silent) return;
      process.stderr.write(`${message}\n`);
    },
  };

  return logger;
}

/** A logger that swallows everything, handy in tests. */
export const nullLogger: Logger = {
  level: 'silent',
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  raw: () => {},
};
