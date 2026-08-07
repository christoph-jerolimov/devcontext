import type { TreeNode, TreeSummary, WorkitemTree } from '../db/queries/tree.js';
import { bold, dim, renderKeyValues, toText, truncate } from './format.js';
import type { OutputFormat } from './format.js';

export interface RenderTreeOptions {
  format: OutputFormat;
  /** `--list`: one key per line, for shell scripts. */
  list?: boolean;
  width?: number;
}

/**
 * Renders a work item tree.
 *
 * The default and markdown forms draw the usual box characters; plain uses
 * indentation with tabs so `cut` and `awk` still work, and json returns the
 * structure itself.
 */
export function renderTree(
  tree: WorkitemTree,
  summary: TreeSummary,
  options: RenderTreeOptions,
): string {
  if (options.list) {
    return [...tree.ancestors, tree.root, ...descendants(tree.root)]
      .map((node) => node.key)
      .join('\n');
  }

  switch (options.format) {
    case 'json':
      return JSON.stringify({ ...tree, summary }, null, 2);
    case 'markdown':
      return renderMarkdown(tree, summary);
    case 'plain':
      return renderPlain(tree);
    case 'default':
    default:
      return renderDefault(tree, summary, options.width);
  }
}

function descendants(node: TreeNode): TreeNode[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function label(node: TreeNode): string {
  const parts = [node.key];
  if (node.type) parts.push(`(${node.type})`);
  return parts.join(' ');
}

function statusOf(node: TreeNode): string {
  const done = node.statusCategory === 'Done' || node.resolvedAt !== null;
  return `${done ? '✓' : '·'} ${node.status ?? ''}`.trim();
}

function renderDefault(tree: WorkitemTree, summary: TreeSummary, width = 120): string {
  const lines: string[] = [];

  // Ancestors are printed innermost last, so the root sits at the bottom.
  for (const [index, ancestor] of tree.ancestors.toReversed().entries()) {
    lines.push(
      `${'  '.repeat(index)}${dim(`${label(ancestor)} — ${truncate(ancestor.summary, 60)}`)}`,
    );
  }

  const rootIndent = '  '.repeat(tree.ancestors.length);
  lines.push(
    `${rootIndent}${bold(label(tree.root))} ${truncate(tree.root.summary, 60)}  ${dim(statusOf(tree.root))}`,
  );

  const walk = (node: TreeNode, prefix: string): void => {
    node.children.forEach((child, index) => {
      const last = index === node.children.length - 1;
      const branch = last ? '└─ ' : '├─ ';
      const line =
        `${prefix}${branch}${label(child)} ${truncate(child.summary, 50)}` +
        `  ${statusOf(child)}` +
        (child.assignee ? `  ${child.assignee}` : '') +
        (child.storyPoints ? `  ${child.storyPoints}sp` : '') +
        (child.relation === 'epic-child' ? '  (epic link)' : '');
      lines.push(line.length > width ? `${line.slice(0, width - 1)}…` : line);
      walk(child, `${prefix}${last ? '   ' : '│  '}`);
    });
  };
  walk(tree.root, `${rootIndent}`);

  lines.push('');
  lines.push(
    renderKeyValues(
      [
        ['Items', summary.total],
        ['Done', `${summary.done}/${summary.total}`],
        [
          'Story points',
          summary.storyPoints ? `${summary.storyPointsDone}/${summary.storyPoints}` : null,
        ],
        [
          'Types',
          Object.entries(summary.byType)
            .map(([type, count]) => `${type} ${count}`)
            .join(', '),
        ],
      ],
      'default',
    ),
  );

  return lines.join('\n');
}

function renderMarkdown(tree: WorkitemTree, summary: TreeSummary): string {
  const lines: string[] = [`# ${tree.root.key} ${tree.root.summary ?? ''}`.trim(), ''];

  if (tree.ancestors.length > 0) {
    lines.push(
      `_In: ${tree.ancestors
        .toReversed()
        .map((node) => `${node.key} (${node.type ?? ''})`.trim())
        .join(' › ')}_`,
      '',
    );
  }

  const walk = (node: TreeNode, depth: number): void => {
    for (const child of node.children) {
      const done = child.statusCategory === 'Done' || child.resolvedAt !== null;
      const bits = [
        `${'  '.repeat(depth)}- [${done ? 'x' : ' '}]`,
        child.url ? `[${child.key}](${child.url})` : child.key,
        child.summary ?? '',
      ];
      if (child.status) bits.push(`— ${child.status}`);
      if (child.assignee) bits.push(`· ${child.assignee}`);
      if (child.storyPoints) bits.push(`· ${child.storyPoints} points`);
      lines.push(bits.join(' '));
      walk(child, depth + 1);
    }
  };
  walk(tree.root, 0);

  lines.push('', '## Summary', '');
  lines.push(
    renderKeyValues(
      [
        ['Items', summary.total],
        ['Done', `${summary.done}/${summary.total}`],
        [
          'Story points',
          summary.storyPoints ? `${summary.storyPointsDone}/${summary.storyPoints}` : null,
        ],
      ],
      'markdown',
    ),
  );

  return `${lines.join('\n')}\n`;
}

function renderPlain(tree: WorkitemTree): string {
  const lines: string[] = [];
  const emit = (node: TreeNode, depth: number): void => {
    lines.push(
      [
        '  '.repeat(Math.max(0, depth)),
        node.key,
        toText(node.type),
        toText(node.status),
        toText(node.assignee),
        toText(node.storyPoints),
        toText(node.summary),
      ].join('\t'),
    );
    for (const child of node.children) emit(child, depth + 1);
  };

  for (const [index, ancestor] of tree.ancestors.toReversed().entries()) {
    lines.push(
      [
        `${'  '.repeat(index)}`,
        ancestor.key,
        toText(ancestor.type),
        '',
        '',
        '',
        toText(ancestor.summary),
      ].join('\t'),
    );
  }
  emit(tree.root, tree.ancestors.length);
  return lines.join('\n');
}
