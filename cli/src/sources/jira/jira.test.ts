import { describe, expect, it } from 'vitest';

import { adfToMarkdown } from './adf.js';
import { mapChangelogEntry, mapWorkitem, parseSprintValue, simplifyFieldValue } from './map.js';
import type { JiraContext } from './map.js';
import { toJqlTimestamp } from './sync.js';

const CTX: JiraContext = {
  site: 'acme',
  projectKey: 'PLAT',
  baseUrl: 'https://acme.atlassian.net',
  fields: {
    customfield_10016: 'storyPoints',
    customfield_10020: 'sprint',
    customfield_10101: 'teamName',
  },
};
const SYNCED_AT = '2024-06-15T12:00:00.000Z';

describe('adfToMarkdown', () => {
  it('renders paragraphs, marks and links', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
            { type: 'text', text: ' see ' },
            {
              type: 'text',
              text: 'docs',
              marks: [{ type: 'link', attrs: { href: 'https://example.test' } }],
            },
          ],
        },
      ],
    };

    expect(adfToMarkdown(doc)).toBe('Hello **world** see [docs](https://example.test)');
  });

  it('renders headings, lists and code blocks', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Steps' }],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'bash' },
          content: [{ type: 'text', text: 'npm test' }],
        },
      ],
    };

    expect(adfToMarkdown(doc)).toBe('## Steps\n\n- first\n- second\n\n```bash\nnpm test\n```');
  });

  it('converts wiki markup from API v2 to markdown as well', () => {
    // Both Jira flavours reach the database as markdown; see wiki.test.ts.
    expect(adfToMarkdown('h1. Title')).toBe('# Title');
    expect(adfToMarkdown('')).toBeNull();
    expect(adfToMarkdown(null)).toBeNull();
  });
});

describe('mapWorkitem', () => {
  const raw = {
    id: '10001',
    key: 'PLAT-42',
    fields: {
      project: { key: 'PLAT' },
      summary: 'Improve the sync',
      description: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
      },
      issuetype: { name: 'Story' },
      status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
      priority: { name: 'High' },
      assignee: { displayName: 'Alice', accountId: 'a-1' },
      reporter: { displayName: 'Bob' },
      labels: ['backend', 'sync'],
      components: [{ name: 'API' }],
      fixVersions: [{ name: '2.1' }],
      created: '2024-01-01T10:00:00.000+0000',
      updated: '2024-02-01T10:00:00.000+0000',
      customfield_10016: 5,
      customfield_10020: [{ id: 33, name: 'Sprint 7' }],
      customfield_10101: { value: 'Platform' },
    },
  };

  it('maps the standard fields', () => {
    const row = mapWorkitem(raw, CTX, SYNCED_AT);

    expect(row.key).toBe('PLAT-42');
    expect(row.type).toBe('Story');
    expect(row.status).toBe('In Progress');
    expect(row.status_category).toBe('In Progress');
    expect(row.assignee).toBe('Alice');
    expect(row.description).toBe('Body');
    expect(row.labels).toBe('["backend","sync"]');
    expect(row.components).toBe('["API"]');
    expect(row.url).toBe('https://acme.atlassian.net/browse/PLAT-42');
  });

  it('maps the configured custom fields to friendly names', () => {
    const row = mapWorkitem(raw, CTX, SYNCED_AT);

    expect(row.story_points).toBe(5);
    expect(row.sprint_id).toBe(33);
    expect(row.sprint_name).toBe('Sprint 7');
    expect(JSON.parse(row.custom_fields as string)).toEqual({
      storyPoints: 5,
      sprint: ['Sprint 7'],
      teamName: 'Platform',
    });
  });
});

describe('parseSprintValue', () => {
  it('reads the modern object form and takes the newest sprint', () => {
    expect(
      parseSprintValue([
        { id: 1, name: 'Sprint 1' },
        { id: 2, name: 'Sprint 2' },
      ]),
    ).toEqual({
      id: 2,
      name: 'Sprint 2',
    });
  });

  it('reads the legacy string form', () => {
    expect(
      parseSprintValue(
        'com.atlassian.greenhopper.service.sprint.Sprint@1[id=42,name=Sprint 7,state=ACTIVE]',
      ),
    ).toEqual({ id: 42, name: 'Sprint 7' });
  });
});

describe('simplifyFieldValue', () => {
  it('reduces Jira objects to their readable value', () => {
    expect(simplifyFieldValue({ value: 'Platform' })).toBe('Platform');
    expect(simplifyFieldValue({ displayName: 'Alice' })).toBe('Alice');
    expect(simplifyFieldValue([{ name: 'a' }, { name: 'b' }])).toEqual(['a', 'b']);
    expect(simplifyFieldValue(7)).toBe(7);
    expect(simplifyFieldValue(null)).toBeNull();
  });
});

describe('mapChangelogEntry', () => {
  it('creates one row per changed field', () => {
    const rows = mapChangelogEntry(
      {
        id: '900',
        author: { displayName: 'Alice', accountId: 'a-1' },
        created: '2024-03-01T09:00:00.000+0000',
        items: [
          { field: 'status', fieldtype: 'jira', fromString: 'To Do', toString: 'In Progress' },
          { field: 'labels', fieldtype: 'jira', fromString: '', toString: 'backend' },
        ],
      },
      CTX,
      { id: '10001', key: 'PLAT-42' },
      SYNCED_AT,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.uid).toBe('900:0');
    expect(rows[0]?.field).toBe('status');
    expect(rows[0]?.from_string).toBe('To Do');
    expect(rows[0]?.to_string).toBe('In Progress');
    expect(rows[1]?.uid).toBe('900:1');
    expect(rows[1]?.field).toBe('labels');
  });
});

describe('toJqlTimestamp', () => {
  it('formats ISO timestamps the way JQL expects them', () => {
    expect(toJqlTimestamp('2024-06-15T12:34:56.000Z')).toBe('2024-06-15 12:34');
  });
});
