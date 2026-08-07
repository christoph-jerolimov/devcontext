import { describe as suite, expect, it } from 'vitest';

import { parseInline, parseMarkdown } from './parse.ts';
import type { Block, Inline } from './parse.ts';

/** Flattens a tree back to text, so assertions stay readable. */
function text(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.value;
        case 'code':
          return `\`${node.value}\``;
        case 'strong':
          return `**${text(node.children)}**`;
        case 'em':
          return `_${text(node.children)}_`;
        case 'del':
          return `~~${text(node.children)}~~`;
        case 'link':
          return `[${text(node.children)}](${node.href})`;
        case 'image':
          return `![${node.alt}](${node.src})`;
        case 'break':
          return '\\n';
        default:
          return '';
      }
    })
    .join('');
}

function first(input: string): Block {
  const [block] = parseMarkdown(input);
  if (!block) throw new Error('no block parsed');
  return block;
}

suite('block parsing', () => {
  it('parses headings', () => {
    const block = first('## Steps to reproduce');
    expect(block).toMatchObject({ type: 'heading', level: 2 });
    expect(text((block as { inline: Inline[] }).inline)).toBe('Steps to reproduce');
  });

  it('parses fenced code and keeps its content verbatim', () => {
    const block = first('```ts\nconst a = **not bold**;\n```');
    expect(block).toEqual({
      type: 'code',
      language: 'ts',
      text: 'const a = **not bold**;',
    });
  });

  it('parses a fence without a language', () => {
    expect(first('```\nplain\n```')).toMatchObject({ language: null, text: 'plain' });
  });

  it('joins the lines of a paragraph with a soft break', () => {
    const block = first('one\ntwo');
    expect(text((block as { inline: Inline[] }).inline)).toBe('one two');
  });

  it('parses a hard break', () => {
    const block = first('one  \ntwo');
    expect(text((block as { inline: Inline[] }).inline)).toBe('one\\ntwo');
  });

  it('parses blockquotes, including nested blocks', () => {
    const block = first('> ## Quoted\n> body');
    expect(block.type).toBe('quote');
    expect((block as { blocks: Block[] }).blocks.map((entry) => entry.type)).toEqual([
      'heading',
      'paragraph',
    ]);
  });

  it('parses thematic breaks but not a table divider', () => {
    expect(first('---').type).toBe('rule');
    expect(first('***').type).toBe('rule');
  });

  it('parses bullet lists', () => {
    const block = first('- one\n- two');
    expect(block).toMatchObject({ type: 'list', ordered: false });
    const items = (block as { items: Array<{ blocks: Block[] }> }).items;
    expect(items).toHaveLength(2);
    const firstItem = items[0] as { blocks: Block[] };
    expect(text((firstItem.blocks[0] as { inline: Inline[] }).inline)).toBe('one');
  });

  it('parses ordered lists and keeps the starting number', () => {
    expect(first('3. three\n4. four')).toMatchObject({ type: 'list', ordered: true, start: 3 });
  });

  it('parses nested lists', () => {
    const block = first('- outer\n  - inner');
    const items = (block as { items: Array<{ blocks: Block[] }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.blocks.map((entry) => entry.type)).toEqual(['paragraph', 'list']);
  });

  it('keeps a list with blank lines between its items together', () => {
    const blocks = parseMarkdown('- one\n\n- two');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('parses task lists', () => {
    const block = first('- [x] done\n- [ ] open');
    const items = (block as { items: Array<{ checked: boolean | null }> }).items;
    expect(items.map((item) => item.checked)).toEqual([true, false]);
  });

  it('parses pipe tables with alignment', () => {
    const block = first('| a | b |\n| --- | ---: |\n| 1 | 2 |');
    expect(block).toMatchObject({ type: 'table', align: [null, 'right'] });
    expect((block as { rows: Inline[][][] }).rows).toHaveLength(1);
  });

  it('does not treat a paragraph containing a pipe as a table', () => {
    expect(first('use a | b to pipe').type).toBe('paragraph');
  });

  it('separates blocks that follow each other without a blank line', () => {
    expect(parseMarkdown('text\n# Heading').map((block) => block.type)).toEqual([
      'paragraph',
      'heading',
    ]);
  });
});

suite('inline parsing', () => {
  it('parses emphasis', () => {
    expect(text(parseInline('**bold** and _italic_ and ~~gone~~'))).toBe(
      '**bold** and _italic_ and ~~gone~~',
    );
  });

  it('parses code spans and leaves their content alone', () => {
    expect(text(parseInline('use `a **b** c` here'))).toBe('use `a **b** c` here');
  });

  it('parses links, autolinks and bare urls', () => {
    expect(text(parseInline('[docs](https://example.test/a)'))).toBe(
      '[docs](https://example.test/a)',
    );
    expect(text(parseInline('<https://example.test>'))).toBe(
      '[https://example.test](https://example.test)',
    );
    expect(text(parseInline('see https://example.test/x now'))).toBe(
      'see [https://example.test/x](https://example.test/x) now',
    );
  });

  it('parses images', () => {
    expect(text(parseInline('![shot](https://example.test/a.png)'))).toBe(
      '![shot](https://example.test/a.png)',
    );
  });

  it('refuses a link whose scheme could run code', () => {
    // Rendered as the literal text instead of becoming a clickable link.
    const nodes = parseInline('[click](javascript:alert(1))');
    expect(nodes.every((node) => node.type === 'text')).toBe(true);
    expect(text(nodes)).toBe('[click](javascript:alert(1))');
  });

  it('keeps raw html as text', () => {
    const block = first('<img src=x onerror=alert(1)>');
    expect(block.type).toBe('paragraph');
    expect(text((block as { inline: Inline[] }).inline)).toBe('<img src=x onerror=alert(1)>');
  });

  it('leaves an unpaired marker alone', () => {
    expect(text(parseInline('2 * 3 * 4 and a_b_c'))).toBe('2 * 3 * 4 and a_b_c');
  });

  it('handles an empty string', () => {
    expect(parseInline('')).toEqual([]);
    expect(parseMarkdown('')).toEqual([]);
  });
});
