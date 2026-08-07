/**
 * A small GitHub flavoured markdown parser.
 *
 * It produces a tree that the renderer turns into React elements, so no HTML
 * string is ever built and nothing can be injected into the page: raw HTML in
 * a comment body is shown as the text it is. Jira content arrives as markdown
 * too — the CLI converts both Atlassian Document Format and wiki markup during
 * sync — so one parser covers both platforms.
 *
 * Supported: headings, fenced code, blockquotes, nested and task lists, pipe
 * tables, thematic breaks, paragraphs, and inline code, emphasis, strike
 * through, links, images, autolinks and hard breaks.
 */

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** `null` for a plain bullet, `true`/`false` for a task list checkbox. */
  checked: boolean | null;
  blocks: Block[];
}

export type Block =
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'code'; language: string | null; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { type: 'table'; header: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { type: 'rule' };

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'image'; src: string; alt: string }
  | { type: 'break' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

export function parseMarkdown(input: string): Block[] {
  return parseBlocks(input.replace(/\r\n?/g, '\n').split('\n'));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] as string;

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] as string;
        if (current.trimEnd().startsWith(marker) && current.trim().replace(/[`~]/g, '') === '') {
          index += 1;
          break;
        }
        body.push(current);
        index += 1;
      }
      blocks.push({ type: 'code', language: fence[2] || null, text: body.join('\n') });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: (heading[1] as string).length,
        inline: parseInline(heading[2] ?? ''),
      });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] as string)) {
        body.push(QUOTE.exec(lines[index] as string)?.[1] ?? '');
        index += 1;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(body) });
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    if (BULLET.test(line)) {
      const list = parseList(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] as string;
      if (
        current.trim() === '' ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        RULE.test(current) ||
        QUOTE.test(current) ||
        BULLET.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = BULLET.exec(lines[start] as string) as RegExpExecArray;
  const baseIndent = (first[1] as string).length;
  const ordered = /\d/.test(first[2] as string);
  const startNumber = ordered ? Number.parseInt(first[2] as string, 10) : 1;

  const items: ListItem[] = [];
  let index = start;
  let current: string[] | null = null;

  const flush = (): void => {
    if (current === null) return;
    const joined = current.join('\n');
    const task = TASK.exec(joined);
    const checked = task ? (task[1] as string).toLowerCase() === 'x' : null;
    items.push({
      checked,
      blocks: parseBlocks((task ? joined.replace(TASK, '$2') : joined).split('\n')),
    });
    current = null;
  };

  while (index < lines.length) {
    const line = lines[index] as string;
    const bullet = BULLET.exec(line);

    if (bullet && (bullet[1] as string).length <= baseIndent) {
      // A different marker at the same level starts a new list, not an item.
      if (items.length > 0 && /\d/.test(bullet[2] as string) !== ordered) break;
      flush();
      current = [bullet[3] as string];
      index += 1;
      continue;
    }

    if (current === null) break;

    // Blank lines and indented continuations belong to the item that is open.
    // A blank line before the next bullet keeps the list together (a "loose"
    // list) rather than starting a second one.
    if (line.trim() === '') {
      const next = lines[index + 1];
      if (next === undefined) break;
      const nextBullet = BULLET.exec(next);
      const continues =
        /^\s/.test(next) ||
        next.trim() === '' ||
        (nextBullet !== null && (nextBullet[1] as string).length <= baseIndent);
      if (!continues) break;
      current.push('');
      index += 1;
      continue;
    }
    if (!/^\s/.test(line)) break;
    current.push(line.slice(baseIndent + 2));
    index += 1;
  }

  flush();
  return { block: { type: 'list', ordered, start: startNumber, items }, next: index };
}

function parseTable(lines: string[], start: number): { block: Block; next: number } | null {
  const header = lines[start] as string;
  const divider = lines[start + 1];
  if (!header.includes('|') || divider === undefined) return null;
  if (!/^[\s|:-]+$/.test(divider) || !divider.includes('-') || !divider.includes('|')) return null;

  const align: Align[] = splitRow(divider).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });

  const columns = splitRow(header);
  if (columns.length !== align.length) return null;

  const rows: Inline[][][] = [];
  let index = start + 2;
  while (index < lines.length && (lines[index] as string).includes('|')) {
    if ((lines[index] as string).trim() === '') break;
    rows.push(splitRow(lines[index] as string).map((cell) => parseInline(cell)));
    index += 1;
  }

  return {
    block: { type: 'table', header: columns.map((cell) => parseInline(cell)), align, rows },
    next: index,
  };
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Only these schemes become links; anything else stays visible as text. */
function safeHref(href: string): string | null {
  const value = href.trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (value.startsWith('#') || value.startsWith('/')) return value;
  return null;
}

const INLINE =
  /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|<((?:https?|mailto):[^>\s]+)>|(\*\*|__)(?=\S)([\s\S]*?\S)\8|(\*|_)(?=\S)([\s\S]*?\S)\10|~~(?=\S)([\s\S]*?\S)~~|(https?:\/\/[^\s<>()[\]]+)|( {2,}\n|\\\n|\n)/;

export function parseInline(input: string): Inline[] {
  const nodes: Inline[] = [];
  let rest = input;

  const pushText = (value: string): void => {
    if (value === '') return;
    const last = nodes[nodes.length - 1];
    if (last?.type === 'text') last.value += value;
    else nodes.push({ type: 'text', value });
  };

  while (rest !== '') {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      pushText(rest);
      break;
    }

    pushText(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);

    const [
      ,
      ,
      codeText,
      imageAlt,
      imageSrc,
      linkText,
      linkHref,
      autolink,
      ,
      strongText,
      ,
      emText,
      delText,
      bareUrl,
      lineBreak,
    ] = match;

    if (codeText !== undefined) nodes.push({ type: 'code', value: codeText.trim() });
    else if (imageSrc !== undefined) {
      const src = safeHref(imageSrc);
      if (src) nodes.push({ type: 'image', src, alt: imageAlt ?? '' });
      else pushText(match[0]);
    } else if (linkHref !== undefined) {
      const href = safeHref(linkHref);
      if (href) nodes.push({ type: 'link', href, children: parseInline(linkText ?? '') });
      else pushText(match[0]);
    } else if (autolink !== undefined) {
      nodes.push({ type: 'link', href: autolink, children: [{ type: 'text', value: autolink }] });
    } else if (strongText !== undefined) {
      nodes.push({ type: 'strong', children: parseInline(strongText) });
    } else if (emText !== undefined) nodes.push({ type: 'em', children: parseInline(emText) });
    else if (delText !== undefined) nodes.push({ type: 'del', children: parseInline(delText) });
    else if (bareUrl !== undefined) {
      nodes.push({ type: 'link', href: bareUrl, children: [{ type: 'text', value: bareUrl }] });
    } else if (lineBreak !== undefined) {
      // A single newline inside a paragraph is a soft break, which renders as
      // a space; two trailing spaces or a backslash make it a hard break.
      if (lineBreak === '\n') pushText(' ');
      else nodes.push({ type: 'break' });
    }
  }

  return nodes;
}
