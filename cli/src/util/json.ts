export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a nested value, e.g. `pick(issue, 'user', 'login')`. */
export function pick(source: unknown, ...path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function str(source: unknown, ...path: string[]): string | null {
  const value = pick(source, ...path);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export function num(source: unknown, ...path: string[]): number | null {
  const value = pick(source, ...path);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function bool(source: unknown, ...path: string[]): boolean | null {
  const value = pick(source, ...path);
  return typeof value === 'boolean' ? value : null;
}

export function arr(source: unknown, ...path: string[]): unknown[] {
  const value = pick(source, ...path);
  return Array.isArray(value) ? value : [];
}

export function obj(source: unknown, ...path: string[]): JsonObject | null {
  const value = pick(source, ...path);
  return isObject(value) ? value : null;
}

/** Maps an array of objects to a string list, dropping empty entries. */
export function strList(source: unknown, path: string[], key: string): string[] {
  return arr(source, ...path)
    .map((item) => (typeof item === 'string' ? item : str(item, key)))
    .filter((item): item is string => typeof item === 'string' && item !== '');
}
