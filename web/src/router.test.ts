import { describe as suite, expect, it } from 'vitest';

import { buildHash, parseHash } from './router.ts';

suite('parseHash', () => {
  it('reads the view', () => {
    expect(parseHash('#/issues').view).toBe('issues');
    expect(parseHash('#issues').view).toBe('issues');
    expect(parseHash('').view).toBe('');
  });

  it('reads the filters', () => {
    const { view, params } = parseHash('#/issues?repo=acme/web&state=all');
    expect(view).toBe('issues');
    expect(params.get('repo')).toBe('acme/web');
    expect(params.get('state')).toBe('all');
  });

  it('keeps a value that contains a hash', () => {
    // `open=acme/web#42` survives because only the first `?` splits the hash.
    expect(parseHash('#/issues?open=acme%2Fweb%2342').params.get('open')).toBe('acme/web#42');
  });

  it('reads a query with no view', () => {
    expect(parseHash('#/?open=PLAT-1')).toMatchObject({ view: '' });
  });
});

suite('buildHash', () => {
  it('omits an empty query', () => {
    expect(buildHash('issues', new URLSearchParams())).toBe('#/issues');
  });

  it('appends the filters', () => {
    const params = new URLSearchParams({ repo: 'acme/web', state: 'all' });
    expect(buildHash('issues', params)).toBe('#/issues?repo=acme%2Fweb&state=all');
  });

  it('round trips', () => {
    const params = new URLSearchParams({ open: 'acme/web#42', search: 'a b & c' });
    expect(parseHash(buildHash('pulls', params)).params.get('open')).toBe('acme/web#42');
    expect(parseHash(buildHash('pulls', params)).params.get('search')).toBe('a b & c');
  });
});
