import type { ReactNode } from 'react';
import { Fragment, createElement } from 'react';

import { parseMarkdown } from './parse.ts';
import type { Block, Inline, ListItem } from './parse.ts';

/*
 * The index is the right key throughout this file: the tree comes straight
 * from the parser, is rendered in one pass and never reordered or mutated, so
 * there is no identity to preserve across renders.
 */
/* oxlint-disable react/no-array-index-key */

/**
 * Renders markdown as React elements. Nothing is inserted as HTML, so a body
 * containing `<script>` or an `onerror=` attribute is displayed as the text it
 * is rather than executed.
 */
export function Markdown({ text }: { text: string | null | undefined }): ReactNode {
  if (!text || text.trim() === '') return null;
  return <div className="markdown">{renderBlocks(parseMarkdown(text))}</div>;
}

function renderBlocks(blocks: Block[]): ReactNode {
  return blocks.map((block, index) => <Fragment key={index}>{renderBlock(block)}</Fragment>);
}

function renderBlock(block: Block): ReactNode {
  switch (block.type) {
    case 'heading':
      return createElement(`h${block.level}`, null, renderInlines(block.inline));
    case 'paragraph':
      return <p>{renderInlines(block.inline)}</p>;
    case 'code':
      return (
        <pre className={block.language ? `language-${block.language}` : undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case 'quote':
      return <blockquote>{renderBlocks(block.blocks)}</blockquote>;
    case 'rule':
      return <hr />;
    case 'list':
      return renderList(block);
    case 'table':
      return (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} className={alignClass(block.align[index])}>
                    {renderInlines(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className={alignClass(block.align[cellIndex])}>
                      {renderInlines(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

function renderList(block: Block & { type: 'list' }): ReactNode {
  const items = block.items.map((item, index) => (
    <li key={index} className={item.checked === null ? undefined : 'task'}>
      {item.checked === null ? null : (
        <input type="checkbox" checked={item.checked} readOnly aria-hidden />
      )}
      {renderItem(item)}
    </li>
  ));

  return block.ordered ? (
    <ol start={block.start === 1 ? undefined : block.start}>{items}</ol>
  ) : (
    <ul>{items}</ul>
  );
}

/** A single paragraph inside a list item renders inline, so `- a` stays tight. */
function renderItem(item: ListItem): ReactNode {
  const [first, ...rest] = item.blocks;
  if (first?.type === 'paragraph') {
    return (
      <>
        {renderInlines(first.inline)}
        {renderBlocks(rest)}
      </>
    );
  }
  return renderBlocks(item.blocks);
}

function renderInlines(nodes: Inline[]): ReactNode {
  return nodes.map((node, index) => <Fragment key={index}>{renderInline(node)}</Fragment>);
}

function renderInline(node: Inline): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'code':
      return <code>{node.value}</code>;
    case 'strong':
      return <strong>{renderInlines(node.children)}</strong>;
    case 'em':
      return <em>{renderInlines(node.children)}</em>;
    case 'del':
      return <del>{renderInlines(node.children)}</del>;
    case 'link':
      return (
        <a href={node.href} target="_blank" rel="noreferrer noopener">
          {renderInlines(node.children)}
        </a>
      );
    case 'image':
      return <img src={node.src} alt={node.alt} loading="lazy" />;
    case 'break':
      return <br />;
    default:
      return null;
  }
}

function alignClass(align: 'left' | 'center' | 'right' | null | undefined): string | undefined {
  return align === 'right' ? 'right' : align === 'center' ? 'center' : undefined;
}
