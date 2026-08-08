import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../config/load.js';
import { Directory } from '../../people/directory.js';
import { storeDirectory } from '../../people/store.js';
import { Database } from '../database.js';
import { listIssues, listPullRequests } from './github.js';
import { identityActivity, unmappedIdentities } from './people.js';
import { listTickets } from './tickets.js';

const CONFIG = `
people:
  - id: grace
    name: Grace Hopper
    github: [ghopper]
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
  - id: jiraonly
    members: [jean]
projects:
  - key: platform
    github:
      - repo: acme/platform
`;

let workspace: string;
let db: Database;
let directory: Directory;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'devcontext-people-'));
  db = Database.openAndMigrate(join(workspace, 'devcontext.db'));
  directory = Directory.from(
    parseConfig(CONFIG, { configPath: join(workspace, 'devcontext.yaml') }),
  );

  issue({ number: 1, author: 'ghopper', assignees: ['ada'] });
  issue({ number: 2, author: 'ada', assignees: [] });
  // A rename Grace never told anyone about: same person, unconfigured login.
  issue({ number: 3, author: 'grace-h', assignees: [] });
  issue({ number: 4, author: 'dependabot[bot]', assignees: [] });
  issue({ number: 5, author: 'renovate[bot]', assignees: [] });
  issue({ number: 6, author: 'ghopper', assignees: [], pull: true });
  issue({ number: 7, author: 'dependabot[bot]', assignees: [], pull: true });

  workitem({ key: 'PLAT-1', reporter: 'Grace Hopper', assignee: 'Jean Bartik' });
  workitem({ key: 'PLAT-2', reporter: 'Jean Bartik', assignee: 'Grace Hopper' });
  workitem({ key: 'PLAT-3', reporter: 'Somebody Else', assignee: 'Somebody Else' });
});

afterEach(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
});

function issue(row: { number: number; author: string; assignees: string[]; pull?: boolean }): void {
  db.upsert(row.pull ? 'gh_pull_requests' : 'gh_issues', {
    host: 'github.com',
    id: row.number,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: row.number,
    title: `Item ${String(row.number)}`,
    state: 'open',
    author: row.author,
    assignees: JSON.stringify(row.assignees),
    ...(row.pull ? {} : { is_pull_request: 0 }),
    updated_at: '2024-03-01T00:00:00Z',
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

function workitem(row: { key: string; reporter: string; assignee: string }): void {
  db.upsert('jira_workitems', {
    site: 'acme',
    id: row.key,
    key: row.key,
    project_key: 'PLAT',
    summary: row.key,
    type: 'Story',
    status: 'To Do',
    status_category: 'To Do',
    reporter: row.reporter,
    assignee: row.assignee,
    updated_at: '2024-03-01T00:00:00Z',
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

describe('filtering a list by person and team', () => {
  it('matches the author or an assignee, not only the author', () => {
    const selection = directory.select({ people: ['ada'] });
    const rows = listIssues(db, { people: selection?.github });

    // #2 she raised, #1 she was handed.
    expect(rows.map((row) => row.number).toSorted()).toEqual([1, 2]);
  });

  it('expands a team to every member', () => {
    const selection = directory.select({ teams: ['platform'] });
    const rows = listIssues(db, { people: selection?.github });

    expect(rows.map((row) => row.number).toSorted()).toEqual([1, 2]);
  });

  it('leaves out the login the mapping never learned about', () => {
    // Issue 3 is Grace's too, under a login the configuration does not list.
    // This is the failure the `people --unmapped` report exists to surface.
    const selection = directory.select({ people: ['grace'] });
    const rows = listIssues(db, { people: selection?.github });

    expect(rows.map((row) => row.number)).toEqual([1]);
  });

  it('matches nothing when the selected people have no identity on this source', () => {
    // Jean is Jira only. The dangerous outcome is not "no rows" but "every
    // row", which is what an empty list would produce if it were treated the
    // same as no filter at all.
    const selection = directory.select({ teams: ['jiraonly'] });

    expect(selection?.github).toEqual([]);
    expect(listIssues(db, { people: selection?.github })).toEqual([]);
    expect(listIssues(db, {}).length).toBe(5);
  });

  it('spans both sources in the merged ticket list', () => {
    const selection = directory.select({ people: ['grace'] });
    const rows = listTickets(db, {
      people: { github: selection?.github ?? [], jira: selection?.jira ?? [] },
    });

    expect(rows.map((row) => row.ref).toSorted()).toEqual(['PLAT-1', 'PLAT-2', 'acme/platform#1']);
  });

  it('keeps a Jira-only person out of the GitHub half of that list', () => {
    const selection = directory.select({ people: ['jean'] });
    const rows = listTickets(db, {
      people: { github: selection?.github ?? [], jira: selection?.jira ?? [] },
    });

    expect(rows.map((row) => row.ref).toSorted()).toEqual(['PLAT-1', 'PLAT-2']);
  });
});

describe('hiding and finding the bots', () => {
  it('drops both the configured bot and the one with the suffix', () => {
    const rows = listIssues(db, {
      excludeBots: true,
      bots: directory.botIdentities('github'),
    });

    expect(rows.map((row) => row.number).toSorted()).toEqual([1, 2, 3]);
  });

  it('keeps only those two when asked the other way round', () => {
    const rows = listIssues(db, {
      onlyBots: true,
      bots: directory.botIdentities('github'),
    });

    expect(rows.map((row) => row.number).toSorted()).toEqual([4, 5]);
  });

  it('recognises the suffix with nothing configured at all', () => {
    const rows = listIssues(db, { excludeBots: true });

    expect(rows.map((row) => row.number)).not.toContain(5);
  });

  it('applies to pull requests as well', () => {
    const rows = listPullRequests(db, {
      excludeBots: true,
      bots: directory.botIdentities('github'),
    });

    expect(rows.map((row) => row.number)).toEqual([6]);
  });
});

describe('checking the mapping against the data', () => {
  it('counts what one identity actually appears in', () => {
    const activity = identityActivity(db, 'github', 'ghopper');

    expect(activity.authored).toBe(1);
    expect(activity.pullRequests).toBe(1);
    expect(activity.lastSeen).toBe('2024-03-01T00:00:00Z');
  });

  it('reports nothing at all for an identity that matches no row', () => {
    // A typo in devcontext.yaml looks exactly like this, which is the point.
    const activity = identityActivity(db, 'github', 'ghoppr');

    expect(activity.authored).toBe(0);
    expect(activity.lastSeen).toBeNull();
  });

  it('reads a Jira identity from the reporter and the assignee', () => {
    const activity = identityActivity(db, 'jira', 'Grace Hopper');

    expect(activity.authored).toBe(1);
    expect(activity.assigned).toBe(1);
  });

  it('lists the names nobody claimed, busiest first', () => {
    const mapped = mappedIdentities();
    const rows = unmappedIdentities(db, mapped);

    expect(rows.map((row) => row.identity)).toContain('grace-h');
    expect(rows.map((row) => row.identity)).toContain('Somebody Else');
    // Everything Grace and Ada are configured under is accounted for.
    expect(rows.map((row) => row.identity)).not.toContain('ghopper');
    expect(rows.map((row) => row.identity)).not.toContain('Grace Hopper');
  });

  it('cuts to the limit after dropping the mapped names, not before', () => {
    // Otherwise asking for one unmapped name comes back empty whenever the
    // busiest author happens to be somebody already configured.
    const rows = unmappedIdentities(db, mappedIdentities(), { limit: 1 });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.identity).not.toBe('ghopper');
  });
});

describe('the configuration mirror', () => {
  it('writes the people, their identities and the teams', () => {
    storeDirectory(db, parseConfig(CONFIG, { configPath: join(workspace, 'devcontext.yaml') }));

    expect(db.all('SELECT id, kind FROM people ORDER BY id')).toEqual([
      { id: 'ada', kind: 'person' },
      { id: 'dependabot', kind: 'bot' },
      { id: 'grace', kind: 'person' },
      { id: 'jean', kind: 'person' },
    ]);
    expect(
      db.all(
        `SELECT identity, person_id FROM person_identities WHERE source = 'jira' ORDER BY identity`,
      ),
    ).toEqual([
      { identity: 'grace hopper', person_id: 'grace' },
      { identity: 'jean bartik', person_id: 'jean' },
    ]);
    expect(
      db.all('SELECT team_id, person_id FROM team_members ORDER BY team_id, position'),
    ).toEqual([
      { team_id: 'jiraonly', person_id: 'jean' },
      { team_id: 'platform', person_id: 'grace' },
      { team_id: 'platform', person_id: 'ada' },
    ]);
  });

  it('forgets somebody removed from the configuration', () => {
    const path = join(workspace, 'devcontext.yaml');
    storeDirectory(db, parseConfig(CONFIG, { configPath: path }));
    storeDirectory(
      db,
      parseConfig(
        `
people:
  - id: ada
    github: [ada]
projects:
  - key: platform
    github:
      - repo: acme/platform
`,
        { configPath: path },
      ),
    );

    expect(db.all('SELECT id FROM people')).toEqual([{ id: 'ada' }]);
    expect(db.all('SELECT identity FROM person_identities')).toEqual([{ identity: 'ada' }]);
    expect(db.all('SELECT id FROM teams')).toEqual([]);
  });
});

function mappedIdentities(): Set<string> {
  const mapped = new Set<string>();
  for (const person of directory.people) {
    for (const login of person.github) mapped.add(`github:${login.toLowerCase()}`);
    for (const name of person.jira) mapped.add(`jira:${name.toLowerCase()}`);
  }
  return mapped;
}
