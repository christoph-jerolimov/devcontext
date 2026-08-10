/**
 * The handover between a sync and everything that asks later: what the APIs
 * said about their budget, kept in `meta` so the status command, the TUI and
 * the web viewer all read the same numbers. The merge is the part worth
 * pinning — a GitHub-only run must not erase what the last run learned about
 * Jira.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../db/database.js';
import { persistRateLimits, readRateLimits } from './rateLimitStore.js';

let db: Database;

beforeEach(() => {
  db = Database.openAndMigrate(':memory:');
});

afterEach(() => {
  db.close();
});

const GITHUB = {
  limit: 5000,
  remaining: 4321,
  resetAt: '2026-08-10T13:00:00.000Z',
  observedAt: '2026-08-10T12:19:00.000Z',
};

const JIRA = {
  limit: null,
  remaining: 99,
  resetAt: null,
  observedAt: '2026-08-10T12:18:00.000Z',
};

describe('persisting rate limits', () => {
  it('stores and reads back what a sync observed', () => {
    persistRateLimits(db, { GitHub: GITHUB });
    expect(readRateLimits(db)).toEqual({ GitHub: GITHUB });
  });

  it('merges over earlier runs instead of replacing them', () => {
    persistRateLimits(db, { 'Jira (acme)': JIRA });
    persistRateLimits(db, { GitHub: GITHUB });

    // The GitHub-only run did not erase what the last run knew about Jira.
    expect(readRateLimits(db)).toEqual({ GitHub: GITHUB, 'Jira (acme)': JIRA });

    const fresher = { ...GITHUB, remaining: 4000, observedAt: '2026-08-10T12:30:00.000Z' };
    persistRateLimits(db, { GitHub: fresher });
    expect(readRateLimits(db)['GitHub']).toEqual(fresher);
  });

  it('writes nothing when nothing was observed', () => {
    // A fixture API that sends no rate limit headers must not create an
    // entry that reads as "0 left" or an empty row in three front ends.
    persistRateLimits(db, {});
    persistRateLimits(db, {
      GitHub: { limit: null, remaining: null, resetAt: null, observedAt: '2026-08-10T12:00:00Z' },
    });
    expect(readRateLimits(db)).toEqual({});
  });

  it('answers with nothing on a database no sync has written', () => {
    expect(readRateLimits(db)).toEqual({});
  });
});
