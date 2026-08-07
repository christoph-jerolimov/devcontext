import { arr, isObject, str } from '../../util/json.js';
import type { JsonObject } from '../../util/json.js';

/**
 * Converts Atlassian Document Format (the rich text format the Jira Cloud REST
 * API v3 returns) into markdown. Jira Server / API v2 returns wiki markup
 * strings, which are passed through unchanged.
 */
export function adfToMarkdown(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (!isObject(value)) return null;
  return renderNodes(arr(value, 'content')).trim() || null;
}

function renderNodes(nodes: unknown[], separator = '\n\n'): string {
  return nodes
    .map((node) => renderNode(node))
    .filter((text) => text !== '')
    .join(separator);
}

function renderNode(node: unknown): string {
  if (!isObject(node)) return '';
  const type = str(node, 'type') ?? '';
  const content = arr(node, 'content');

  switch (type) {
    case 'doc':
      return renderNodes(content);
    case 'paragraph':
      return renderInline(content);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(str(node, 'attrs', 'level') ?? '1')));
      return `${'#'.repeat(level)} ${renderInline(content)}`;
    }
    case 'bulletList':
      return renderList(content, () => '- ');
    case 'orderedList':
      return renderList(content, (index) => `${index + 1}. `);
    case 'listItem':
      return renderNodes(content, '\n');
    case 'taskList':
      return renderNodes(content, '\n');
    case 'taskItem': {
      const done = str(node, 'attrs', 'state') === 'DONE';
      return `- [${done ? 'x' : ' '}] ${renderInline(content)}`;
    }
    case 'codeBlock': {
      const language = str(node, 'attrs', 'language') ?? '';
      return `\`\`\`${language}\n${renderInline(content)}\n\`\`\``;
    }
    case 'blockquote':
      return renderNodes(content, '\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'panel':
      return renderNodes(content, '\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'rule':
      return '---';
    case 'table':
      return renderTable(content);
    case 'mediaGroup':
    case 'mediaSingle':
      return renderNodes(content, '\n');
    case 'media': {
      const alt = str(node, 'attrs', 'alt') ?? str(node, 'attrs', 'id') ?? 'attachment';
      return `![${alt}](attachment:${str(node, 'attrs', 'id') ?? ''})`;
    }
    case 'expand':
    case 'nestedExpand': {
      const title = str(node, 'attrs', 'title') ?? 'Details';
      return `**${title}**\n\n${renderNodes(content)}`;
    }
    default:
      return content.length > 0 ? renderInline(content) : (str(node, 'text') ?? '');
  }
}

function renderList(items: unknown[], bullet: (index: number) => string): string {
  return items
    .map((item, index) => {
      const text = renderNode(item);
      const prefix = bullet(index);
      return text
        .split('\n')
        .map((line, lineIndex) => (lineIndex === 0 ? `${prefix}${line}` : `  ${line}`))
        .join('\n');
    })
    .join('\n');
}

function renderTable(rows: unknown[]): string {
  const rendered: string[][] = rows.map((row) =>
    arr(row, 'content').map((cell) => renderNodes(arr(cell, 'content'), ' ').replace(/\n/g, ' ')),
  );
  if (rendered.length === 0) return '';
  const [header, ...body] = rendered as [string[], ...string[][]];
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function renderInline(nodes: unknown[]): string {
  return nodes.map((node) => renderInlineNode(node)).join('');
}

function renderInlineNode(node: unknown): string {
  if (!isObject(node)) return '';
  const type = str(node, 'type') ?? '';

  switch (type) {
    case 'text':
      return applyMarks(str(node, 'text') ?? '', node);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return `@${str(node, 'attrs', 'text')?.replace(/^@/, '') ?? str(node, 'attrs', 'id') ?? 'unknown'}`;
    case 'emoji':
      return str(node, 'attrs', 'text') ?? str(node, 'attrs', 'shortName') ?? '';
    case 'date':
      return str(node, 'attrs', 'timestamp') ?? '';
    case 'status':
      return `\`${str(node, 'attrs', 'text') ?? ''}\``;
    case 'inlineCard':
    case 'blockCard': {
      const url = str(node, 'attrs', 'url');
      return url ? `<${url}>` : '';
    }
    default:
      return renderNode(node);
  }
}

function applyMarks(text: string, node: JsonObject): string {
  let result = text;
  for (const mark of arr(node, 'marks')) {
    const type = str(mark, 'type');
    switch (type) {
      case 'strong':
        result = `**${result}**`;
        break;
      case 'em':
        result = `_${result}_`;
        break;
      case 'code':
        result = `\`${result}\``;
        break;
      case 'strike':
        result = `~~${result}~~`;
        break;
      case 'link': {
        const href = str(mark, 'attrs', 'href');
        if (href) result = `[${result}](${href})`;
        break;
      }
      default:
        break;
    }
  }
  return result;
}
