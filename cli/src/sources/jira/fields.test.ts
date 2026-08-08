import { describe, expect, it } from 'vitest';

import { detectFieldAliases } from './map.js';

const CATALOGUE = [
  { id: 'summary', name: 'Summary' },
  { id: 'customfield_10016', name: 'Story Points' },
  { id: 'customfield_10014', name: 'Epic Link' },
  { id: 'customfield_10020', name: 'Sprint' },
];

describe('detecting the well known Jira fields', () => {
  it('names the three fields devcontext fills columns from', () => {
    expect(detectFieldAliases(CATALOGUE, {})).toEqual({
      customfield_10016: 'storyPoints',
      customfield_10014: 'epicLink',
      customfield_10020: 'sprint',
    });
  });

  it('matches the name whatever case and padding Jira reports it with', () => {
    expect(detectFieldAliases([{ id: 'cf_1', name: '  sprint ' }], {})).toEqual({
      cf_1: 'sprint',
    });
  });

  it('prefers the first name in the list when a site has several', () => {
    /*
     * Jira Cloud commonly ships both "Story Points" and "Story point estimate"
     * on the same site — company-managed and team-managed projects each get
     * their own — and only one of them is populated. Picking whichever the API
     * listed first would give a column of nulls on some sites and not others,
     * for no reason anybody could see.
     */
    const both = [
      { id: 'customfield_10035', name: 'Story point estimate' },
      { id: 'customfield_10016', name: 'Story Points' },
    ];

    expect(detectFieldAliases(both, {})).toEqual({ customfield_10016: 'storyPoints' });
    expect(detectFieldAliases(both.slice(0, 1), {})).toEqual({
      customfield_10035: 'storyPoints',
    });
  });

  it('never contradicts a mapping somebody wrote', () => {
    // An explicit mapping is somebody who looked at their own site. That beats
    // a name match, so the alias is left alone and nothing is returned for it.
    const configured = { customfield_10099: 'storyPoints' };

    expect(detectFieldAliases(CATALOGUE, configured)).toEqual({
      customfield_10014: 'epicLink',
      customfield_10020: 'sprint',
    });
  });

  it('does not steal a field id that is mapped to something else', () => {
    const configured = { customfield_10020: 'teamName' };

    expect(detectFieldAliases(CATALOGUE, configured)['customfield_10020']).toBeUndefined();
  });

  it('finds nothing in a catalogue that has none of them', () => {
    expect(detectFieldAliases([{ id: 'summary', name: 'Summary' }], {})).toEqual({});
    expect(detectFieldAliases([], {})).toEqual({});
  });

  it('ignores a field with no name at all', () => {
    expect(detectFieldAliases([{ id: 'cf_1', name: null }], {})).toEqual({});
  });
});
