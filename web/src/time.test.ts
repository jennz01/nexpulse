import { expect, test } from 'bun:test';
import { formatClock, formatDay, formatDuration, relativeTime } from './time';

const NOW = Date.parse('2026-09-17T01:41:00Z');

test('relativeTime picks the largest sensible unit', () => {
  expect(relativeTime(NOW - 20_000, NOW)).toBe('just now');
  expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 min');
  expect(relativeTime('2026-09-16T23:41:00Z', NOW)).toBe('2 h');
  expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3 d');
  expect(relativeTime(null, NOW)).toBe('never');
});

test('formatDuration', () => {
  expect(formatDuration(45)).toBe('45 s');
  expect(formatDuration(18 * 60 + 12)).toBe('18 min');
  expect(formatDuration(3720)).toBe('1 h 02 min');
  expect(formatDuration(null)).toBe('');
});

test('formatClock and formatDay use local time', () => {
  const d = new Date(2026, 8, 17, 9, 41).getTime();
  expect(formatClock(d)).toBe('09:41');
  expect(formatDay(d)).toBe('Thu 17 Sep · 09:41');
});
