import { describe, expect, it } from 'vitest';

import { parseConfig } from '../config/load.js';
import { Directory, looksLikeBot } from './directory.js';

const PROJECTS = `
projects:
  - key: platform
    github:
      - repo: acme/platform
`;

function directoryFrom(yaml: string): Directory {
  return Directory.from(parseConfig(`${yaml}${PROJECTS}`, { configPath: '/w/devcontext.yaml' }));
}

const TEAM = `
people:
  - id: grace
    name: Grace Hopper
    github: [ghopper, grace-h]
    jira: ["Grace Hopper"]
  - id: ada
    name: Ada Lovelace
    github: [ada]
  - id: jean
    name: Jean Bartik
    jira: ["Jean Bartik"]
bots:
  - id: dependabot
    github: ["dependabot[bot]"]
teams:
  - id: platform
    name: Platform
    members: [grace, ada]
`;

describe('the people directory', () => {
  it('reads people and bots into one list, with the kind already decided', () => {
    const directory = directoryFrom(TEAM);

    expect(directory.people.map((person) => person.id)).toEqual([
      'grace',
      'ada',
      'jean',
      'dependabot',
    ]);
    expect(directory.person('grace')?.kind).toBe('person');
    expect(directory.person('dependabot')?.kind).toBe('bot');
  });

  it('names a person from any of their identities, whatever the case', () => {
    const directory = directoryFrom(TEAM);

    expect(directory.identify('github', 'ghopper')?.id).toBe('grace');
    expect(directory.identify('github', 'GRACE-H')?.id).toBe('grace');
    expect(directory.identify('jira', '  grace hopper ')?.id).toBe('grace');
    // A GitHub login is not a Jira name, however similar it looks.
    expect(directory.identify('jira', 'ghopper')).toBeUndefined();
  });

  it('treats a [bot] suffix as a bot without being told', () => {
    const directory = directoryFrom(TEAM);

    expect(directory.kindOf('github', 'renovate[bot]')).toBe('bot');
    expect(directory.kindOf('github', 'ada')).toBe('person');
    expect(looksLikeBot('github-actions[bot]')).toBe(true);
    expect(looksLikeBot('robotnik')).toBe(false);
  });

  it('lets the configuration overrule the suffix in both directions', () => {
    const directory = directoryFrom(`
people:
  - id: releasebot
    github: ["release[bot]"]
bots:
  - id: ci
    github: [ci-runner]
`);

    // Configured as a person despite the suffix ...
    expect(directory.kindOf('github', 'release[bot]')).toBe('person');
    // ... and as a bot despite an ordinary looking login.
    expect(directory.kindOf('github', 'ci-runner')).toBe('bot');
  });

  it('expands a team into every identity of every member', () => {
    const selection = directoryFrom(TEAM).select({ teams: ['platform'] });

    expect(selection?.people.map((person) => person.id)).toEqual(['grace', 'ada']);
    expect(selection?.github).toEqual(['ghopper', 'grace-h', 'ada']);
    expect(selection?.jira).toEqual(['grace hopper']);
  });

  it('returns configuration order, so the same selection binds the same list', () => {
    const directory = directoryFrom(TEAM);

    const forwards = directory.select({ people: ['grace', 'ada'] });
    const backwards = directory.select({ people: ['ada', 'grace'] });

    expect(backwards?.github).toEqual(forwards?.github);
  });

  it('merges a person and a team without counting the overlap twice', () => {
    const selection = directoryFrom(TEAM).select({ people: ['grace'], teams: ['platform'] });

    expect(selection?.people.map((person) => person.id)).toEqual(['grace', 'ada']);
    expect(selection?.github).toEqual(['ghopper', 'grace-h', 'ada']);
  });

  it('selects nothing when nobody was named', () => {
    expect(directoryFrom(TEAM).select({})).toBeUndefined();
    expect(directoryFrom(TEAM).select({ people: [], teams: [] })).toBeUndefined();
  });

  it('reports an empty list for a source the selected people are absent from', () => {
    // Jean is Jira only. Asking about him on the GitHub side has to come back
    // with "no identities" rather than "no filter", or the caller shows every
    // issue in the repository and calls it his.
    const selection = directoryFrom(TEAM).select({ people: ['jean'] });

    expect(selection?.jira).toEqual(['jean bartik']);
    expect(selection?.github).toEqual([]);
  });

  it('refuses an unknown person or team rather than matching nothing', () => {
    const directory = directoryFrom(TEAM);

    expect(() => directory.select({ people: ['gracie'] })).toThrow(/Unknown person "gracie"/);
    expect(() => directory.select({ teams: ['platfrom'] })).toThrow(/Unknown team "platfrom"/);
  });

  it('lists the configured bot identities across both sources', () => {
    const directory = directoryFrom(TEAM);

    expect(directory.botIdentities('github')).toEqual(['dependabot[bot]']);
    expect(directory.botIdentities('jira')).toEqual([]);
  });
});

describe('the configuration behind it', () => {
  it('rejects two people claiming the same identity', () => {
    expect(() =>
      directoryFrom(`
people:
  - id: grace
    github: [ghopper]
  - id: hopper
    github: [GHopper]
`),
    ).toThrow(/claimed by both "grace" and "hopper"/);
  });

  it('allows the same string on different sources', () => {
    // A Jira display name and a GitHub login are different namespaces, and a
    // person whose Jira name happens to equal somebody else's login is not a
    // conflict.
    const directory = directoryFrom(`
people:
  - id: grace
    github: [hopper]
  - id: ada
    jira: [hopper]
`);

    expect(directory.identify('github', 'hopper')?.id).toBe('grace');
    expect(directory.identify('jira', 'hopper')?.id).toBe('ada');
  });

  it('rejects a duplicate person id, including one hidden in bots', () => {
    expect(() =>
      directoryFrom(`
people:
  - id: ci
bots:
  - id: ci
`),
    ).toThrow(/Duplicate person id "ci"/);
  });

  it('rejects a team member nobody configured', () => {
    expect(() =>
      directoryFrom(`
people:
  - id: grace
teams:
  - id: platform
    members: [grace, ada]
`),
    ).toThrow(/Team "platform" lists the unknown person "ada"/);
  });

  it('defaults the name to the id and the kind to person', () => {
    const person = directoryFrom(`
people:
  - id: grace
`).person('grace');

    expect(person).toEqual({
      id: 'grace',
      name: 'grace',
      email: null,
      kind: 'person',
      github: [],
      jira: [],
    });
  });
});
