import { expect, mock, test } from 'bun:test';
import { notifyHighEvents, toastable, updateTitle } from './notify';
import type { Event } from '../../shared/types';

const ev = (id: number, priority: 'high' | 'normal'): Event => ({ id, source: 'github', kind: 'pr.review_requested', priority, itemId: `i${id}`, title: `T${id}`, url: null, createdAt: 0, seen: false });

test('updateTitle shows the unread count unless alerts are off', () => {
  updateTitle(3, 'badge'); expect(document.title).toBe('(3) NexPulse');
  updateTitle(3, 'off'); expect(document.title).toBe('NexPulse');
  updateTitle(0, 'toast'); expect(document.title).toBe('NexPulse');
});

test('notifyHighEvents fires one notification per high event in toast mode only', () => {
  const created: string[] = [];
  class FakeNotification { static permission = 'granted'; onclick: (() => void) | null = null; constructor(title: string) { created.push(title); } close() {} }
  const onClick = mock(() => {});
  notifyHighEvents([ev(1, 'high'), ev(2, 'normal'), ev(3, 'high')], 'toast', onClick, FakeNotification as unknown as typeof Notification);
  expect(created).toEqual(['T1', 'T3']);
  created.length = 0;
  notifyHighEvents([ev(1, 'high')], 'badge', onClick, FakeNotification as unknown as typeof Notification);
  expect(created).toEqual([]);
  FakeNotification.permission = 'denied';
  notifyHighEvents([ev(1, 'high')], 'toast', onClick, FakeNotification as unknown as typeof Notification);
  expect(created).toEqual([]);
});

test('toastable: nothing on first load, only new ids after, then nothing again', () => {
  const seen = new Set<number>();
  const first = [ev(1, 'high'), ev(2, 'normal')];
  expect(toastable(first, seen, true)).toEqual([]);
  expect(seen.has(1)).toBe(true);
  expect(seen.has(2)).toBe(true);

  const withNew = [...first, ev(3, 'high')];
  expect(toastable(withNew, seen, false)).toEqual([ev(3, 'high')]);

  expect(toastable(withNew, seen, false)).toEqual([]);
});
