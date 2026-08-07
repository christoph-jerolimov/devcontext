import type { ReactNode } from 'react';

import { api } from '../api.ts';
import type { TreeNode, WorkitemTree } from '../api.ts';
import { Badge, StateMessage, useAsync } from './common.tsx';

export interface FlatNode {
  node: TreeNode;
  /** How far to indent, counted from the outermost ancestor. */
  indent: number;
  /** The item the tree was built for. */
  isRoot: boolean;
  /** Last among its siblings, which is what draws the corner instead of a tee. */
  isLast: boolean;
}

/**
 * Turns the tree into the rows to draw, outermost ancestor first.
 *
 * The API hands back two shapes — a list of ancestors climbing up from the
 * requested item, and children nested below it — and the sidebar wants one flat
 * ordered list. Ancestors arrive closest-first, so they are reversed to read
 * top down, and everything below the root is walked depth first.
 */
export function flattenTree(tree: WorkitemTree): FlatNode[] {
  const rows: FlatNode[] = [];

  const ancestors = [...tree.ancestors].toReversed();
  ancestors.forEach((node, index) => {
    rows.push({ node, indent: index, isRoot: false, isLast: true });
  });

  const rootIndent = ancestors.length;
  rows.push({ node: tree.root, indent: rootIndent, isRoot: true, isLast: true });

  const descend = (nodes: TreeNode[], indent: number): void => {
    nodes.forEach((node, index) => {
      rows.push({ node, indent, isRoot: false, isLast: index === nodes.length - 1 });
      descend(node.children, indent + 1);
    });
  };
  descend(tree.root.children, rootIndent + 1);

  return rows;
}

/** `epic-child` is a link through the classic epic field rather than a parent. */
function relationHint(node: TreeNode): string | null {
  return node.relation === 'epic-child' ? 'epic link' : null;
}

/**
 * The parents and children of one work item — the viewer's answer to
 * `devcontext jira tree PLAT-42`.
 *
 * It is rendered beside the open work item rather than as its own view,
 * because a tree needs a root: a separate page would have to reinvent the work
 * item list just to pick one.
 */
export function Hierarchy({
  workitemKey,
  onOpen,
}: {
  workitemKey: string;
  onOpen: (key: string) => void;
}): ReactNode {
  const { data, error, loading } = useAsync<WorkitemTree>(
    () => api.tree(workitemKey),
    [workitemKey],
  );

  // A work item with no parent and no children is the common case, and an
  // empty "Hierarchy" heading over a single row is noise.
  const alone = data !== null && data.ancestors.length === 0 && data.root.children.length === 0;

  if (loading || error) {
    return (
      <section>
        <h3>Hierarchy</h3>
        <StateMessage loading={loading} error={error} empty={false} emptyMessage="" />
      </section>
    );
  }
  if (!data || alone) return null;

  const rows = flattenTree(data);
  const { summary } = data;

  return (
    <section>
      <h3>Hierarchy ({summary.total})</h3>

      <p className="small muted tree-summary">
        {summary.done}/{summary.total} done
        {summary.storyPoints > 0
          ? ` · ${summary.storyPointsDone}/${summary.storyPoints} points`
          : ''}
      </p>

      <ul className="tree">
        {rows.map(({ node, indent, isRoot }) => (
          <li
            key={node.key}
            className={isRoot ? 'tree-node tree-node-self' : 'tree-node'}
            style={{ paddingLeft: `${String(indent * 1.1)}rem` }}
          >
            <button
              type="button"
              className="tree-key"
              onClick={() => onOpen(node.key)}
              aria-current={isRoot ? 'true' : undefined}
            >
              {node.key}
            </button>
            {/* The summary is the only part allowed to shrink: a truncated
                status or key would cost more than a truncated sentence. */}
            <span className="tree-text" title={`${node.type ?? ''} ${node.summary ?? ''}`.trim()}>
              {node.summary}
            </span>
            {relationHint(node) ? (
              <span className="tree-tag muted small">{relationHint(node)}</span>
            ) : null}
            <Badge
              value={node.status}
              kind={(node.statusCategory ?? '').toLowerCase().replace(/\W+/g, '-')}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
