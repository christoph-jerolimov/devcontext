import { describe, expect, it } from 'vitest';

import { referenceFor, sortLinks } from './CrossLinks.tsx';
import type { CrossLink } from '../api.ts';

function link(ref: string, confidence: CrossLink['confidence'], via = 'title'): CrossLink {
  return { ref, source: ref.includes('#') ? 'github' : 'jira', kind: 'workitem', via, confidence };
}

describe('referenceFor', () => {
  it('builds a GitHub reference from the repository and number', () => {
    expect(referenceFor({ kind: 'pull-request', repository: 'acme/platform', number: 42 })).toBe(
      'acme/platform#42',
    );
  });

  it('uses the key for a work item', () => {
    expect(referenceFor({ kind: 'workitem', key: 'PLAT-7' })).toBe('PLAT-7');
  });

  it('has no reference for a sprint or a workflow run', () => {
    // Neither sits in the cross link graph, so neither gets a Links section.
    expect(referenceFor({ kind: 'sprint', id: 7, name: 'Sprint 7' })).toBeNull();
    expect(referenceFor({ kind: 'workflow-run', id: 99, workflow: 'CI' })).toBeNull();
  });

  it('does not build half a reference from a repository with no number', () => {
    // A document carrying only one half would otherwise produce
    // "acme/platform#undefined" and query for a link that cannot exist.
    expect(referenceFor({ kind: 'issue', repository: 'acme/platform' })).toBeNull();
  });
});

describe('sortLinks', () => {
  it('puts deliberate links above passing mentions', () => {
    const sorted = sortLinks([
      link('PLAT-9', 'medium', 'comment'),
      link('PLAT-1', 'high', 'branch'),
      link('PLAT-5', 'medium', 'body'),
      link('PLAT-3', 'high', 'title'),
    ]);

    expect(sorted.map((entry) => [entry.ref, entry.confidence])).toEqual([
      ['PLAT-1', 'high'],
      ['PLAT-3', 'high'],
      ['PLAT-5', 'medium'],
      ['PLAT-9', 'medium'],
    ]);
  });

  it('leaves the input alone', () => {
    const input = [link('PLAT-9', 'medium'), link('PLAT-1', 'high')];
    sortLinks(input);
    expect(input.map((entry) => entry.ref)).toEqual(['PLAT-9', 'PLAT-1']);
  });
});
