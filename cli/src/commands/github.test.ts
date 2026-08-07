/**
 * How a pull request state and a run conclusion are meant to read.
 *
 * The colours carry meaning rather than decoration — "merged" and "closed"
 * are the same state to GitHub but opposite outcomes to a reader, and a run
 * somebody cancelled is not a run that failed.
 */
import { describe, expect, it } from 'vitest';

import { conclusionColour, pullRequestState, pullRequestStateColour } from './github.js';
import type { PullRequestRow } from '../db/queries/github.js';

const pull = (state: string, merged: boolean): PullRequestRow =>
  ({ state, merged: merged ? 1 : 0 }) as unknown as PullRequestRow;

describe('pull request state', () => {
  it('calls a merged pull request merged, which GitHub does not', () => {
    // GitHub stores a merged pull request as `closed` with a merge commit.
    expect(pullRequestState(pull('closed', true))).toBe('merged');
    expect(pullRequestStateColour(pull('closed', true))).toBe('purple');
  });

  it('separates closed-without-merging from merged', () => {
    // The work was dropped: worth spotting in a list, and the opposite
    // outcome from the row above despite the identical `state`.
    expect(pullRequestState(pull('closed', false))).toBe('closed');
    expect(pullRequestStateColour(pull('closed', false))).toBe('red');
  });

  it('leaves an open pull request green', () => {
    expect(pullRequestState(pull('open', false))).toBe('open');
    expect(pullRequestStateColour(pull('open', false))).toBe('green');
  });
});

describe('run conclusion', () => {
  it('does not paint a cancelled run as a failure', () => {
    expect(conclusionColour('cancelled')).toBe('gray');
    expect(conclusionColour('skipped')).toBe('gray');
  });

  it('marks the outcomes that need attention', () => {
    expect(conclusionColour('success')).toBe('green');
    expect(conclusionColour('failure')).toBe('red');
    expect(conclusionColour('timed_out')).toBe('red');
  });

  it('falls back to a neutral colour for anything unrecognised', () => {
    // A run still going has no conclusion yet, and GitHub adds new ones.
    expect(conclusionColour(null)).toBe('yellow');
    expect(conclusionColour('action_required')).toBe('yellow');
  });
});
