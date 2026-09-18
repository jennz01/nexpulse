import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Scheduler, backoffDelaySec, chooseDelaySec } from './scheduler';
import { Store } from './store';
import { SourceError } from './sources/types';
import type { RegisteredSource, Source, SourceContext } from './sources/types';
import type { NewEvent, SseMessage } from '../shared/types';

interface Snap { items: string[] }

function makeSource(fetchImpl: () => Promise<Snap>): Source<Snap, {}> {
  return {
    id: 'github',
    defaultIntervalSec: 60,
    fetch: fetchImpl,
    diff(prev, next): NewEvent[] {
      if (!prev) return [];
      return next.items.filter((i) => !prev.items.includes(i)).map((i) => ({
        source: 'github', kind: 'pr.review_requested', priority: 'high', itemId: i, title: i, url: null,
      }));
    },
  };
}

const ctx: SourceContext<{}> = { config: {}, run: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }), fetch, log: () => {}, now: Date.now };

let store: Store;
let updates: SseMessage[];
beforeEach(() => { store = new Store(':memory:'); updates = []; });
afterEach(() => store.close());

function scheduler(reg: RegisteredSource, now = () => 1_000_000) {
  return new Scheduler([reg], store, (m) => updates.push(m), { now });
}

describe('tick', () => {
  test('first tick saves the snapshot and emits no events', async () => {
    const src = makeSource(async () => ({ items: ['a'] }));
    const s = scheduler({ source: src, ctx, intervalSec: 60, disabled: null });
    await s.tick('github');
    expect(store.getSnapshot<Snap>('github')?.data).toEqual({ items: ['a'] });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.events).toEqual([]);
    expect(updates[0]?.state).toMatchObject({ snapshot: { items: ['a'] }, fetchedAt: 1_000_000, error: null });
  });

  test('second tick diffs against the stored snapshot and stores the events', async () => {
    let call = 0;
    const src = makeSource(async () => ({ items: call++ === 0 ? ['a'] : ['a', 'b'] }));
    const s = scheduler({ source: src, ctx, intervalSec: 60, disabled: null });
    await s.tick('github');
    await s.tick('github');
    expect(updates[1]?.events.map((e) => e.itemId)).toEqual(['b']);
    expect(store.unseenEvents().map((e) => e.itemId)).toEqual(['b']);
  });

  test('a failing fetch records the error, keeps the old snapshot and backs off', async () => {
    let call = 0;
    const src = makeSource(async () => {
      if (call++ === 0) return { items: ['a'] };
      throw new SourceError('gh exited 1', 'run `gh auth login`');
    });
    const s = scheduler({ source: src, ctx, intervalSec: 60, disabled: null });
    await s.tick('github');
    await s.tick('github');
    expect(store.getSnapshot<Snap>('github')).toMatchObject({ data: { items: ['a'] }, error: 'gh exited 1 (run `gh auth login`)' });
    expect(updates[1]?.state).toMatchObject({ snapshot: { items: ['a'] }, error: 'gh exited 1 (run `gh auth login`)' });
    expect(s.status().github.consecutiveFailures).toBe(1);
    await s.tick('github');
    expect(s.status().github.consecutiveFailures).toBe(2);
  });

  test('a disabled source never runs', async () => {
    const fetchImpl = mock(async () => ({ items: [] }));
    const s = scheduler({ source: makeSource(fetchImpl), ctx, intervalSec: 60, disabled: 'no token' });
    await s.tick('github');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.status().github.disabled).toBe('no token');
  });

  test('overlapping ticks do not double-fetch', async () => {
    let release: (v: Snap) => void = () => {};
    const fetchImpl = mock(() => new Promise<Snap>((r) => { release = r; }));
    const s = scheduler({ source: makeSource(fetchImpl), ctx, intervalSec: 60, disabled: null });
    const first = s.tick('github');
    await s.tick('github');
    release({ items: [] });
    await first;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('refresh resets the failure count before ticking', async () => {
    let fail = true;
    const src = makeSource(async () => { if (fail) throw new Error('x'); return { items: [] }; });
    const s = scheduler({ source: src, ctx, intervalSec: 60, disabled: null });
    await s.tick('github');
    expect(s.status().github.consecutiveFailures).toBe(1);
    fail = false;
    await s.refresh('github');
    expect(s.status().github.consecutiveFailures).toBe(0);
  });
});

describe('delays', () => {
  test('backoff doubles per failure and caps', () => {
    expect(backoffDelaySec(60, 1, 600)).toBe(120);
    expect(backoffDelaySec(60, 3, 600)).toBe(480);
    expect(backoffDelaySec(60, 4, 600)).toBe(600);
    expect(backoffDelaySec(600, 1, 600)).toBe(600);
  });

  test('chooseDelaySec prefers the fast interval when the source offers one', () => {
    const src: Source<Snap, {}> = { ...makeSource(async () => ({ items: [] })), fastIntervalSec: (s) => (s.items.length ? 30 : null) };
    expect(chooseDelaySec(src, { items: ['x'] }, 120)).toBe(30);
    expect(chooseDelaySec(src, { items: [] }, 120)).toBe(120);
    expect(chooseDelaySec(makeSource(async () => ({ items: [] })), { items: ['x'] }, 120)).toBe(120);
  });
});
