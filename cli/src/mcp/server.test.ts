import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../config/load.js';
import type { ResolvedConfig } from '../config/types.js';
import { Database } from '../db/database.js';
import { nullLogger } from '../util/logger.js';
import { JSONRPC_VERSION, LineBuffer, PROTOCOL_VERSION } from './protocol.js';
import type { JsonRpcRequest } from './protocol.js';
import { McpServer } from './server.js';
import { TOOLS } from './tools.js';

let db: Database;
let server: McpServer;

const config: ResolvedConfig = parseConfig(
  `
projects:
  - key: demo
    github:
      - repo: acme/platform
`,
  { configPath: '/workspace/devcontext.yaml' },
);

/** Sends a request and returns the `result`, failing loudly on a JSON-RPC error. */
function call(method: string, params?: Record<string, unknown>, id: number | string = 1): unknown {
  const response = server.handle({ jsonrpc: JSONRPC_VERSION, id, method, params });
  if (response === null) throw new Error(`${method} unexpectedly returned no response`);
  if ('error' in response) throw new Error(`${method} failed: ${response.error.message}`);
  return response.result;
}

/** Calls a tool and parses the JSON out of its text content. */
function callTool(name: string, args: Record<string, unknown> = {}): unknown {
  const result = call('tools/call', { name, arguments: args }) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  // Surface the tool's own message rather than just "true !== false".
  if (result.isError === true) throw new Error(`${name} failed: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0]?.text ?? 'null');
}

function toolError(name: string, args: Record<string, unknown> = {}): string {
  const result = call('tools/call', { name, arguments: args }) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? '';
}

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
  const syncedAt = '2026-08-01T00:00:00.000Z';

  db.upsert('gh_repositories', {
    host: 'github.com',
    id: 7,
    owner: 'acme',
    name: 'platform',
    full_name: 'acme/platform',
    private: false,
    fork: false,
    archived: false,
    default_branch: 'main',
    synced_at: syncedAt,
    raw: '{}',
  });
  db.upsert('gh_issues', {
    host: 'github.com',
    id: 100,
    repo_id: 7,
    repo_full_name: 'acme/platform',
    number: 12,
    title: 'Sync is slow',
    body: 'It takes ages',
    state: 'open',
    author: 'alice',
    assignees: '["bob"]',
    labels: '["bug"]',
    is_pull_request: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    html_url: 'https://github.com/acme/platform/issues/12',
    synced_at: syncedAt,
    raw: '{}',
  });
  db.upsert('gh_comments', {
    host: 'github.com',
    id: 500,
    repo_id: 7,
    repo_full_name: 'acme/platform',
    issue_id: 100,
    issue_number: 12,
    author: 'bob',
    body: 'Confirmed',
    created_at: '2026-01-05T00:00:00Z',
    synced_at: syncedAt,
    raw: '{}',
  });
  db.upsert('gh_pull_requests', {
    host: 'github.com',
    id: 200,
    repo_id: 7,
    repo_full_name: 'acme/platform',
    number: 42,
    title: 'Speed up the sync',
    state: 'closed',
    merged: true,
    author: 'alice',
    assignees: '[]',
    requested_reviewers: '[]',
    labels: '[]',
    head_ref: 'feature/speed',
    base_ref: 'main',
    additions: 40,
    deletions: 12,
    updated_at: '2026-03-01T00:00:00Z',
    merged_at: '2026-03-01T00:00:00Z',
    synced_at: syncedAt,
    raw: '{}',
  });
  db.upsert('jira_workitems', {
    site: 'acme',
    id: '10001',
    key: 'PLAT-42',
    project_key: 'PLAT',
    summary: 'Improve the sync',
    description: 'Body text',
    type: 'Story',
    status: 'In Progress',
    status_category: 'In Progress',
    assignee: 'Alice',
    labels: '["backend"]',
    components: '[]',
    fix_versions: '[]',
    story_points: 5,
    updated_at: '2026-02-01T00:00:00.000Z',
    custom_fields: '{}',
    url: 'https://acme.atlassian.net/browse/PLAT-42',
    synced_at: syncedAt,
    raw: '{}',
  });
  db.upsert('jira_comments', {
    site: 'acme',
    id: '1',
    workitem_id: '10001',
    workitem_key: 'PLAT-42',
    author: 'Bob',
    body: 'The rate limit is the problem',
    created_at: '2026-01-10T00:00:00.000Z',
    synced_at: syncedAt,
    raw: '{}',
  });

  server = new McpServer({ db, config, logger: nullLogger });
});

afterEach(() => db.close());

describe('protocol', () => {
  it('answers initialize with capabilities and server info', () => {
    const result = call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    }) as Record<string, unknown>;

    expect(result['protocolVersion']).toBe(PROTOCOL_VERSION);
    expect(result['capabilities']).toEqual({ tools: { listChanged: false } });
    expect((result['serverInfo'] as { name: string }).name).toBe('devcontext');
    expect(String(result['instructions'])).toContain('devcontext_status');
  });

  it('echoes an older protocol revision the client asked for', () => {
    const result = call('initialize', { protocolVersion: '2024-11-05' }) as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2024-11-05');
  });

  it('offers its own revision when the client asks for an unknown one', () => {
    const result = call('initialize', { protocolVersion: '1999-01-01' }) as Record<string, unknown>;
    expect(result['protocolVersion']).toBe(PROTOCOL_VERSION);
  });

  it('treats notifications as fire and forget', () => {
    const response = server.handle({
      jsonrpc: JSONRPC_VERSION,
      method: 'notifications/initialized',
    } as JsonRpcRequest);

    expect(response).toBeNull();
    expect(server.isInitialized).toBe(true);
  });

  it('answers ping', () => {
    expect(call('ping')).toEqual({});
  });

  it('rejects unknown methods with -32601', () => {
    const response = server.handle({ jsonrpc: JSONRPC_VERSION, id: 9, method: 'nope/nope' });
    expect(response && 'error' in response && response.error.code).toBe(-32601);
  });

  it('rejects a wrong jsonrpc version', () => {
    const response = server.handle({ jsonrpc: '1.0', id: 3, method: 'ping' });
    expect(response && 'error' in response && response.error.code).toBe(-32600);
  });

  it('keeps the request id, including string ids', () => {
    const response = server.handle({ jsonrpc: JSONRPC_VERSION, id: 'abc', method: 'ping' });
    expect(response?.id).toBe('abc');
  });
});

describe('tools/list', () => {
  it('lists every tool with a usable schema', () => {
    const result = call('tools/list') as { tools: Array<Record<string, unknown>> };

    expect(result.tools).toHaveLength(TOOLS.length);
    for (const tool of result.tools) {
      expect(typeof tool['name']).toBe('string');
      expect(String(tool['description']).length).toBeGreaterThan(20);
      const schema = tool['inputSchema'] as { type: string; properties: unknown };
      expect(schema.type).toBe('object');
      expect(typeof schema.properties).toBe('object');
    }
  });

  it('exposes the tools an assistant needs to get from search to detail', () => {
    const names = (call('tools/list') as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );

    expect(names).toEqual(
      expect.arrayContaining([
        'devcontext_status',
        'search',
        'list_issues',
        'get_issue',
        'list_pull_requests',
        'get_pull_request',
        'list_workitems',
        'get_workitem',
      ]),
    );
  });
});

describe('tools/call', () => {
  it('reports what is in the database', () => {
    const status = callTool('devcontext_status') as Record<string, Record<string, number>>;
    expect(status['github']?.['issues']).toBe(1);
    expect(status['jira']?.['workitems']).toBe(1);
  });

  it('searches across both sources, including Jira comments', () => {
    const all = callTool('search', { query: 'sync' }) as { results: Array<{ kind: string }> };
    expect(all.results.map((entry) => entry.kind).toSorted()).toEqual([
      'github-issue',
      'github-pull-request',
      'jira-workitem',
    ]);

    const jiraOnly = callTool('search', { query: 'rate limit' }) as {
      results: Array<{ kind: string; key?: string }>;
    };
    expect(jiraOnly.results).toEqual([
      expect.objectContaining({ kind: 'jira-workitem', key: 'PLAT-42' }),
    ]);

    const scoped = callTool('search', { query: 'sync', sources: ['jira'] }) as {
      results: Array<{ kind: string }>;
    };
    expect(scoped.results.every((entry) => entry.kind === 'jira-workitem')).toBe(true);
  });

  it('returns an issue with its comments and timeline', () => {
    const issue = callTool('get_issue', { repo: 'acme/platform', number: 12 }) as {
      title: string;
      comments: unknown[];
    };
    expect(issue.title).toBe('Sync is slow');
    expect(issue.comments).toHaveLength(1);
  });

  it('returns a work item with its comments', () => {
    const workitem = callTool('get_workitem', { key: 'plat-42' }) as {
      key: string;
      comments: unknown[];
    };
    expect(workitem.key).toBe('PLAT-42');
    expect(workitem.comments).toHaveLength(1);
  });

  it('filters issues, and understands relative times', () => {
    expect(callTool('list_issues', { state: 'open' })).toHaveLength(1);
    expect(callTool('list_issues', { state: 'open', labels: ['nope'] })).toHaveLength(0);
    // The fixture was last updated in early 2026, so it counts as stale.
    expect(callTool('list_issues', { state: 'all', updatedBefore: '1d' })).toHaveLength(1);
    expect(callTool('list_issues', { state: 'all', updatedSince: '1d' })).toHaveLength(0);
  });

  it('lists pull requests with the merged flag applied', () => {
    expect(callTool('list_pull_requests', { state: 'all' })).toHaveLength(1);
    expect(callTool('list_pull_requests', { state: 'all', merged: false })).toHaveLength(0);
  });

  it('caps the limit instead of letting a model ask for everything', () => {
    for (let index = 0; index < 5; index += 1) {
      db.upsert('jira_workitems', {
        site: 'acme',
        id: `2000${index}`,
        key: `PLAT-${100 + index}`,
        project_key: 'PLAT',
        summary: `Extra ${index}`,
        labels: '[]',
        components: '[]',
        fix_versions: '[]',
        custom_fields: '{}',
        updated_at: '2026-02-01T00:00:00.000Z',
        synced_at: '2026-08-01T00:00:00.000Z',
        raw: '{}',
      });
    }
    expect(callTool('list_workitems', { limit: 2 })).toHaveLength(2);
    expect(callTool('list_workitems', { limit: 100_000 })).toHaveLength(6);
  });

  it('reports a bad argument as a tool error the model can read', () => {
    expect(toolError('get_issue', { repo: 'acme/platform' })).toMatch(/"number" is required/);
    expect(toolError('get_issue', { repo: 'acme/platform', number: 999 })).toMatch(/No issue/);
    expect(toolError('get_workitem', { key: 'NOPE-1' })).toMatch(/No work item/);
    expect(toolError('nonexistent_tool')).toMatch(/Unknown tool/);
  });

  it('does not turn a tool failure into a protocol error', () => {
    const response = server.handle({
      jsonrpc: JSONRPC_VERSION,
      id: 5,
      method: 'tools/call',
      params: { name: 'get_issue', arguments: {} },
    });
    expect(response && 'result' in response).toBe(true);
  });
});

describe('LineBuffer', () => {
  it('splits newline delimited JSON and keeps partial lines', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(buffer.push('2}\n')).toEqual(['{"b":2}']);
    expect(buffer.push('\n  \n')).toEqual([]);
  });
});
