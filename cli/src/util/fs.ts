import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, 'utf8');
}

/** Turns `owner/repo` or `Some Board Name` into something safe for a file name. */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[^\w.\-/]+/g, '-')
      .replace(/\//g, '__')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'unnamed'
  );
}

/** Zero pads numbers so directory listings sort naturally. */
export function padNumber(value: number, width = 6): string {
  return String(value).padStart(width, '0');
}
