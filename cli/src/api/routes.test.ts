/**
 * The route table is the API now, so what deserves testing is the machinery
 * that interprets it: matching, decoding and the derived schemas. The
 * handlers themselves are one-line bindings onto query functions with their
 * own tests, and the HTTP round trip has `server.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { compilePath, decodeQuery, inputSchema, matchRoute, routes } from './routes.js';
import type { CapabilityName } from './routes.js';

/** A plausible concrete value for each parameter, to walk a pattern with. */
function segmentsFor(path: string, { withOptional = true } = {}): string[] {
  const segments: string[] = [];
  for (const part of compilePath(path)) {
    if (part.kind === 'static') segments.push(part.value);
    if (part.kind === 'param' && (withOptional || !part.optional)) segments.push('42');
    if (part.kind === 'rest') segments.push('acme', 'platform#42');
  }
  return segments;
}

describe('matching', () => {
  it('resolves every declared pattern back to its own capability', () => {
    // The table is data; nothing but this test notices a typo that makes two
    // routes shadow each other or a pattern that cannot match its own shape.
    for (const [name, route] of Object.entries(routes)) {
      expect(matchRoute(segmentsFor(route.path))?.name).toBe(name);
    }
  });

  it('lets a static segment win over a parameter', () => {
    expect(matchRoute(['activity', 'people'])?.name).toBe('activity.people');
    expect(matchRoute(['tickets', 'types'])?.name).toBe('tickets.types');
    expect(matchRoute(['people', 'teams'])?.name).toBe('people.teams');
  });

  it('separates the list from the single item by shape', () => {
    expect(matchRoute(['github', 'issues'])?.name).toBe('github.issues.list');
    expect(matchRoute(['github', 'issues', 'acme', 'platform', '7'])?.name).toBe(
      'github.issues.get',
    );
    expect(matchRoute(['github', 'runs'])?.name).toBe('github.runs.list');
    expect(matchRoute(['github', 'runs', '9'])?.name).toBe('github.runs.get');
  });

  it('matches an optional parameter with and without its segment', () => {
    expect(matchRoute(['insights', 'sprint'])?.name).toBe('insights.sprint');
    const withId = matchRoute(['insights', 'sprint', '7']);
    expect(withId?.name).toBe('insights.sprint');
    expect(withId?.params).toEqual({ sprint: '7' });
  });

  it('joins what a rest parameter swallowed back together', () => {
    // A GitHub reference is two path segments once decoded; the router must
    // hand the handler one string, not the first half.
    const match = matchRoute(['links', 'acme', 'platform#42']);
    expect(match?.name).toBe('links');
    expect(match?.params).toEqual({ ref: 'acme/platform#42' });
  });

  it('matches a bare rest route with no parameter at all', () => {
    const match = matchRoute(['links']);
    expect(match?.name).toBe('links');
    // Absent rather than empty, so a `?ref=` fallback can still apply.
    expect(match?.params).toEqual({});
  });

  it('has no opinion about paths outside the table', () => {
    expect(matchRoute([])).toBeUndefined();
    expect(matchRoute(['nope'])).toBeUndefined();
    expect(matchRoute(['status', 'extra'])).toBeUndefined();
    expect(matchRoute(['github', 'issues', 'acme', 'platform'])).toBeUndefined();
  });
});

describe('compiling a pattern', () => {
  it('refuses a rest parameter that is not last', () => {
    expect(() => compilePath('a/*rest/b')).toThrow(/must be last/);
  });

  it('refuses an optional parameter that is not last', () => {
    expect(() => compilePath('a/:x?/b')).toThrow(/must be last/);
  });
});

describe('decoding the query', () => {
  const route = routes['github.issues.list'];

  it('collects repeated parameters and splits each on commas', () => {
    const query = new URLSearchParams('repo=a/b,c/d&repo=e/f&label= bug , ui ');
    expect(decodeQuery(route, query)).toEqual({
      repo: ['a/b', 'c/d', 'e/f'],
      label: ['bug', 'ui'],
    });
  });

  it('treats a number that does not parse as absent, not as an error', () => {
    expect(decodeQuery(route, new URLSearchParams('limit=abc'))).toEqual({});
    expect(decodeQuery(route, new URLSearchParams('limit='))).toEqual({});
    expect(decodeQuery(route, new URLSearchParams('limit=25'))).toEqual({ limit: 25 });
  });

  it('keeps an empty string value, which is not the same as absent', () => {
    // `?search=` reaches the handler as '', exactly as URLSearchParams says.
    expect(decodeQuery(route, new URLSearchParams('search='))).toEqual({ search: '' });
  });

  it('ignores parameters the capability never declared', () => {
    expect(decodeQuery(route, new URLSearchParams('surprise=1'))).toEqual({});
  });
});

describe('the derived schema', () => {
  it('accepts what the decoder produces, for every capability', () => {
    for (const [name, route] of Object.entries(routes)) {
      const match = matchRoute(segmentsFor(route.path));
      const input = {
        ...decodeQuery(route, new URLSearchParams()),
        ...match?.params,
      };
      expect(() => inputSchema(name as CapabilityName).parse(input)).not.toThrow();
    }
  });

  it('demands the path parameters the pattern names', () => {
    expect(() => inputSchema('github.issues.get').parse({})).toThrow(/expected string/);
    expect(() =>
      inputSchema('github.issues.get').parse({ owner: 'acme', name: 'platform', number: '7' }),
    ).not.toThrow();
  });

  it('rejects a shape the table does not declare', () => {
    expect(() => inputSchema('github.issues.list').parse({ limit: 'many' })).toThrow(
      /expected number/,
    );
    expect(() => inputSchema('github.issues.list').parse({ repo: 'not-a-list' })).toThrow(
      /expected array/,
    );
  });
});
