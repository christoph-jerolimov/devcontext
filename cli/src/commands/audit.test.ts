/**
 * The audit headings are the only place in the CLI that reached for ANSI
 * directly, and it went wrong in the two ways hand written escapes always do:
 * the ESC byte was missing, so every heading printed a literal
 * `[1m── Where the data lives ──[0m`, and the escape was emitted whether or
 * not anything wanted colour.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { headingFor, subheadingFor } from './audit.js';

const ESC = '';

/** `colorEnabled()` reads both of these, so a test has to drive both. */
function setColour(enabled: boolean): void {
  process.stdout.isTTY = enabled;
  if (enabled) delete process.env['NO_COLOR'];
  else process.env['NO_COLOR'] = '1';
}

afterEach(() => {
  process.stdout.isTTY = false;
  delete process.env['NO_COLOR'];
});

describe('audit headings', () => {
  it('emits a real escape sequence on a terminal', () => {
    setColour(true);

    expect(headingFor('Where the data lives', 'default')).toBe(
      `${ESC}[1m── Where the data lives ──${ESC}[0m`,
    );
    expect(subheadingFor('github · acme/platform', 'default')).toBe(
      `${ESC}[1mgithub · acme/platform${ESC}[0m`,
    );
  });

  it('emits no escape at all when colour is off', () => {
    // Piped into less or grep, which is where the literal codes showed up.
    setColour(false);

    expect(headingFor('Where the data lives', 'default')).toBe('── Where the data lives ──');
    expect(subheadingFor('What is stored', 'default')).toBe('What is stored');
  });

  it('never emits a bracket sequence without the escape byte', () => {
    // The exact regression: `[1m` in the output with no ESC in front of it.
    for (const enabled of [true, false]) {
      setColour(enabled);
      for (const rendered of [headingFor('T', 'default'), subheadingFor('T', 'default')]) {
        expect(rendered.replaceAll(`${ESC}[`, '')).not.toMatch(/\[\d+m/);
      }
    }
  });

  it('uses markdown and plain headings unchanged, with no escapes either way', () => {
    for (const enabled of [true, false]) {
      setColour(enabled);

      expect(headingFor('What is stored', 'markdown')).toBe('## What is stored\n');
      expect(subheadingFor('What is stored', 'markdown')).toBe('### What is stored\n');
      expect(headingFor('What is stored', 'plain')).toBe('# What is stored');
      expect(subheadingFor('What is stored', 'plain')).toBe('## What is stored');
    }
  });
});
