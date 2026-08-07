import { bold, dim, renderKeyValues, toText } from './format.js';
import type { OutputFormat } from './format.js';

export interface DocumentEntry {
  title: string;
  /** Small line under the entry title, e.g. "alice · 3d ago". */
  meta?: string | undefined;
  body?: string | null | undefined;
}

export interface DocumentSection {
  heading: string;
  body?: string | null | undefined;
  entries?: DocumentEntry[] | undefined;
  table?: { columns: string[]; rows: Array<Array<string | number | null | undefined>> } | undefined;
}

export interface Document {
  title: string;
  subtitle?: string | undefined;
  url?: string | null | undefined;
  meta: Array<[string, string | number | null | undefined]>;
  body?: string | null | undefined;
  sections: DocumentSection[];
  /** The structured representation used for `--output json`. */
  data: unknown;
}

/** Renders a single item view (issue, pull request, work item, workflow run). */
export function renderDocument(document: Document, format: OutputFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(document.data, null, 2);
    case 'markdown':
      return renderMarkdown(document);
    case 'plain':
      return renderPlain(document);
    case 'default':
    default:
      return renderDefault(document);
  }
}

function renderMarkdown(document: Document): string {
  const lines: string[] = [`# ${document.title}`, ''];
  if (document.subtitle) lines.push(`_${document.subtitle}_`, '');
  const meta = renderKeyValues(document.meta, 'markdown');
  if (meta) lines.push(meta, '');
  if (document.url) lines.push(`[${document.url}](${document.url})`, '');
  if (document.body) lines.push(document.body.trim(), '');

  for (const section of document.sections) {
    if (isEmptySection(section)) continue;
    lines.push(`## ${section.heading}`, '');
    if (section.body) lines.push(section.body.trim(), '');
    for (const entry of section.entries ?? []) {
      lines.push(`### ${entry.title}`);
      if (entry.meta) lines.push('', `_${entry.meta}_`);
      if (entry.body) lines.push('', entry.body.trim());
      lines.push('');
    }
    if (section.table && section.table.rows.length > 0) {
      lines.push(`| ${section.table.columns.join(' | ')} |`);
      lines.push(`| ${section.table.columns.map(() => '---').join(' | ')} |`);
      for (const row of section.table.rows) {
        lines.push(`| ${row.map((cell) => toText(cell).replace(/\|/g, '\\|')).join(' | ')} |`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderDefault(document: Document): string {
  const lines: string[] = [bold(document.title)];
  if (document.subtitle) lines.push(dim(document.subtitle));
  lines.push('');
  const meta = renderKeyValues(document.meta, 'default');
  if (meta) lines.push(meta, '');
  if (document.url) lines.push(dim(document.url), '');
  if (document.body) lines.push(document.body.trim(), '');

  for (const section of document.sections) {
    if (isEmptySection(section)) continue;
    lines.push(bold(`── ${section.heading} ──`));
    if (section.body) lines.push(section.body.trim());
    for (const entry of section.entries ?? []) {
      lines.push('');
      lines.push(`${bold(entry.title)}${entry.meta ? ` ${dim(entry.meta)}` : ''}`);
      if (entry.body) lines.push(indent(entry.body.trim(), '  '));
    }
    if (section.table && section.table.rows.length > 0) {
      lines.push('', ...alignTable(section.table.columns, section.table.rows));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function renderPlain(document: Document): string {
  const lines: string[] = [document.title];
  if (document.subtitle) lines.push(document.subtitle);
  lines.push(renderKeyValues(document.meta, 'plain'));
  if (document.url) lines.push(`url\t${document.url}`);
  if (document.body) lines.push('', document.body.trim());

  for (const section of document.sections) {
    if (isEmptySection(section)) continue;
    lines.push('', section.heading);
    if (section.body) lines.push(section.body.trim());
    for (const entry of section.entries ?? []) {
      lines.push(`${entry.title}${entry.meta ? `\t${entry.meta}` : ''}`);
      if (entry.body) lines.push(entry.body.trim());
    }
    for (const row of section.table?.rows ?? []) lines.push(row.map(toText).join('\t'));
  }
  return lines.join('\n').trimEnd();
}

function isEmptySection(section: DocumentSection): boolean {
  return (
    !section.body &&
    (section.entries ?? []).length === 0 &&
    (section.table?.rows ?? []).length === 0
  );
}

/** Pads the cells of a section table so the columns line up in the terminal. */
function alignTable(
  columns: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string[] {
  const cells = rows.map((row) => row.map((cell) => toText(cell).replace(/\s+/g, ' ').trim()));
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...cells.map((row) => (row[index] ?? '').length)),
  );

  const line = (values: string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();

  return [dim(line(columns)), ...cells.map((row) => line(row))];
}

function indent(value: string, prefix: string): string {
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
