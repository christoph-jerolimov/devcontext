import { describe, expect, it } from 'vitest';

import { parseOutputFormat, renderKeyValues, renderTable, truncate } from './format.js';
import type { Column } from './format.js';
import { renderDocument } from './document.js';

interface Row {
  key: string;
  count: number;
}

const ROWS: Row[] = [
  { key: 'PLAT-1', count: 3 },
  { key: 'PLAT-22', count: 11 },
];

const COLUMNS: Column<Row>[] = [
  { header: 'KEY', value: (row) => row.key },
  { header: 'COUNT', value: (row) => row.count, align: 'right' },
];

describe('renderTable', () => {
  it('aligns the default output', () => {
    const output = renderTable(ROWS, COLUMNS, { format: 'default', width: 80 });
    expect(output.split('\n')).toEqual(['KEY      COUNT', 'PLAT-1       3', 'PLAT-22     11']);
  });

  it('renders a markdown table', () => {
    const output = renderTable(ROWS, COLUMNS, { format: 'markdown', title: 'Items' });
    expect(output.split('\n')).toEqual([
      '## Items',
      '',
      '| KEY | COUNT |',
      '| --- | ---: |',
      '| PLAT-1 | 3 |',
      '| PLAT-22 | 11 |',
    ]);
  });

  it('renders tab separated plain output without a header', () => {
    expect(renderTable(ROWS, COLUMNS, { format: 'plain' })).toBe('PLAT-1\t3\nPLAT-22\t11');
  });

  it('renders json from the underlying rows', () => {
    expect(JSON.parse(renderTable(ROWS, COLUMNS, { format: 'json' }))).toEqual(ROWS);
  });

  it('prints one identifier per line for --list', () => {
    const output = renderTable(ROWS, COLUMNS, {
      format: 'default',
      list: true,
      listValue: (row) => row.key,
    });
    expect(output).toBe('PLAT-1\nPLAT-22');
  });

  it('reports an empty result set', () => {
    expect(renderTable([], COLUMNS, { format: 'default', emptyMessage: 'nothing here' })).toBe(
      'nothing here',
    );
    expect(renderTable([], COLUMNS, { format: 'plain' })).toBe('');
    expect(renderTable([], COLUMNS, { format: 'json' })).toBe('[]');
  });

  it('drops optional columns when the terminal is narrow', () => {
    const columns: Column<Row>[] = [
      { header: 'KEY', value: (row) => row.key },
      { header: 'COUNT', value: (row) => row.count, optional: true },
    ];
    const output = renderTable(ROWS, columns, { format: 'default', width: 10 });
    expect(output.split('\n')[0]).toBe('KEY');
  });
});

describe('renderKeyValues', () => {
  it('skips empty values', () => {
    const output = renderKeyValues(
      [
        ['Author', 'alice'],
        ['Milestone', null],
        ['Comments', 0],
      ],
      'plain',
    );
    expect(output).toBe('Author\talice\nComments\t0');
  });
});

describe('renderDocument', () => {
  const document = {
    title: 'acme/platform#12 Sync is slow',
    subtitle: 'open',
    url: 'https://github.com/acme/platform/issues/12',
    meta: [['Author', 'alice'] as [string, string]],
    body: 'It takes ages',
    sections: [
      {
        heading: 'Comments (1)',
        entries: [{ title: 'bob', meta: '2024-01-05', body: 'Confirmed' }],
      },
      { heading: 'Timeline (0)', table: { columns: ['When'], rows: [] } },
    ],
    data: { number: 12 },
  };

  it('renders markdown with headings for every section', () => {
    const output = renderDocument(document, 'markdown');
    expect(output).toContain('# acme/platform#12 Sync is slow');
    expect(output).toContain('- **Author**: alice');
    expect(output).toContain('## Comments (1)');
    expect(output).toContain('### bob');
    // Empty sections are skipped.
    expect(output).not.toContain('Timeline');
  });

  it('returns the structured data for json', () => {
    expect(JSON.parse(renderDocument(document, 'json'))).toEqual({ number: 12 });
  });
});

describe('helpers', () => {
  it('parses output formats and rejects unknown ones', () => {
    expect(parseOutputFormat(undefined)).toBe('default');
    expect(parseOutputFormat('JSON')).toBe('json');
    expect(() => parseOutputFormat('xml')).toThrow(/Unknown output format/);
  });

  it('truncates long single line text', () => {
    expect(truncate('a very long sentence', 10)).toBe('a very lo…');
    expect(truncate('multi\nline  text', 40)).toBe('multi line text');
    expect(truncate(null, 10)).toBe('');
  });
});
