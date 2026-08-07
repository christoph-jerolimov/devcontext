import { CliError } from '../util/errors.js';

export const OUTPUT_FORMATS = ['default', 'json', 'markdown', 'plain'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function parseOutputFormat(value: string | undefined): OutputFormat {
  const normalised = (value ?? 'default').toLowerCase();
  if ((OUTPUT_FORMATS as readonly string[]).includes(normalised)) return normalised as OutputFormat;
  throw new CliError(`Unknown output format "${value}".`, {
    hint: `Supported formats: ${OUTPUT_FORMATS.join(', ')}.`,
  });
}

export interface Column<T> {
  /** Column header, also used as the key in markdown tables. */
  header: string;
  value: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right';
  /** Columns marked as optional are dropped first when the terminal is narrow. */
  optional?: boolean;
}

export interface TableOptions<T> {
  format: OutputFormat;
  /** `--list`: print one bare identifier per line for shell scripts. */
  list?: boolean;
  listValue?: (row: T) => string | number | null | undefined;
  title?: string | undefined;
  /** Rows handed to the JSON formatter; defaults to the rows themselves. */
  json?: unknown;
  emptyMessage?: string;
  width?: number;
}

export function renderTable<T>(rows: T[], columns: Column<T>[], options: TableOptions<T>): string {
  if (options.list) {
    const value = options.listValue ?? ((row: T) => toText(columns[0]?.value(row)));
    return rows
      .map((row) => toText(value(row)))
      .filter((line) => line !== '')
      .join('\n');
  }

  switch (options.format) {
    case 'json':
      return JSON.stringify(options.json ?? rows, null, 2);
    case 'markdown':
      return renderMarkdownTable(rows, columns, options);
    case 'plain':
      return rows
        .map((row) => columns.map((column) => toText(column.value(row))).join('\t'))
        .join('\n');
    case 'default':
    default:
      return renderPrettyTable(rows, columns, options);
  }
}

function renderMarkdownTable<T>(rows: T[], columns: Column<T>[], options: TableOptions<T>): string {
  const lines: string[] = [];
  if (options.title) lines.push(`## ${options.title}`, '');
  if (rows.length === 0) {
    lines.push(options.emptyMessage ?? '_No matching entries._');
    return lines.join('\n');
  }
  lines.push(`| ${columns.map((column) => escapeCell(column.header)).join(' | ')} |`);
  lines.push(
    `| ${columns.map((column) => (column.align === 'right' ? '---:' : '---')).join(' | ')} |`,
  );
  for (const row of rows) {
    lines.push(`| ${columns.map((column) => escapeCell(toText(column.value(row)))).join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderPrettyTable<T>(rows: T[], columns: Column<T>[], options: TableOptions<T>): string {
  if (rows.length === 0) return options.emptyMessage ?? 'No matching entries.';

  const width = options.width ?? terminalWidth();
  const cells = rows.map((row) => columns.map((column) => toText(column.value(row))));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((row) => (row[index] ?? '').length)),
  );

  // Drop optional columns while the table does not fit.
  const visible = columns.map((_, index) => index);
  const separatorWidth = 2;
  const totalWidth = () =>
    visible.reduce((sum, index) => sum + (widths[index] ?? 0) + separatorWidth, -separatorWidth);

  for (let index = columns.length - 1; index >= 0 && totalWidth() > width; index -= 1) {
    if (columns[index]?.optional) {
      const position = visible.indexOf(index);
      if (position >= 0) visible.splice(position, 1);
    }
  }

  const lines: string[] = [];
  if (options.title) lines.push(bold(options.title), '');

  lines.push(
    dim(
      visible
        .map((index) => pad(columns[index]!.header, widths[index] ?? 0, columns[index]!.align))
        .join('  ')
        .trimEnd(),
    ),
  );

  for (const row of cells) {
    const line = visible
      .map((index) => pad(row[index] ?? '', widths[index] ?? 0, columns[index]!.align))
      .join('  ')
      .trimEnd();
    lines.push(line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line);
  }

  return lines.join('\n');
}

export function renderKeyValues(
  entries: Array<[string, string | number | null | undefined]>,
  format: OutputFormat,
): string {
  const filtered = entries.filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );
  switch (format) {
    case 'json':
      return JSON.stringify(Object.fromEntries(filtered), null, 2);
    case 'markdown':
      return filtered.map(([key, value]) => `- **${key}**: ${toText(value)}`).join('\n');
    case 'plain':
      return filtered.map(([key, value]) => `${key}\t${toText(value)}`).join('\n');
    case 'default':
    default: {
      const width = Math.max(0, ...filtered.map(([key]) => key.length));
      return filtered
        .map(([key, value]) => `${dim(`${key}:`.padEnd(width + 1))} ${toText(value)}`)
        .join('\n');
    }
  }
}

export function toText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function truncate(value: string | null | undefined, max: number): string {
  const text = toText(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function pad(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  return align === 'right' ? value.padStart(width) : value.padEnd(width);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function terminalWidth(): number {
  const columns = process.stdout.columns;
  return typeof columns === 'number' && columns > 20 ? columns : 120;
}

const colorEnabled = (): boolean => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export function dim(value: string): string {
  return colorEnabled() ? `\u001b[2m${value}\u001b[0m` : value;
}

export function bold(value: string): string {
  return colorEnabled() ? `\u001b[1m${value}\u001b[0m` : value;
}

/** Writes a rendered block to stdout, adding exactly one trailing newline. */
export function printOutput(value: string): void {
  if (value === '') return;
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
}
