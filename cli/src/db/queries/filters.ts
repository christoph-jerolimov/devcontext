import type { BindValue } from '../database.js';

/** Small helper that accumulates `WHERE` fragments and their bound values. */
export class WhereBuilder {
  private readonly clauses: string[] = [];
  private readonly params: BindValue[] = [];

  add(clause: string, ...values: BindValue[]): this {
    this.clauses.push(clause);
    this.params.push(...values);
    return this;
  }

  addIf(condition: unknown, clause: string, ...values: BindValue[]): this {
    if (condition === undefined || condition === null || condition === false || condition === '') {
      return this;
    }
    return this.add(clause, ...values);
  }

  /** `column IN (?, ?, ?)` for a non empty list. */
  addIn(column: string, values: readonly string[] | undefined): this {
    if (!values || values.length === 0) return this;
    const placeholders = values.map(() => '?').join(', ');
    return this.add(`${column} IN (${placeholders})`, ...values);
  }

  /** Case insensitive `LIKE %value%` across several columns. */
  addSearch(columns: readonly string[], value: string | undefined): this {
    if (!value) return this;
    const pattern = `%${value.toLowerCase()}%`;
    const clause = columns.map((column) => `LOWER(COALESCE(${column}, '')) LIKE ?`).join(' OR ');
    return this.add(`(${clause})`, ...columns.map(() => pattern));
  }

  get sql(): string {
    return this.clauses.length > 0 ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }

  get values(): BindValue[] {
    return [...this.params];
  }
}

export interface PagingOptions {
  limit?: number | undefined;
  offset?: number | undefined;
}

export function limitClause(options: PagingOptions): { sql: string; params: BindValue[] } {
  const params: BindValue[] = [];
  let sql = '';
  if (options.limit !== undefined && options.limit > 0) {
    sql += ' LIMIT ?';
    params.push(options.limit);
    if (options.offset !== undefined && options.offset > 0) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }
  }
  return { sql, params };
}

export function orderClause(
  column: string,
  direction: 'asc' | 'desc' = 'desc',
  fallback = 'id',
): string {
  const dir = direction === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${column} ${dir}, ${fallback} ${dir}`;
}
