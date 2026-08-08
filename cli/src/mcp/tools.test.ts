/**
 * The MCP surface against a real database.
 *
 * These are the tools an assistant sees, and the failure they exist to catch is
 * silence: a tool that is missing, or one whose filter quietly matches
 * everything, produces a confident answer that nobody can tell is wrong.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../config/load.js';
import type { ResolvedConfig } from '../config/types.js';
import { Database } from '../db/database.js';
import { buildStateHistory } from '../history/build.js';
import { TOOLS_BY_NAME } from './tools.js';

const CONFIG_YAML = `
me: grace
people:
  - id: grace
    name: Grace Hopper
    github: [ghopper]
    jira: ['Grace Hopper']
  - id: ada
    name: Ada Lovelace
    github: [ada]
bots:
  - id: triage
    github: ['stale[bot]']
teams:
  - id: platform
    name: Platform
    members: [grace, ada]
projects:
  - key: platform
    github:
      - repo: acme/platform
`;

let db: Database;
let config: ResolvedConfig;

function call(name: string, args: Record<string, unknown> = {}): unknown {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`No tool called ${name}`);
  return tool.run(args, { db, config });
}

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
  config = parseConfig(CONFIG_YAML, { configPath: '/w/devcontext.yaml' });

  db.upsert('gh_issues', {
    host: 'github.com',
    id: 1,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: 1,
    title: 'Sync stalls',
    state: 'open',
    author: 'ghopper',
    assignees: '[]',
    is_pull_request: 0,
    created_at: '2024-03-01T09:00:00Z',
    updated_at: '2024-03-01T09:00:00Z',
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
  db.upsert('gh_comments', {
    host: 'github.com',
    id: 10,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    issue_id: 1,
    issue_number: 1,
    author: 'stale[bot]',
    body: 'This has gone stale',
    created_at: '2024-03-02T09:00:00Z',
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
  db.upsert('jira_workitems', {
    site: 'acme',
    id: 'PLAT-1',
    key: 'PLAT-1',
    project_key: 'PLAT',
    summary: 'Respect the rate limit',
    type: 'Story',
    status: 'In Progress',
    status_category: 'In Progress',
    reporter: 'Grace Hopper',
    assignee: 'Grace Hopper',
    created_at: '2024-03-01T10:00:00Z',
    updated_at: '2024-03-01T10:00:00Z',
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
  buildStateHistory(db);
});

afterEach(() => {
  db.close();
});

describe('the tools an assistant is offered', () => {
  it('covers every surface the CLI and the viewer have', () => {
    /*
     * The failure this guards is drift: five features shipped with a command,
     * an endpoint and a page, and nothing here — so an assistant answered from
     * whatever it could still reach, and looked no less confident for it.
     */
    for (const name of [
      'list_tickets',
      'ticket_types',
      'list_activity',
      'activity_by_person',
      'list_people',
      'open_items_history',
      'sprint_burndown',
      'sprint_velocity',
      'status_times',
      'cumulative_flow',
      'insights',
      'digest',
    ]) {
      expect([name, TOOLS_BY_NAME.has(name)]).toEqual([name, true]);
    }
  });

  it('has a matching bridge file in the eve agent for every one of them', () => {
    /*
     * The eve agent is one file per tool, and nothing at runtime notices when a
     * tool is added here and not there — the agent simply cannot answer the
     * question, with no error to say why. That is how it fell twelve behind.
     */
    const dir = fileURLToPath(new URL('../../../eve/agent/tools/', import.meta.url));
    const bridged = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => file.slice(0, -'.ts'.length));

    expect(bridged.toSorted()).toEqual([...TOOLS_BY_NAME.keys()].toSorted());
  });

  it('gives every tool a description an assistant can choose from', () => {
    for (const tool of TOOLS_BY_NAME.values()) {
      expect([tool.definition.name, (tool.definition.description ?? '').length > 40]).toEqual([
        tool.definition.name,
        true,
      ]);
    }
  });
});

describe('list_tickets', () => {
  it('merges both trackers into one list', () => {
    const result = call('list_tickets') as { tickets: Array<{ ref: string }>; total: number };

    expect(result.tickets.map((ticket) => ticket.ref).toSorted()).toEqual([
      'PLAT-1',
      'acme/platform#1',
    ]);
    expect(result.total).toBe(2);
  });

  it('filters by a person across both sources at once', () => {
    const result = call('list_tickets', { person: ['grace'] }) as {
      tickets: Array<{ ref: string }>;
    };

    expect(result.tickets.map((ticket) => ticket.ref).toSorted()).toEqual([
      'PLAT-1',
      'acme/platform#1',
    ]);
  });

  it('keeps a GitHub-only person out of the Jira half', () => {
    // The rule the whole people layer rests on: no identity on a source means
    // no rows there, rather than every row there.
    const result = call('list_tickets', { person: ['ada'] }) as { tickets: unknown[] };

    expect(result.tickets).toEqual([]);
  });

  it('refuses a person nobody configured', () => {
    expect(() => call('list_tickets', { person: ['nobody'] })).toThrow(/Unknown person/);
  });

  it('resolves me to whoever the configuration names', () => {
    const result = call('list_tickets', { person: ['me'] }) as { tickets: Array<{ ref: string }> };

    expect(result.tickets.map((ticket) => ticket.ref).toSorted()).toEqual([
      'PLAT-1',
      'acme/platform#1',
    ]);
  });
});

describe('list_activity', () => {
  it('names the person behind a login, so an answer can use it', () => {
    const result = call('list_activity', { since: '2020-01-01' }) as {
      events: Array<{ actor: string | null; person: string | null }>;
    };

    const opened = result.events.find((event) => event.actor === 'ghopper');
    expect(opened?.person).toBe('Grace Hopper');
  });

  it('hides the bots when asked', () => {
    const result = call('list_activity', { since: '2020-01-01', bots: 'exclude' }) as {
      events: Array<{ actor: string | null }>;
    };

    expect(result.events.map((event) => event.actor)).not.toContain('stale[bot]');
  });
});

describe('list_people', () => {
  it('gives the ids the other tools take, and says which one is me', () => {
    const result = call('list_people') as {
      me: string | null;
      people: Array<{ id: string }>;
      teams: Array<{ id: string; people: string[] }>;
    };

    expect(result.me).toBe('grace');
    expect(result.people.map((person) => person.id)).toEqual(['grace', 'ada', 'triage']);
    expect(result.teams[0]?.people).toEqual(['Grace Hopper', 'Ada Lovelace']);
  });
});

describe('the reports', () => {
  it('answers the history question the other tools cannot', () => {
    const result = call('open_items_history', { from: '2024-03-01', to: '2024-03-03' }) as {
      days: Array<{ day: string; open: number }>;
    };

    expect(result.days).toHaveLength(3);
    expect(result.days[0]?.open).toBe(2);
  });

  it('refuses a sprint that does not exist rather than returning nothing', () => {
    expect(() => call('sprint_burndown', { sprint: 999 })).toThrow(/No sprint 999/);
  });

  it('tells a backlog apart from a review queue, which the open count cannot', () => {
    const result = call('cumulative_flow', { from: '2024-03-01', to: '2024-03-02' }) as {
      days: Array<{ counts: Record<string, number> }>;
    };

    expect(result.days[0]?.counts).toEqual({ 'In Progress': 1 });
  });

  it('runs the standing reports without a sprint or a person', () => {
    expect(call('insights', { section: 'wip' })).toBeDefined();
    expect(call('digest', { since: '2020-01-01' })).toBeDefined();
    expect(call('status_times')).toBeDefined();
    expect(call('sprint_velocity')).toBeDefined();
  });
});
