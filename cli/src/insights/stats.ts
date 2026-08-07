/** Small statistics helpers shared by the insight queries. */

export interface Distribution {
  count: number;
  /** Median. */
  p50: number | null;
  /** The value 85% of samples are below; a better "worst normal case" than the max. */
  p85: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
  average: number | null;
  total: number;
}

export function describe(values: number[]): Distribution {
  const usable = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
  const total = usable.reduce((sum, value) => sum + value, 0);

  return {
    count: usable.length,
    p50: percentile(usable, 0.5),
    p85: percentile(usable, 0.85),
    p95: percentile(usable, 0.95),
    min: usable[0] ?? null,
    max: usable[usable.length - 1] ?? null,
    average: usable.length > 0 ? total / usable.length : null,
    total,
  };
}

/** Nearest-rank percentile on an already sorted array. */
export function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

export function hoursBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const hours = (end - start) / 3_600_000;
  return hours >= 0 ? hours : null;
}

/** `36.5` -> `1d 12h`, for hours. */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

export function percent(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((part / total) * 1000) / 10;
}
