import { CliError } from './errors.js';

const DURATION_PATTERN = /^(\d+)\s*(m|h|d|w|mo|y)$/i;

const DURATION_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000, // 30 days
  y: 31_536_000_000, // 365 days
};

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Accepts `30d`, `6w`, `3mo`, `2024-01-01`, `2024-01-01T10:00:00Z` and turns it
 * into an absolute ISO timestamp. Relative values are resolved against `now`.
 */
export function resolveTimeExpression(value: string, now: Date = new Date()): string {
  const trimmed = value.trim();

  const duration = DURATION_PATTERN.exec(trimmed);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2]!.toLowerCase();
    const ms = DURATION_MS[unit];
    if (ms === undefined) {
      throw new CliError(`Unsupported time unit "${unit}" in "${value}".`);
    }
    return new Date(now.getTime() - amount * ms).toISOString();
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliError(`Cannot understand the time value "${value}".`, {
      hint: 'Use a relative value like 30d, 6w, 3mo or an absolute date like 2024-01-31.',
    });
  }
  return parsed.toISOString();
}

/** `2024-01-31T10:00:00.000Z` -> `2024-01-31`. */
export function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);

  const diff = now.getTime() - then;
  const future = diff < 0;
  const abs = Math.abs(diff);

  const units: Array<[number, string]> = [
    [31_536_000_000, 'y'],
    [2_592_000_000, 'mo'],
    [604_800_000, 'w'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];

  for (const [ms, suffix] of units) {
    if (abs >= ms) {
      const amount = Math.floor(abs / ms);
      return future ? `in ${amount}${suffix}` : `${amount}${suffix} ago`;
    }
  }
  return future ? 'in a moment' : 'just now';
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
