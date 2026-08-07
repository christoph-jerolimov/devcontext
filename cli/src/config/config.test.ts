import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { expandEnv, parseConfig } from './load.js';
import { EXAMPLE_CONFIG } from './example.js';

const CONFIG_PATH = '/workspace/devcontext.yaml';

describe('parseConfig', () => {
  it('applies defaults and resolves paths relative to the config file', () => {
    const config = parseConfig(
      `
projects:
  - key: demo
    github:
      - repo: acme/platform
`,
      { configPath: CONFIG_PATH },
    );

    expect(config.databasePath).toBe('/workspace/.devcontext/devcontext.db');
    expect(config.outputs.yaml).toEqual({ enabled: true, path: '/workspace/.devcontext/yaml' });
    expect(config.outputs.json.enabled).toBe(false);
    expect(config.sync.minDelayMs).toBe(250);
    expect(config.web.port).toBe(4173);

    const [project] = config.projects;
    expect(project?.name).toBe('demo');
    expect(project?.github[0]?.fullName).toBe('acme/platform');
    expect(project?.github[0]?.host.apiUrl).toBe('https://api.github.com');
    expect(project?.github[0]?.sync.issueTimeline).toBe(true);
  });

  it('merges sync flags from the global section into every repository', () => {
    const config = parseConfig(
      `
github:
  sync:
    workflowLogs: true
    releases: true
projects:
  - key: demo
    github:
      - repo: acme/platform
        sync:
          releases: false
`,
      { configPath: CONFIG_PATH },
    );

    const repo = config.projects[0]?.github[0];
    expect(repo?.sync.workflowLogs).toBe(true);
    expect(repo?.sync.releases).toBe(false);
  });

  it('resolves relative "since" values into absolute timestamps', () => {
    const now = new Date('2024-06-15T12:00:00.000Z');
    const config = parseConfig(
      `
projects:
  - key: demo
    github:
      - repo: acme/platform
        since: 30d
`,
      { configPath: CONFIG_PATH, now },
    );

    expect(config.projects[0]?.github[0]?.since).toBe('2024-05-16T12:00:00.000Z');
  });

  it('links Jira projects to their site and merges the field mapping', () => {
    const config = parseConfig(
      `
jira:
  sites:
    - name: acme
      baseUrl: https://acme.atlassian.net/
      email: bot@acme.test
      fields:
        customfield_1: storyPoints
projects:
  - key: demo
    jira:
      - project: plat
        site: acme
        filter: labels != security
        fields:
          customfield_2: teamName
`,
      { configPath: CONFIG_PATH },
    );

    const target = config.projects[0]?.jira[0];
    expect(target?.projectKey).toBe('PLAT');
    expect(target?.filter).toBe('labels != security');
    expect(target?.site.baseUrl).toBe('https://acme.atlassian.net');
    expect(target?.site.auth).toBe('basic');
    expect(target?.fields).toEqual({ customfield_1: 'storyPoints', customfield_2: 'teamName' });
  });

  it('rejects a project without any source', () => {
    expect(() => parseConfig(`projects:\n  - key: demo\n`, { configPath: CONFIG_PATH })).toThrow(
      /neither a GitHub repository nor a Jira project/,
    );
  });

  it('rejects an unknown Jira site reference', () => {
    expect(() =>
      parseConfig(
        `
jira:
  sites:
    - name: acme
      baseUrl: https://acme.atlassian.net
projects:
  - key: demo
    jira:
      - project: PLAT
        site: other
`,
        { configPath: CONFIG_PATH },
      ),
    ).toThrow(/unknown Jira site "other"/);
  });

  it('reports unknown keys instead of silently ignoring them', () => {
    expect(() =>
      parseConfig(
        `
projects:
  - key: demo
    github:
      - repo: acme/platform
        syncs: {}
`,
        { configPath: CONFIG_PATH },
      ),
    ).toThrow(/Invalid configuration/);
  });
});

describe('expandEnv', () => {
  it('replaces variables and honours fallbacks', () => {
    const result = expandEnv(
      { a: '${KNOWN}', b: '${MISSING:-default}', c: '${UNSET}', d: [1, '${KNOWN}'] },
      { KNOWN: 'value' } as NodeJS.ProcessEnv,
    );

    expect(result).toEqual({
      a: 'value',
      b: 'default',
      c: '${UNSET}',
      d: [1, 'value'],
    });
  });
});

describe('EXAMPLE_CONFIG', () => {
  it('matches devcontext.example.yaml in the repository root', () => {
    const fromDisk = readFileSync(
      resolve(import.meta.dirname, '../../../devcontext.example.yaml'),
      'utf8',
    );
    expect(EXAMPLE_CONFIG).toBe(fromDisk);
  });

  it('is a valid configuration', () => {
    const config = parseConfig(EXAMPLE_CONFIG, { configPath: CONFIG_PATH });
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0]?.github.map((repo) => repo.fullName)).toEqual([
      'acme/platform',
      'acme/platform-docs',
    ]);
    expect(config.projects[0]?.jira[0]?.projectKey).toBe('PLAT');
  });
});
