/** Small formatters the views share. */

const UNITS: Array<[number, string]> = [
  [31_536_000_000, 'y'],
  [2_592_000_000, 'mo'],
  [604_800_000, 'w'],
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'm'],
];

/** `3d`, `2mo`, `now` — short, because it shares a line with everything else. */
export function relative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const diff = now - then;
  for (const [ms, suffix] of UNITS) {
    if (Math.abs(diff) >= ms) return `${String(Math.floor(Math.abs(diff) / ms))}${suffix}`;
  }
  return 'now';
}

/** Hours as `4h` or `3.2d`, matching how the insights command reads. */
export function duration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return '';
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

/** A bar for a value scaled against the largest in its set. */
export function bar(value: number, peak: number, width: number): string {
  if (peak <= 0 || width <= 0) return '';
  return '█'.repeat(Math.max(0, Math.round((value / peak) * width)));
}
