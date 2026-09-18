import { expect, test } from 'bun:test';
import { freshness } from './freshness';

const NOW = 1_000_000_000;
const base = { snapshot: null, fetchedAt: null, error: null, errorAt: null, disabled: null };

test('freshness tones', () => {
  expect(freshness({ ...base, disabled: 'no token' }, 60, NOW)).toEqual({ tone: 'grey', label: 'off' });
  expect(freshness(base, 60, NOW)).toEqual({ tone: 'grey', label: 'waiting' });
  expect(freshness({ ...base, fetchedAt: NOW - 30_000 }, 60, NOW)).toEqual({ tone: 'green', label: '30 s' });
  expect(freshness({ ...base, fetchedAt: NOW - 5 * 60_000 }, 60, NOW)).toEqual({ tone: 'amber', label: 'stale 5 min' });
  expect(freshness({ ...base, fetchedAt: NOW - 30_000, error: 'boom', errorAt: NOW }, 60, NOW)).toEqual({ tone: 'red', label: 'error' });
});
