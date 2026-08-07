import { describe, expect, it } from 'vitest';

import { formatDuration, formatRelative, resolveTimeExpression, toDateOnly } from './time.js';

const NOW = new Date('2024-06-15T12:00:00.000Z');

describe('resolveTimeExpression', () => {
  it('understands relative durations', () => {
    expect(resolveTimeExpression('30d', NOW)).toBe('2024-05-16T12:00:00.000Z');
    expect(resolveTimeExpression('2w', NOW)).toBe('2024-06-01T12:00:00.000Z');
    expect(resolveTimeExpression('90m', NOW)).toBe('2024-06-15T10:30:00.000Z');
    expect(resolveTimeExpression('3mo', NOW)).toBe('2024-03-17T12:00:00.000Z');
  });

  it('understands absolute dates', () => {
    expect(resolveTimeExpression('2024-01-31', NOW)).toBe('2024-01-31T00:00:00.000Z');
    expect(resolveTimeExpression('2024-01-31T08:30:00Z', NOW)).toBe('2024-01-31T08:30:00.000Z');
  });

  it('rejects nonsense', () => {
    expect(() => resolveTimeExpression('yesterday', NOW)).toThrow(/Cannot understand/);
  });
});

describe('formatRelative', () => {
  it('formats past and future timestamps', () => {
    expect(formatRelative('2024-06-14T12:00:00.000Z', NOW)).toBe('1d ago');
    expect(formatRelative('2024-06-15T11:30:00.000Z', NOW)).toBe('30m ago');
    expect(formatRelative('2024-06-16T12:00:00.000Z', NOW)).toBe('in 1d');
    expect(formatRelative(null, NOW)).toBe('');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(4500)).toBe('5s');
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(3_960_000)).toBe('1h 6m');
  });
});

describe('toDateOnly', () => {
  it('cuts the time part', () => {
    expect(toDateOnly('2024-06-15T12:00:00.000Z')).toBe('2024-06-15');
  });
});
