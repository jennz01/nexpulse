import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Store } from './store';
import type { NewEvent } from '../shared/types';

let store: Store;
beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => { store.close(); });

const ev = (itemId: string, priority: 'high' | 'normal' = 'high'): NewEvent => ({
  source: 'github', kind: 'pr.review_requested', priority, itemId, title: `PR ${itemId}`, url: `https://x/${itemId}`,
});

describe('snapshots', () => {
  test('returns null before anything is saved', () => {
    expect(store.getSnapshot('github')).toBeNull();
  });

  test('round-trips a snapshot and clears any previous error', () => {
    store.saveError('github', 'boom', 1000);
    store.saveSnapshot('github', { login: 'jennsg', incoming: [], mine: [] }, 2000);
    expect(store.getSnapshot('github')).toEqual({
      data: { login: 'jennsg', incoming: [], mine: [] }, fetchedAt: 2000, error: null, errorAt: null,
    });
  });

  test('records an error without touching the last good snapshot', () => {
    store.saveSnapshot('lark', { a: 1 }, 1000);
    store.saveError('lark', 'lark-cli exited 1', 3000);
    expect(store.getSnapshot('lark')).toEqual({ data: { a: 1 }, fetchedAt: 1000, error: 'lark-cli exited 1', errorAt: 3000 });
  });

  test('records an error before the first snapshot', () => {
    store.saveError('appstore', '401', 500);
    expect(store.getSnapshot('appstore')).toEqual({ data: null, fetchedAt: null, error: '401', errorAt: 500 });
  });
});

describe('events', () => {
  test('addEvents assigns ids and returns full events', () => {
    const out = store.addEvents([ev('a'), ev('b', 'normal')], 5000);
    expect(out.map((e) => e.id)).toEqual([1, 2]);
    expect(out[1]).toMatchObject({ itemId: 'b', priority: 'normal', createdAt: 5000, seen: false });
  });

  test('addEvents with an empty list is a no-op', () => {
    expect(store.addEvents([], 1)).toEqual([]);
    expect(store.unseenEvents()).toEqual([]);
  });

  test('unseenEvents lists oldest first and markSeen by ids removes them', () => {
    store.addEvents([ev('a')], 1000);
    store.addEvents([ev('b')], 2000);
    expect(store.unseenEvents().map((e) => e.itemId)).toEqual(['a', 'b']);
    expect(store.markSeen({ ids: [1] })).toBe(1);
    expect(store.unseenEvents().map((e) => e.itemId)).toEqual(['b']);
  });

  test('markSeen by source only touches that source', () => {
    store.addEvents([ev('a'), { ...ev('c'), source: 'lark', kind: 'issue.opened' }], 1000);
    expect(store.markSeen({ source: 'lark' })).toBe(1);
    expect(store.unseenEvents().map((e) => e.source)).toEqual(['github']);
  });

  test('markSeen with no filter marks everything', () => {
    store.addEvents([ev('a'), ev('b')], 1000);
    expect(store.markSeen({})).toBe(2);
    expect(store.unseenEvents()).toEqual([]);
  });

  test('pruneEvents deletes events older than maxAge', () => {
    store.addEvents([ev('old')], 1000);
    store.addEvents([ev('new')], 9000);
    expect(store.pruneEvents(5000, 10000)).toBe(1);
    expect(store.unseenEvents().map((e) => e.itemId)).toEqual(['new']);
  });
});

describe('allStates', () => {
  test('returns an entry for every source with disabled reasons applied', () => {
    store.saveSnapshot('github', { login: 'x', incoming: [], mine: [] }, 1000);
    const states = store.allStates({ codemagic: 'token missing' });
    expect(Object.keys(states).sort()).toEqual(['appstore', 'codemagic', 'github', 'lark', 'playstore']);
    expect(states.github.fetchedAt).toBe(1000);
    expect(states.codemagic).toEqual({ snapshot: null, fetchedAt: null, error: null, errorAt: null, disabled: 'token missing' });
  });
});
