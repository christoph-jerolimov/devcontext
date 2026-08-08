import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../config/load.js';
import { Directory } from '../../people/directory.js';
import { Database } from '../database.js';
import { activityByActor, countActivity, listActivity } from './activity.js';

const CONFIG = `
people:
  - id: grace
    name: Grace Hopper
    github: [ghopper]
    jira: ["Grace Hopper"]
  - id: ada
    name: Ada Lovelace
    github: [ada]
  # Her Jira display name happens to read the same as Ada's GitHub login.
  # Different namespaces, different people — the feed has to keep them apart.
  - id: mabel
    name: Mabel Addison
    jira: [ada]
bots:
  - id: triage
    github: [triage-runner]
teams:
  - id: platform
    members: [grace, ada]
projects:
  - key: platform
    github:
      - repo: acme/platform
`;

let workspace: string;
let db: Database;
let directory: Directory;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'devcontext-activity-'));
  db = Database.openAndMigrate(join(workspace, 'devcontext.db'));
  directory = Directory.from(
    parseConfig(CONFIG, { configPath: join(workspace, 'devcontext.yaml') }),
  );

  // An issue Grace opened and Ada closed, with a comment in between.
  issue({ id: 1, number: 1, author: 'ghopper', created: '2024-03-01T09:00:00Z' });
  event({
    uid: 'e1',
    issueId: 1,
    number: 1,
    event: 'closed',
    actor: 'ada',
    at: '2024-03-05T09:00:00Z',
  });
  comment({
    id: 10,
    issueId: 1,
    number: 1,
    author: 'ada',
    at: '2024-03-02T09:00:00Z',
    body: 'Looks right\nto me',
  });

  // A pull request with a review and an inline comment.
  issue({ id: 2, number: 7, author: 'ada', created: '2024-03-03T09:00:00Z', pull: true });
  pullRequest({ id: 700, number: 7, title: 'Speed up the limiter' });
  review({
    id: 20,
    prId: 700,
    number: 7,
    author: 'ghopper',
    state: 'APPROVED',
    at: '2024-03-04T09:00:00Z',
  });
  reviewComment({ id: 30, prId: 700, number: 7, author: 'ghopper', at: '2024-03-04T08:00:00Z' });

  // A bot doing bot things.
  comment({
    id: 11,
    issueId: 1,
    number: 1,
    author: 'triage-runner',
    at: '2024-03-06T09:00:00Z',
    body: 'ping',
  });
  comment({
    id: 12,
    issueId: 1,
    number: 1,
    author: 'stale[bot]',
    at: '2024-03-07T09:00:00Z',
    body: 'stale',
  });

  // Jira: created, moved, commented.
  workitem({ key: 'PLAT-1', creator: 'Grace Hopper', created: '2024-03-01T10:00:00Z' });
  changelog({
    uid: 'c1',
    key: 'PLAT-1',
    field: 'status',
    to: 'In Progress',
    author: 'Grace Hopper',
    at: '2024-03-02T10:00:00Z',
  });
  // A field that is not a status: the feed must not call this a status change.
  changelog({
    uid: 'c2',
    key: 'PLAT-1',
    field: 'description',
    to: 'longer',
    author: 'Grace Hopper',
    at: '2024-03-02T11:00:00Z',
  });
  jiraComment({ id: 'jc1', key: 'PLAT-1', author: 'Grace Hopper', at: '2024-03-03T10:00:00Z' });
  jiraComment({ id: 'jc2', key: 'PLAT-1', author: 'ada', at: '2024-03-03T11:00:00Z' });
});

afterEach(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true });
});

function issue(row: {
  id: number;
  number: number;
  author: string;
  created: string;
  pull?: boolean;
}): void {
  db.upsert('gh_issues', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: row.number,
    title: `Item ${String(row.number)}`,
    state: 'open',
    author: row.author,
    assignees: '[]',
    is_pull_request: row.pull ?? false,
    created_at: row.created,
    updated_at: row.created,
    html_url: `https://github.com/acme/platform/issues/${String(row.number)}`,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

function pullRequest(row: { id: number; number: number; title: string }): void {
  db.upsert('gh_pull_requests', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    number: row.number,
    title: row.title,
    state: 'open',
    author: 'ada',
    assignees: '[]',
    created_at: '2024-03-03T09:00:00Z',
    updated_at: '2024-03-04T09:00:00Z',
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

function event(row: {
  uid: string;
  issueId: number;
  number: number;
  event: string;
  actor: string;
  at: string;
}): void {
  db.upsert('gh_events', {
    host: 'github.com',
    uid: row.uid,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    issue_id: row.issueId,
    issue_number: row.number,
    event: row.event,
    actor: row.actor,
    created_at: row.at,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

function comment(row: {
  id: number;
  issueId: number;
  number: number;
  author: string;
  at: string;
  body: string;
}): void {
  db.upsert('gh_comments', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    issue_id: row.issueId,
    issue_number: row.number,
    author: row.author,
    body: row.body,
    created_at: row.at,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

function review(row: {
  id: number;
  prId: number;
  number: number;
  author: string;
  state: string;
  at: string;
}): void {
  db.upsert('gh_reviews', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    pr_id: row.prId,
    pr_number: row.number,
    author: row.author,
    state: row.state,
    submitted_at: row.at,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

function reviewComment(row: {
  id: number;
  prId: number;
  number: number;
  author: string;
  at: string;
}): void {
  db.upsert('gh_review_comments', {
    host: 'github.com',
    id: row.id,
    repo_id: 1,
    repo_full_name: 'acme/platform',
    pr_id: row.prId,
    pr_number: row.number,
    author: row.author,
    body: 'this line',
    created_at: row.at,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

function workitem(row: { key: string; creator: string; created: string }): void {
  db.upsert('jira_workitems', {
    site: 'acme',
    id: row.key,
    key: row.key,
    project_key: 'PLAT',
    summary: `Work item ${row.key}`,
    type: 'Story',
    status: 'To Do',
    status_category: 'To Do',
    creator: row.creator,
    reporter: row.creator,
    created_at: row.created,
    updated_at: row.created,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

function changelog(row: {
  uid: string;
  key: string;
  field: string;
  to: string;
  author: string;
  at: string;
}): void {
  db.upsert('jira_changelog', {
    site: 'acme',
    uid: row.uid,
    history_id: row.uid,
    workitem_id: row.key,
    workitem_key: row.key,
    author: row.author,
    created_at: row.at,
    field: row.field,
    to_string: row.to,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

function jiraComment(row: { id: string; key: string; author: string; at: string }): void {
  db.upsert('jira_comments', {
    site: 'acme',
    id: row.id,
    workitem_id: row.key,
    workitem_key: row.key,
    author: row.author,
    body: 'a remark',
    created_at: row.at,
    synced_at: '2024-06-01T00:00:00.000Z',
    raw: '{}',
  });
}

describe('the activity feed', () => {
  it('gathers all three kinds from both platforms, newest first', () => {
    const rows = listActivity(db);

    expect(rows.map((row) => `${row.ref} ${row.action}`)).toEqual([
      'acme/platform#1 commented',
      'acme/platform#1 commented',
      'acme/platform#1 closed',
      'acme/platform#7 approved',
      'acme/platform#7 commented on the diff',
      'PLAT-1 commented',
      'PLAT-1 commented',
      'acme/platform#7 opened pull request',
      'PLAT-1 moved to In Progress',
      'acme/platform#1 commented',
      'PLAT-1 created',
      'acme/platform#1 opened',
    ]);
    expect(rows.map((row) => row.at)).toEqual(
      rows
        .map((row) => row.at)
        .toSorted()
        .toReversed(),
    );
  });

  it('carries the item title, so a row reads on its own', () => {
    const approval = listActivity(db).find((row) => row.action === 'approved');

    expect(approval?.title).toBe('Speed up the limiter');
  });

  it('ignores every changelog field except the status', () => {
    // "Changed the description" is a change, but it is not a status change,
    // and a feed that says it is would be full of them.
    const rows = listActivity(db, { sources: ['jira'], kinds: ['status'] });

    expect(rows.map((row) => row.action)).toEqual(['moved to In Progress', 'created']);
  });

  it('splits by kind', () => {
    expect(listActivity(db, { kinds: ['review'] }).map((row) => row.action)).toEqual(['approved']);
    expect(listActivity(db, { kinds: ['comment'] })).toHaveLength(6);
    expect(listActivity(db, { kinds: ['status'] })).toHaveLength(5);
  });

  it('counts an inline review comment as a comment, not as a review', () => {
    // It is somebody saying something, which is what the comment kind is for.
    // Counting it as a review would make one reviewer look like two.
    const reviews = listActivity(db, { kinds: ['review'] });

    expect(reviews).toHaveLength(1);
    expect(listActivity(db, { kinds: ['comment'] }).map((row) => row.action)).toContain(
      'commented on the diff',
    );
  });

  it('bounds the window at both ends', () => {
    const rows = listActivity(db, { since: '2024-03-02T00:00:00Z', until: '2024-03-04T00:00:00Z' });

    expect(rows.map((row) => row.at).toSorted()).toEqual([
      '2024-03-02T09:00:00Z',
      '2024-03-02T10:00:00Z',
      '2024-03-03T09:00:00Z',
      '2024-03-03T10:00:00Z',
      '2024-03-03T11:00:00Z',
    ]);
  });

  it('filters by person across both sources at once', () => {
    const selection = directory.select({ people: ['grace'] });
    const rows = listActivity(db, {
      people: { github: selection?.github ?? [], jira: selection?.jira ?? [] },
    });

    // Everything Grace did, and nothing Ada did.
    expect(rows.map((row) => row.actor)).toEqual([
      'ghopper',
      'ghopper',
      'Grace Hopper',
      'Grace Hopper',
      'Grace Hopper',
      'ghopper',
    ]);
  });

  it('filters by team', () => {
    const selection = directory.select({ teams: ['platform'] });
    const rows = listActivity(db, {
      people: { github: selection?.github ?? [], jira: selection?.jira ?? [] },
    });

    // Both members, and neither bot.
    expect(rows.map((row) => row.actor)).not.toContain('triage-runner');
    expect(rows.map((row) => row.actor)).not.toContain('stale[bot]');
    expect(rows.map((row) => row.actor)).toContain('ada');
  });

  it('does not let a GitHub login match a Jira name that reads the same', () => {
    /*
     * `ada` is Ada's GitHub login and, separately, Mabel's Jira display name.
     * A filter that compared the identity to every actor regardless of source
     * would hand Ada everything Mabel ever wrote — and the result would look
     * entirely plausible.
     */
    const ada = directory.select({ people: ['ada'] });
    const rows = listActivity(db, {
      people: { github: ada?.github ?? [], jira: ada?.jira ?? [] },
    });

    expect(rows.every((row) => row.source === 'github')).toBe(true);

    const mabel = directory.select({ people: ['mabel'] });
    const hers = listActivity(db, {
      people: { github: mabel?.github ?? [], jira: mabel?.jira ?? [] },
    });

    expect(hers.map((row) => `${row.source} ${row.action}`)).toEqual(['jira commented']);
  });

  it('keeps a person out of a source they have no identity on', () => {
    // Ada is GitHub only, so no Jira row can be hers — including the ones an
    // unfiltered Jira half would have returned.
    const selection = directory.select({ people: ['ada'] });
    const rows = listActivity(db, {
      people: { github: selection?.github ?? [], jira: selection?.jira ?? [] },
    });

    expect(rows.every((row) => row.source === 'github')).toBe(true);
  });

  it('hides the configured bot and the [bot] suffix together', () => {
    const rows = listActivity(db, {
      excludeBots: true,
      bots: directory.botIdentities(),
    });

    const actors = rows.map((row) => row.actor);
    expect(actors).not.toContain('triage-runner');
    expect(actors).not.toContain('stale[bot]');
    expect(actors).toContain('ghopper');
  });

  it('keeps only those two when asked the other way round', () => {
    const rows = listActivity(db, { onlyBots: true, bots: directory.botIdentities() });

    expect(rows.map((row) => row.actor).toSorted()).toEqual(['stale[bot]', 'triage-runner']);
  });

  it('counts what the page is a page of', () => {
    const filter = { kinds: ['comment'] };

    expect(listActivity(db, { ...filter, limit: 2 })).toHaveLength(2);
    expect(countActivity(db, filter)).toBe(6);
  });

  it('rolls up per actor, busiest first', () => {
    const rows = activityByActor(db);
    const grace = rows.find((row) => row.actor === 'ghopper');

    expect(grace).toMatchObject({ source: 'github', status: 1, comments: 1, reviews: 1, total: 3 });
    expect(rows.map((row) => row.total)).toEqual(
      rows
        .map((row) => row.total)
        .toSorted()
        .toReversed(),
    );
  });

  it('rolls up per identity, so an unmapped login stays visible', () => {
    // Rolling into people would merge `ghopper` and `Grace Hopper` — and hide
    // the third login nobody configured, which is the one worth seeing.
    const rows = activityByActor(db);

    expect(rows.map((row) => row.actor)).toContain('ghopper');
    expect(rows.map((row) => row.actor)).toContain('Grace Hopper');
  });
});
