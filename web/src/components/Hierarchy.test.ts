import { describe, expect, it } from 'vitest';

import { flattenTree } from './Hierarchy.tsx';
import type { TreeNode, WorkitemTree } from '../api.ts';

function node(key: string, children: TreeNode[] = [], relation: TreeNode['relation'] = 'child') {
  return {
    key,
    summary: `summary of ${key}`,
    type: 'Story',
    status: 'To Do',
    statusCategory: 'To Do',
    assignee: null,
    storyPoints: null,
    resolvedAt: null,
    url: null,
    relation,
    depth: 0,
    children,
  } satisfies TreeNode;
}

function tree(root: TreeNode, ancestors: TreeNode[] = []): WorkitemTree {
  return {
    root,
    ancestors,
    all: [],
    summary: {
      total: 0,
      done: 0,
      storyPoints: 0,
      storyPointsDone: 0,
      byType: {},
      byStatusCategory: {},
    },
  };
}

describe('flattenTree', () => {
  it('puts the outermost ancestor first and indents down to the root', () => {
    /*
     * The API returns ancestors closest-first — PLAT-1's parent, then that
     * one's parent — because it walks upwards. Reading order is the opposite,
     * so the reversal is the whole point of this function.
     */
    const flat = flattenTree(
      tree(node('PLAT-1'), [node('PLAT-2', [], 'parent'), node('PLAT-3', [], 'parent')]),
    );

    expect(flat.map((row) => [row.node.key, row.indent])).toEqual([
      ['PLAT-3', 0],
      ['PLAT-2', 1],
      ['PLAT-1', 2],
    ]);
    expect(flat.map((row) => row.isRoot)).toEqual([false, false, true]);
  });

  it('walks children depth first, indenting each level', () => {
    const flat = flattenTree(
      tree(node('PLAT-1', [node('PLAT-2', [node('PLAT-4')]), node('PLAT-3')])),
    );

    expect(flat.map((row) => [row.node.key, row.indent])).toEqual([
      ['PLAT-1', 0],
      ['PLAT-2', 1],
      ['PLAT-4', 2],
      ['PLAT-3', 1],
    ]);
  });

  it('indents children below the root, not below the outermost ancestor', () => {
    // The bug this guards: numbering children from zero would put a child at
    // the same indent as the epic two levels above it.
    const flat = flattenTree(
      tree(node('PLAT-1', [node('PLAT-9')]), [node('PLAT-2', [], 'parent')]),
    );

    expect(flat.map((row) => [row.node.key, row.indent])).toEqual([
      ['PLAT-2', 0],
      ['PLAT-1', 1],
      ['PLAT-9', 2],
    ]);
  });

  it('marks the last sibling at each level', () => {
    const flat = flattenTree(tree(node('PLAT-1', [node('PLAT-2'), node('PLAT-3')])));

    expect(flat.map((row) => [row.node.key, row.isLast])).toEqual([
      ['PLAT-1', true],
      ['PLAT-2', false],
      ['PLAT-3', true],
    ]);
  });

  it('returns just the root when the item stands alone', () => {
    const flat = flattenTree(tree(node('PLAT-1')));
    expect(flat).toHaveLength(1);
    expect(flat[0]?.isRoot).toBe(true);
  });
});
