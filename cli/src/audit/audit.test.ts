import { afterEach, beforeEach, describe as suite, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import { contentReport, peopleReport, secretsReport } from './index.js';
import { fingerprint, scanText } from './secrets.js';

let db: Database;
const SYNCED = '2026-08-01T00:00:00.000Z';

function addIssue(number: number, fields: Record<string, unknown> = {}): void {
  db.upsert('gh_issues', {
    host: 'github.com',
    id: 2000 + number,
    repo_id: 7,
    repo_full_name: 'acme/platform',
    number,
    state: 'open',
    is_pull_request: 0,
    assignees: '[]',
    labels: '[]',
    synced_at: SYNCED,
    raw: '{}',
    ...fields,
  } as Record<string, never>);
}

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
});

afterEach(() => db.close());

suite('scanText', () => {
  it('finds a GitHub token', () => {
    const [finding] = scanText(`export GITHUB_TOKEN=ghp_${'a'.repeat(36)}`);
    expect(finding).toMatchObject({ patternId: 'github-token', confidence: 'high' });
  });

  it('finds an AWS access key id', () => {
    expect(scanText('AKIAQWERTYUIOPASDFGH')[0]?.patternId).toBe('aws-access-key');
  });

  it('finds a private key block', () => {
    expect(scanText('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')[0]?.patternId).toBe('private-key');
  });

  it('finds credentials embedded in a URL', () => {
    expect(scanText('git clone https://user:hunter2xyz@example.test/repo.git')[0]?.patternId).toBe(
      'url-credentials',
    );
  });

  it('finds a JSON web token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P';
    expect(scanText(jwt)[0]?.patternId).toBe('jwt');
  });

  it('never returns the secret itself', () => {
    const secret = `ghp_${'b'.repeat(36)}`;
    const [finding] = scanText(`token: ${secret}`);

    // This is the property the whole command depends on.
    expect(JSON.stringify(finding)).not.toContain(secret);
    expect(finding?.fingerprint).not.toContain(secret.slice(4, 30));
  });

  it('reports the line so it can be found again', () => {
    const text = `first\nsecond\nAKIAQWERTYUIOPASDFGH`;
    expect(scanText(text)[0]?.line).toBe(3);
  });

  it('ignores obvious placeholders', () => {
    expect(scanText('password = "xxxxxxxxxxxx"')).toEqual([]);
    expect(scanText('api_key = "your-api-key-here"')).toEqual([]);
    expect(scanText('secret: <YOUR_SECRET_HERE>')).toEqual([]);
    expect(scanText('token = "${GITHUB_TOKEN}"')).toEqual([]);
  });

  it('still reports a high confidence match containing placeholder words', () => {
    // A real key whose random middle happens to read "test" or "example" must
    // not be filtered out; a missed credential is worse than one to wave away.
    expect(scanText('AKIATESTINGEXAMPLE12')[0]?.patternId).toBe('aws-access-key');
    expect(scanText(`ghp_example${'f'.repeat(29)}`)[0]?.patternId).toBe('github-token');
  });

  it('skips the AWS key from the documentation, which is everywhere', () => {
    expect(scanText('AKIAIOSFODNN7EXAMPLE')).toEqual([]);
  });

  it('marks keyword heuristics as low confidence', () => {
    const [finding] = scanText('password = "correcthorsebattery"');
    expect(finding).toMatchObject({ patternId: 'assignment', confidence: 'low' });
  });

  it('reports one finding per distinct value, not per occurrence', () => {
    const token = `ghp_${'c'.repeat(36)}`;
    expect(scanText(`${token} and again ${token}`)).toHaveLength(1);
  });

  it('handles empty and missing text', () => {
    expect(scanText('')).toEqual([]);
    expect(scanText(null)).toEqual([]);
    expect(scanText(undefined)).toEqual([]);
  });

  it('does not carry regex state between calls', () => {
    // The patterns are module level with /g, so a stale lastIndex would make
    // every second scan miss.
    const text = 'AKIAQWERTYUIOPASDFGH';
    expect(scanText(text)).toHaveLength(1);
    expect(scanText(text)).toHaveLength(1);
    expect(scanText(text)).toHaveLength(1);
  });
});

suite('fingerprint', () => {
  it('masks the middle', () => {
    expect(fingerprint('abcdefghijklmnop')).toBe('abc…op (16 chars)');
  });

  it('masks a short value almost entirely', () => {
    expect(fingerprint('abcdef')).toBe('a…(6 chars)');
  });
});

suite('secretsReport', () => {
  it('locates a credential and says where it is', () => {
    addIssue(1, { title: 'Broken deploy', body: `Use AKIAQWERTYUIOPASDFGH for now` });

    const report = secretsReport(db);

    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toMatchObject({
      ref: 'acme/platform#1',
      where: 'issue body',
      patternId: 'aws-access-key',
    });
    expect(report.highConfidence).toBe(1);
  });

  it('scans comments and job logs, not only bodies', () => {
    addIssue(1, { title: 'Fine' });
    db.upsert('gh_comments', {
      host: 'github.com',
      id: 1,
      repo_id: 7,
      repo_full_name: 'acme/platform',
      issue_id: 2001,
      issue_number: 1,
      body: `token ghp_${'d'.repeat(36)}`,
      synced_at: SYNCED,
      raw: '{}',
    });
    db.upsert('gh_job_logs', {
      host: 'github.com',
      job_id: 99,
      repo_id: 7,
      content: 'AKIAQWERTYUIOPASDFGH leaked in CI',
      fetched_at: SYNCED,
    });

    const wheres = secretsReport(db).hits.map((hit) => hit.where);
    expect(wheres).toEqual(expect.arrayContaining(['issue comment', 'job log']));
  });

  it('leaves low confidence matches out unless asked', () => {
    addIssue(1, { body: 'password = "correcthorsebattery"' });

    expect(secretsReport(db).hits).toHaveLength(0);
    expect(secretsReport(db, { includeLowConfidence: true }).hits).toHaveLength(1);
  });

  it('puts certain findings first', () => {
    addIssue(1, { body: 'password = "correcthorsebattery"' });
    addIssue(2, { body: 'AKIAQWERTYUIOPASDFGH' });

    const hits = secretsReport(db, { includeLowConfidence: true }).hits;
    expect(hits[0]?.confidence).toBe('high');
  });

  it('never puts a secret in the report', () => {
    const token = `ghp_${'e'.repeat(36)}`;
    addIssue(1, { title: token, body: `here it is: ${token}` });

    const report = secretsReport(db);

    expect(report.hits).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it('counts what it scanned even when it finds nothing', () => {
    addIssue(1, { body: 'nothing to see' });
    addIssue(2, { body: 'also nothing' });

    const report = secretsReport(db);
    expect(report).toMatchObject({ hits: [], scanned: 2, highConfidence: 0 });
  });
});

suite('contentReport', () => {
  it('reports only the groups that have rows', () => {
    addIssue(1, { title: 'One' });

    const report = contentReport(db);

    expect(report.groups.map((group) => group.group)).toEqual(['Issues']);
    expect(report.totalRows).toBe(1);
    expect(report.groups[0]?.freeText).toContain('body');
  });

  it('is empty for an empty database', () => {
    expect(contentReport(db)).toMatchObject({ groups: [], totalRows: 0 });
  });
});

suite('peopleReport', () => {
  it('lists everybody and why they are in there', () => {
    addIssue(1, { author: 'alice' });
    db.upsert('gh_reviews', {
      host: 'github.com',
      id: 1,
      repo_id: 7,
      repo_full_name: 'acme/platform',
      pr_id: 1,
      author: 'alice',
      submitted_at: '2026-07-01T00:00:00Z',
      synced_at: SYNCED,
      raw: '{}',
    });

    const report = peopleReport(db);

    expect(report.people).toHaveLength(1);
    expect(report.people[0]).toMatchObject({
      name: 'alice',
      source: 'github',
      appearsAs: ['issue author', 'reviewer'],
    });
  });

  it('counts commit email addresses separately', () => {
    db.upsert('gh_commits', {
      host: 'github.com',
      sha: 'abc',
      repo_id: 7,
      repo_full_name: 'acme/platform',
      pr_id: 1,
      author_email: 'alice@example.test',
      synced_at: SYNCED,
      raw: '{}',
    });

    expect(peopleReport(db).emails).toBe(1);
  });
});
