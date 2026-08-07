import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../database.js';
import { buildWorkitemTree, summariseTree } from './tree.js';
import type { TreeNode } from './tree.js';
import { renderTree } from '../../output/tree.js';

let db: Database;

function addWorkitem(key: string, fields: Record<string, unknown> = {}): void {
  db.upsert('jira_workitems', {
    site: 'acme',
    id: key,
    key,
    project_key: key.split('-')[0],
    summary: `Summary of ${key}`,
    labels: '[]',
    components: '[]',
    fix_versions: '[]',
    custom_fields: '{}',
    url: `https://acme.atlassian.net/browse/${key}`,
    synced_at: '2026-08-01T00:00:00.000Z',
    raw: '{}',
    ...fields,
  } as Record<string, never>);
}

function keysOf(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.key, ...keysOf(node.children)]);
}

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');

  //  PLAT-1 (Epic)
  //  ├─ PLAT-2 (Story, parent)      ── PLAT-4 (Sub-task)
  //  └─ PLAT-3 (Story, epic link)
  addWorkitem('PLAT-1', { type: 'Epic', status: 'In Progress', status_category: 'In Progress' });
  addWorkitem('PLAT-2', {
    type: 'Story',
    status: 'Done',
    status_category: 'Done',
    resolved_at: '2026-03-01T00:00:00.000Z',
    parent_key: 'PLAT-1',
    story_points: 5,
    assignee: 'Alice',
  });
  addWorkitem('PLAT-3', {
    type: 'Story',
    status: 'To Do',
    status_category: 'To Do',
    epic_key: 'PLAT-1',
    story_points: 3,
  });
  addWorkitem('PLAT-4', {
    type: 'Sub-task',
    status: 'Done',
    status_category: 'Done',
    parent_key: 'PLAT-2',
    story_points: 2,
  });
});

afterEach(() => db.close());

describe('buildWorkitemTree', () => {
  it('walks down through both parent links and epic links', () => {
    const tree = buildWorkitemTree(db, 'PLAT-1')!;

    expect(tree.root.key).toBe('PLAT-1');
    expect(keysOf(tree.root.children)).toEqual(['PLAT-2', 'PLAT-4', 'PLAT-3']);

    const [story] = tree.root.children;
    expect(story?.relation).toBe('child');
    expect(tree.root.children[1]?.relation).toBe('epic-child');
  });

  it('walks up to the parents of the requested item', () => {
    const tree = buildWorkitemTree(db, 'PLAT-4')!;

    expect(tree.root.key).toBe('PLAT-4');
    expect(tree.ancestors.map((node) => node.key)).toEqual(['PLAT-2', 'PLAT-1']);
    expect(tree.ancestors.map((node) => node.depth)).toEqual([-1, -2]);
  });

  it('can be told to skip the ancestors', () => {
    const tree = buildWorkitemTree(db, 'PLAT-4', { ancestors: false })!;
    expect(tree.ancestors).toEqual([]);
  });

  it('honours the depth limit', () => {
    const shallow = buildWorkitemTree(db, 'PLAT-1', { maxDepth: 1 })!;
    expect(keysOf(shallow.root.children)).toEqual(['PLAT-2', 'PLAT-3']);
  });

  it('survives a cycle instead of recursing forever', () => {
    // A misconfigured epic link can point back up the tree.
    addWorkitem('PLAT-4', { type: 'Sub-task', parent_key: 'PLAT-2', epic_key: 'PLAT-4' });
    addWorkitem('PLAT-2', { type: 'Story', parent_key: 'PLAT-1', epic_key: 'PLAT-4' });

    const tree = buildWorkitemTree(db, 'PLAT-1')!;
    expect(keysOf(tree.root.children)).toContain('PLAT-2');
    expect(new Set(keysOf(tree.root.children)).size).toBe(keysOf(tree.root.children).length);
  });

  it('does not list an item twice when it is both a subtask and an epic child', () => {
    addWorkitem('PLAT-3', { type: 'Story', parent_key: 'PLAT-1', epic_key: 'PLAT-1' });
    const tree = buildWorkitemTree(db, 'PLAT-1')!;
    expect(keysOf(tree.root.children).filter((key) => key === 'PLAT-3')).toHaveLength(1);
  });

  it('returns null for an unknown key', () => {
    expect(buildWorkitemTree(db, 'NOPE-1')).toBeNull();
  });

  it('attaches GitHub references when asked', () => {
    db.upsert('cross_links', {
      uid: 'acme/platform#42|PLAT-2|branch',
      from_source: 'github',
      from_kind: 'pull_request',
      from_ref: 'acme/platform#42',
      to_source: 'jira',
      to_kind: 'workitem',
      to_ref: 'PLAT-2',
      via: 'branch',
      detail: 'plat-2',
      confidence: 'high',
      synced_at: '2026-08-01T00:00:00.000Z',
    });

    const tree = buildWorkitemTree(db, 'PLAT-1', { withLinks: true })!;
    const story = tree.root.children.find((node) => node.key === 'PLAT-2');
    expect(story?.github).toEqual([
      { ref: 'acme/platform#42', kind: 'pull_request', via: 'branch' },
    ]);
  });
});

describe('summariseTree', () => {
  it('rolls up the root and everything below it', () => {
    const summary = summariseTree(buildWorkitemTree(db, 'PLAT-1')!);

    expect(summary.total).toBe(4);
    expect(summary.done).toBe(2);
    expect(summary.storyPoints).toBe(10);
    expect(summary.storyPointsDone).toBe(7);
    expect(summary.byType).toEqual({ Epic: 1, Story: 2, 'Sub-task': 1 });
  });

  it('ignores the ancestors, which are context only', () => {
    const summary = summariseTree(buildWorkitemTree(db, 'PLAT-4')!);
    expect(summary.total).toBe(1);
  });
});

describe('renderTree', () => {
  it('draws the hierarchy in the default format', () => {
    const tree = buildWorkitemTree(db, 'PLAT-1')!;
    const output = renderTree(tree, summariseTree(tree), { format: 'default', width: 200 });

    expect(output).toContain('PLAT-1');
    expect(output).toContain('├─ PLAT-2');
    expect(output).toContain('└─ PLAT-3');
    expect(output).toContain('(epic link)');
    expect(output).toContain('Done');
  });

  it('shows the ancestors above the requested item', () => {
    const tree = buildWorkitemTree(db, 'PLAT-4')!;
    const output = renderTree(tree, summariseTree(tree), { format: 'default', width: 200 });
    const lines = output.split('\n');

    expect(lines[0]).toContain('PLAT-1');
    expect(lines[1]).toContain('PLAT-2');
    expect(lines[2]).toContain('PLAT-4');
  });

  it('renders markdown checkboxes that reflect the status', () => {
    const tree = buildWorkitemTree(db, 'PLAT-1')!;
    const output = renderTree(tree, summariseTree(tree), { format: 'markdown' });

    expect(output).toContain('- [x] [PLAT-2]');
    expect(output).toContain('- [ ] [PLAT-3]');
  });

  it('emits one key per line for --list', () => {
    const tree = buildWorkitemTree(db, 'PLAT-1')!;
    const output = renderTree(tree, summariseTree(tree), { format: 'default', list: true });
    expect(output.split('\n')).toEqual(['PLAT-1', 'PLAT-2', 'PLAT-4', 'PLAT-3']);
  });

  it('returns the structure itself as json', () => {
    const tree = buildWorkitemTree(db, 'PLAT-1')!;
    const parsed = JSON.parse(renderTree(tree, summariseTree(tree), { format: 'json' })) as {
      root: TreeNode;
      summary: { total: number };
    };

    expect(parsed.root.key).toBe('PLAT-1');
    expect(parsed.summary.total).toBe(4);
  });
});
