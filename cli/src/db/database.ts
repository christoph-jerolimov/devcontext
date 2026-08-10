import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CliError } from '../util/errors.js';
import { nowIso } from '../util/time.js';
import { migrateFrom } from './migrations.js';
import { SCHEMA_SQL, SCHEMA_VERSION, SEARCH_SCHEMA_SQL } from './schema.js';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type BindValue = SqlValue | boolean | undefined | Record<string, unknown> | unknown[];

/** Converts JavaScript values into something `node:sqlite` accepts. */
export function bindValue(value: BindValue): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

export interface OpenOptions {
  readOnly?: boolean;
  /** Create the file (and its directory) when it does not exist yet. */
  create?: boolean;
}

export class Database {
  readonly path: string;
  private readonly handle: DatabaseSync;
  private closed = false;

  private constructor(handle: DatabaseSync, path: string) {
    this.handle = handle;
    this.path = path;
  }

  static open(path: string, options: OpenOptions = {}): Database {
    const create = options.create ?? true;

    if (path !== ':memory:') {
      if (!existsSync(path)) {
        if (!create) {
          throw new CliError(`No devcontext database at ${path}.`, {
            hint: 'Run "devcontext sync" first to create and populate it.',
          });
        }
        mkdirSync(dirname(path), { recursive: true });
      }
    }

    let handle: DatabaseSync;
    try {
      handle = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    } catch (error) {
      throw new CliError(`Cannot open the database at ${path}: ${(error as Error).message}`, {
        cause: error,
      });
    }

    const db = new Database(handle, path);
    if (!options.readOnly) {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
    }
    // Wait out a concurrent writer instead of failing with SQLITE_BUSY. With
    // WAL this only bites in the brief moments a checkpoint holds the file,
    // but "brief" is exactly when a running sync and an open viewer meet.
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = OFF;');
    return db;
  }

  /** Opens the database and makes sure the schema is up to date. */
  static openAndMigrate(path: string, options: OpenOptions = {}): Database {
    const db = Database.open(path, options);
    db.migrate();
    return db;
  }

  migrate(): void {
    this.exec(SCHEMA_SQL);

    // FTS5 is a compile time option. Everything else works without it, so a
    // SQLite build that lacks it loses fast search rather than the database.
    try {
      this.exec(SEARCH_SCHEMA_SQL);
    } catch {
      // `searchIndexAvailable()` reports this; searching falls back to scanning.
    }

    const current = this.getMeta('schema_version');
    if (current === null) {
      this.setMeta('schema_version', String(SCHEMA_VERSION));
      this.setMeta('created_at', nowIso());
    } else if (Number(current) > SCHEMA_VERSION) {
      throw new CliError(
        `The database at ${this.path} was written by a newer devcontext (schema ${current}, this build understands ${SCHEMA_VERSION}).`,
        { hint: 'Update the CLI or delete the database and sync again.' },
      );
    } else if (Number(current) < SCHEMA_VERSION) {
      // The schema itself is idempotent, but CREATE TABLE IF NOT EXISTS does
      // nothing to a table that already exists — a new column needs a step.
      migrateFrom(this, Number(current));
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    }
    this.setMeta('updated_at', nowIso());
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  run(sql: string, params: BindValue[] = []): { changes: number; lastInsertRowid: number } {
    const statement = this.handle.prepare(sql);
    const result = statement.run(...params.map(bindValue));
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  get<T = Record<string, unknown>>(sql: string, params: BindValue[] = []): T | undefined {
    const statement = this.handle.prepare(sql);
    const row = statement.get(...params.map(bindValue));
    return row === undefined ? undefined : (row as T);
  }

  all<T = Record<string, unknown>>(sql: string, params: BindValue[] = []): T[] {
    const statement = this.handle.prepare(sql);
    return statement.all(...params.map(bindValue)) as T[];
  }

  /** `INSERT OR REPLACE` for a plain object; keys must be real column names. */
  upsert(table: string, row: Record<string, BindValue>): void {
    const columns = Object.keys(row);
    if (columns.length === 0) return;
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO ${table} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;
    this.run(
      sql,
      columns.map((column) => row[column] as BindValue),
    );
  }

  transaction<T>(fn: () => T): T {
    this.exec('BEGIN');
    try {
      const result = fn();
      this.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // The transaction was already rolled back by SQLite.
      }
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value]);
  }

  tableExists(name: string): boolean {
    const row = this.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    );
    return row !== undefined;
  }

  count(table: string, where = '', params: BindValue[] = []): number {
    const sql = `SELECT COUNT(*) AS total FROM ${table}${where ? ` WHERE ${where}` : ''}`;
    const row = this.get<{ total: number }>(sql, params);
    return Number(row?.total ?? 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handle.close();
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Parses a JSON column, returning `fallback` for null/invalid values. */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
