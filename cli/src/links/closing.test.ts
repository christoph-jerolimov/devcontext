/**
 * Reading "fixes #12" out of a pull request body.
 *
 * The failure to guard is over-matching. A bare `#12` is accepted here and
 * nowhere else in the codebase, so anything that loosens what counts as a
 * closing keyword starts inventing links between unrelated items — and a wrong
 * link looks exactly like a right one.
 */

import { describe, expect, it } from 'vitest';

import { extractClosingReferences } from './closing.js';

const OWN = 'acme/platform';

function refs(text: string): string[] {
  return extractClosingReferences(text, OWN).map(
    (found) => `${found.repo}#${String(found.number)}`,
  );
}

describe('closing references', () => {
  it('reads every form GitHub itself acts on', () => {
    expect(refs('Fixes #12')).toEqual(['acme/platform#12']);
    expect(refs('closes acme/other#7')).toEqual(['acme/other#7']);
    expect(refs('Resolved https://github.com/acme/other/issues/9')).toEqual(['acme/other#9']);
    expect(refs('fix: #3')).toEqual(['acme/platform#3']);
  });

  it('takes every keyword GitHub takes, and no others', () => {
    for (const word of [
      'close',
      'closes',
      'closed',
      'fix',
      'fixes',
      'fixed',
      'resolve',
      'resolves',
      'resolved',
    ]) {
      expect([word, refs(`${word} #5`)]).toEqual([word, ['acme/platform#5']]);
    }
    // Words that read like a promise and are not one. GitHub ignores these too.
    expect(refs('addresses #5')).toEqual([]);
    expect(refs('see #5')).toEqual([]);
    expect(refs('reverts #5')).toEqual([]);
  });

  it('ignores a bare number with no keyword in front of it', () => {
    /*
     * The reason bare references are refused everywhere else: prose is full of
     * them. Without the keyword anchoring it, "step #3 failed" would link this
     * pull request to an unrelated issue and look completely ordinary doing it.
     */
    expect(refs('step #3 failed on the runner')).toEqual([]);
    expect(refs('rate limit #429 is not an issue number')).toEqual([]);
  });

  it('does not read a mention as a promise', () => {
    // "fixes the thing in #12" is prose about an issue. GitHub does not close
    // #12 for it, and neither should this.
    expect(refs('fixes the crash reported in #12')).toEqual([]);
    expect(refs('this partially fixes what #12 describes')).toEqual([]);
  });

  it('resolves a bare reference against the repository it was written in', () => {
    // A bare #12 means nothing without one, and guessing would produce links
    // pointing at the wrong project.
    expect(extractClosingReferences('fixes #12', 'other/repo')[0]?.repo).toBe('other/repo');
  });

  it('keeps several, and each of them once', () => {
    expect(refs('Fixes #1, fixes #2 and closes #1')).toEqual([
      'acme/platform#1',
      'acme/platform#2',
    ]);
  });

  it('records which word was used, so a row can say what produced it', () => {
    expect(extractClosingReferences('Resolves #4', OWN)[0]?.keyword).toBe('resolves');
  });

  it('says nothing about an empty body', () => {
    expect(extractClosingReferences(null, OWN)).toEqual([]);
    expect(extractClosingReferences('', OWN)).toEqual([]);
  });
});
