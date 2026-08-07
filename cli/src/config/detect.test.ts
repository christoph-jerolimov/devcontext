import { describe, expect, it } from 'vitest';

import {
  apiUrlForHost,
  buildDetectedConfig,
  detectEnvironment,
  hostNameFor,
  parseRemoteUrl,
} from './detect.js';
import { parseConfig } from './load.js';

describe('parseRemoteUrl', () => {
  it('understands the URL forms git produces', () => {
    const cases: Array<[string, { host: string; owner: string; name: string }]> = [
      [
        'https://github.com/acme/platform.git',
        { host: 'github.com', owner: 'acme', name: 'platform' },
      ],
      ['https://github.com/acme/platform', { host: 'github.com', owner: 'acme', name: 'platform' }],
      [
        'https://user@github.com/acme/platform.git',
        { host: 'github.com', owner: 'acme', name: 'platform' },
      ],
      ['git@github.com:acme/platform.git', { host: 'github.com', owner: 'acme', name: 'platform' }],
      ['git@github.com:acme/platform', { host: 'github.com', owner: 'acme', name: 'platform' }],
      [
        'ssh://git@github.acme.com:2222/acme/platform.git',
        { host: 'github.acme.com', owner: 'acme', name: 'platform' },
      ],
      [
        'git://github.com/acme/platform.git',
        { host: 'github.com', owner: 'acme', name: 'platform' },
      ],
      [
        'https://github.acme.com/nested/group/acme/platform.git',
        { host: 'github.acme.com', owner: 'acme', name: 'platform' },
      ],
    ];

    for (const [url, expected] of cases) {
      expect({ url, parsed: parseRemoteUrl(url) }).toEqual({ url, parsed: expected });
    }
  });

  it('keeps dots and dashes in repository names', () => {
    expect(parseRemoteUrl('git@github.com:acme/my.repo-name.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      name: 'my.repo-name',
    });
  });

  it('rejects anything that is not a repository URL', () => {
    const rejected = ['', '   ', 'not a url', 'https://github.com/acme'];
    expect(rejected.filter((url) => parseRemoteUrl(url) !== null)).toEqual([]);
  });
});

describe('host helpers', () => {
  it('maps hosts to their API url', () => {
    expect(apiUrlForHost('github.com')).toBe('https://api.github.com');
    expect(apiUrlForHost('github.acme.com')).toBe('https://github.acme.com/api/v3');
  });

  it('derives a short host name', () => {
    expect(hostNameFor('github.com')).toBe('github.com');
    expect(hostNameFor('github.acme.com')).toBe('github');
  });
});

describe('detectEnvironment', () => {
  it('finds the repository of this working directory', () => {
    const detected = detectEnvironment({ cwd: import.meta.dirname });

    // The test itself runs inside a git checkout of this project.
    expect(detected.repositories.length).toBeGreaterThan(0);
    const [first] = detected.repositories;
    expect(first?.fullName).toMatch(/^[^/]+\/[^/]+$/);
    expect(first?.remote).toBe('origin');
    expect(first?.host).toBe('github.com');
  });

  it('reports where a token was found', () => {
    const withEnv = detectEnvironment({
      cwd: import.meta.dirname,
      env: { GITHUB_TOKEN: 'ghp_x' } as NodeJS.ProcessEnv,
    });
    expect(withEnv.token).toEqual({ source: 'env', variable: 'GITHUB_TOKEN' });

    const preferred = detectEnvironment({
      cwd: import.meta.dirname,
      env: { GITHUB_TOKEN: 'ghp_x', DEVCONTEXT_GITHUB_TOKEN: 'ghp_y' } as NodeJS.ProcessEnv,
    });
    expect(preferred.token).toEqual({ source: 'env', variable: 'DEVCONTEXT_GITHUB_TOKEN' });
  });

  it('ignores empty token variables', () => {
    const detected = detectEnvironment({
      cwd: import.meta.dirname,
      env: { GITHUB_TOKEN: '' } as NodeJS.ProcessEnv,
    });
    expect(detected.token === null || detected.token.source === 'gh-cli').toBe(true);
  });

  it('returns nothing outside a git checkout', () => {
    const detected = detectEnvironment({ cwd: '/', env: {} as NodeJS.ProcessEnv });
    expect(detected.repositories).toEqual([]);
  });
});

describe('buildDetectedConfig', () => {
  const repository = {
    fullName: 'acme/platform',
    owner: 'acme',
    name: 'platform',
    remote: 'origin',
    host: 'github.com',
    url: 'https://github.com/acme/platform.git',
  };

  it('produces a configuration devcontext can actually load', () => {
    const yaml = buildDetectedConfig({ repositories: [repository] });
    const config = parseConfig(yaml, { configPath: '/workspace/devcontext.yaml' });

    expect(config.projects).toHaveLength(1);
    expect(config.projects[0]?.key).toBe('platform');
    expect(config.projects[0]?.github.map((entry) => entry.fullName)).toEqual(['acme/platform']);
    expect(config.projects[0]?.github[0]?.since).not.toBeNull();
    expect(config.githubHosts.get('github.com')?.tokenEnv).toBe('GITHUB_TOKEN');
  });

  it('carries several repositories and a custom project key', () => {
    const yaml = buildDetectedConfig({
      repositories: [repository, { ...repository, fullName: 'acme/docs', name: 'docs' }],
      projectKey: 'acme',
      since: '6mo',
    });
    const config = parseConfig(yaml, { configPath: '/workspace/devcontext.yaml' });

    expect(config.projects[0]?.key).toBe('acme');
    expect(config.projects[0]?.github.map((entry) => entry.fullName)).toEqual([
      'acme/platform',
      'acme/docs',
    ]);
  });

  it('defines the host section for GitHub Enterprise remotes', () => {
    const yaml = buildDetectedConfig({
      repositories: [{ ...repository, host: 'github.acme.com' }],
    });
    const config = parseConfig(yaml, { configPath: '/workspace/devcontext.yaml' });

    const host = config.projects[0]?.github[0]?.host;
    expect(host?.name).toBe('github');
    expect(host?.apiUrl).toBe('https://github.acme.com/api/v3');
    expect(host?.tokenEnv).toBe('GITHUB_TOKEN');
  });

  it('uses the token variable that was actually found', () => {
    const yaml = buildDetectedConfig({
      repositories: [repository],
      tokenEnv: 'DEVCONTEXT_GITHUB_TOKEN',
    });
    const config = parseConfig(yaml, { configPath: '/workspace/devcontext.yaml' });
    expect(config.githubHosts.get('github.com')?.tokenEnv).toBe('DEVCONTEXT_GITHUB_TOKEN');
  });
});
