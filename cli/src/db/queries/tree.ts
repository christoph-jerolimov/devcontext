import type { Database } from '../database.js';
import { githubRefsFor } from './links.js';
import { getWorkitem, listWorkitems } from './jira.js';
import type { WorkitemRow } from './jira.js';

export interface TreeNode {
  key: string;
  summary: string | null;
  type: string | null;
  status: string | null;
  statusCategory: string | null;
  assignee: string | null;
  storyPoints: number | null;
  resolvedAt: string | null;
  url: string | null;
  /** How this node hangs off its parent. */
  relation: 'parent' | 'self' | 'child' | 'epic-child';
  /** Depth relative to the requested item; ancestors are negative. */
  depth: number;
  children: TreeNode[];
  /** Pull requests and issues that reference this item, when asked for. */
  github?: Array<{ ref: string; kind: string; via: string }>;
}

export interface TreeOptions {
  /** How deep below the requested item to descend. */
  maxDepth?: number;
  /** Include the chain of parents above the requested item. */
  ancestors?: boolean;
  /** Attach linked GitHub references to every node. */
  withLinks?: boolean;
}

export interface WorkitemTree {
  /** The item that was asked for. */
  root: TreeNode;
  /** Parents above it, closest first. */
  ancestors: TreeNode[];
  /** Every node in the tree, including the root, for counting and summing. */
  all: TreeNode[];
}

function toNode(row: WorkitemRow, relation: TreeNode['relation'], depth: number): TreeNode {
  return {
    key: row.key,
    summary: row.summary,
    type: row.type,
    status: row.status,
    statusCategory: row.status_category,
    assignee: row.assignee,
    storyPoints: row.story_points,
    resolvedAt: row.resolved_at,
    url: row.url,
    relation,
    depth,
    children: [],
  };
}

/**
 * Children of a work item.
 *
 * Jira models the hierarchy two ways and both are in use: `parent` for
 * subtasks and for the modern team managed epic, and the epic link custom
 * field for the classic one. devcontext stores them as `parent_key` and
 * `epic_key`, and both are followed here.
 */
function childrenOf(db: Database, key: string): Array<{ row: WorkitemRow; viaEpic: boolean }> {
  const byParent = listWorkitems(db, { parent: key, sort: 'key', order: 'asc' });
  const byEpic = listWorkitems(db, { epic: key, sort: 'key', order: 'asc' });

  const seen = new Set(byParent.map((row) => row.key));
  return [
    ...byParent.map((row) => ({ row, viaEpic: false })),
    ...byEpic.filter((row) => !seen.has(row.key)).map((row) => ({ row, viaEpic: true })),
  ];
}

/**
 * Builds the tree around one work item: its ancestors, itself and everything
 * below it.
 */
export function buildWorkitemTree(
  db: Database,
  key: string,
  options: TreeOptions = {},
): WorkitemTree | null {
  const rootRow = getWorkitem(db, key);
  if (!rootRow) return null;

  const maxDepth = options.maxDepth ?? 5;
  const all: TreeNode[] = [];

  const root = toNode(rootRow, 'self', 0);
  all.push(root);

  // --- down ---------------------------------------------------------------
  const visited = new Set([rootRow.key]);

  const descend = (node: TreeNode, depth: number): void => {
    if (depth >= maxDepth) return;
    for (const { row, viaEpic } of childrenOf(db, node.key)) {
      // Jira allows a work item to be both a subtask and an epic child, and a
      // misconfigured field can even produce a cycle.
      if (visited.has(row.key)) continue;
      visited.add(row.key);

      const child = toNode(row, viaEpic ? 'epic-child' : 'child', depth + 1);
      node.children.push(child);
      all.push(child);
      descend(child, depth + 1);
    }
  };
  descend(root, 0);

  // --- up -----------------------------------------------------------------
  const ancestors: TreeNode[] = [];
  if (options.ancestors !== false) {
    let current: WorkitemRow | undefined = rootRow;
    let depth = 0;
    const seen = new Set([rootRow.key]);

    while (current) {
      const parentKey: string | null = current.parent_key ?? current.epic_key;
      if (!parentKey || seen.has(parentKey)) break;
      seen.add(parentKey);

      const parentRow: WorkitemRow | undefined = getWorkitem(db, parentKey);
      if (!parentRow) break;

      depth -= 1;
      const node = toNode(parentRow, 'parent', depth);
      ancestors.push(node);
      all.push(node);
      current = parentRow;
    }
  }

  if (options.withLinks) {
    for (const node of all) node.github = githubRefsFor(db, node.key);
  }

  return { root, ancestors, all };
}

export interface TreeSummary {
  total: number;
  done: number;
  storyPoints: number;
  storyPointsDone: number;
  byType: Record<string, number>;
  byStatusCategory: Record<string, number>;
}

/** Roll-up over the root and everything below it (ancestors are context only). */
export function summariseTree(tree: WorkitemTree): TreeSummary {
  const nodes = [tree.root, ...collect(tree.root.children)];
  const summary: TreeSummary = {
    total: nodes.length,
    done: 0,
    storyPoints: 0,
    storyPointsDone: 0,
    byType: {},
    byStatusCategory: {},
  };

  for (const node of nodes) {
    const done = node.statusCategory === 'Done' || node.resolvedAt !== null;
    if (done) summary.done += 1;

    const points = node.storyPoints ?? 0;
    summary.storyPoints += points;
    if (done) summary.storyPointsDone += points;

    const type = node.type ?? 'unknown';
    summary.byType[type] = (summary.byType[type] ?? 0) + 1;

    const category = node.statusCategory ?? 'unknown';
    summary.byStatusCategory[category] = (summary.byStatusCategory[category] ?? 0) + 1;
  }

  return summary;
}

function collect(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...collect(node.children)]);
}
