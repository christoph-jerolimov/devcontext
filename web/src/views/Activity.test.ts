/**
 * The activity window values.
 *
 * The failure worth guarding is silent: a window that resolves to nothing
 * renders an empty feed, and an empty feed is exactly what a quiet fortnight
 * looks like — so a broken value never announces itself.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_WINDOW, hoursFor, WINDOWS } from './Activity.tsx';

describe('the activity windows', () => {
  it('offers the hour-scale windows a feed needs between meetings', () => {
    const hours = WINDOWS.filter((entry) => entry.hours < 24).map((entry) => entry.value);

    expect(hours).toEqual(['1h', '2h', '4h', '8h', '12h']);
  });

  it('reads each label as the span it actually asks for', () => {
    expect(hoursFor('1h')).toBe(1);
    expect(hoursFor('12h')).toBe(12);
    expect(hoursFor('1d')).toBe(24);
    expect(hoursFor('90d')).toBe(90 * 24);
  });

  it('lists them shortest first, so the dropdown reads in one direction', () => {
    const spans = WINDOWS.map((entry) => entry.hours);

    expect(spans).toEqual(spans.toSorted((a, b) => a - b));
  });

  it('falls back rather than reaching back nothing', () => {
    // A stale bookmark or a hand-edited URL. Zero hours would render an empty
    // feed that looks exactly like a quiet fortnight.
    expect(hoursFor('')).toBe(hoursFor(DEFAULT_WINDOW));
    expect(hoursFor('7 days')).toBe(hoursFor(DEFAULT_WINDOW));
  });
});
