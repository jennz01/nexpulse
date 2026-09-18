import { describe, expect, test } from 'bun:test';
import { initialState, panelForEvent, reducer, unreadByPanel, unreadItems } from './state';
import type { Event, StateResponse } from '../../shared/types';
import { emptyStates } from '../../shared/attention';

const ev = (id: number, kind: string, itemId = `i${id}`): Event => ({ id, source: 'github', kind, priority: 'high', itemId, title: 't', url: null, createdAt: id, seen: false });
const loaded: StateResponse = {
  states: emptyStates(),
  events: [ev(1, 'pr.review_requested')],
  config: { intervals: { github: 60, codemagic: 120, lark: 120, appstore: 600, playstore: 600 }, larkDomain: 'd', accounts: [], pendingLaunchStatus: 'P', collapsedStatuses: [], showIssueStatuses: ['OPEN', 'CHECKING'], taskFormUrl: null, feedbackGroupOrder: [], githubRepos: [] },
};

describe('reducer', () => {
  test('loaded replaces states, events and config', () => {
    const s = reducer(initialState, { type: 'loaded', payload: loaded });
    expect(s.loaded).toBe(true);
    expect(s.events).toHaveLength(1);
    expect(s.config?.larkDomain).toBe('d');
  });

  test('sse patches one source, appends new events and keeps the disabled flag', () => {
    const start = reducer(initialState, { type: 'loaded', payload: { ...loaded, states: { ...loaded.states, github: { ...loaded.states.github, disabled: 'x' } } } });
    const s = reducer(start, { type: 'sse', now: 5, payload: { source: 'github', state: { snapshot: { login: 'j', incoming: [], mine: [] }, fetchedAt: 4, error: null, errorAt: null, disabled: null }, events: [ev(1, 'pr.review_requested'), ev(2, 'pr.ci_failed')] } });
    expect(s.states.github.fetchedAt).toBe(4);
    expect(s.states.github.disabled).toBe('x');
    expect(s.events.map((e) => e.id)).toEqual([1, 2]);
    expect(s.lastMessageAt).toBe(5);
  });

  test('seen and seenSource drop events', () => {
    const start = reducer(initialState, { type: 'loaded', payload: { ...loaded, events: [ev(1, 'a'), ev(2, 'b'), { ...ev(3, 'c'), source: 'lark' }] } });
    expect(reducer(start, { type: 'seen', ids: [1] }).events.map((e) => e.id)).toEqual([2, 3]);
    expect(reducer(start, { type: 'seenSource', source: 'github' }).events.map((e) => e.id)).toEqual([3]);
  });
});

describe('unread helpers', () => {
  test('panelForEvent maps kinds to panels', () => {
    expect(panelForEvent(ev(1, 'pr.review_requested'))).toBe('prs');
    expect(panelForEvent(ev(1, 'build.failed'))).toBe('builds');
    expect(panelForEvent(ev(1, 'issue.opened'))).toBe('issues');
    expect(panelForEvent(ev(1, 'feedback.new'))).toBe('feedback');
    expect(panelForEvent(ev(1, 'store.state_changed'))).toBe('stores');
    expect(panelForEvent(ev(1, 'weird'))).toBeNull();
  });
  test('unreadByPanel and unreadItems', () => {
    const events = [ev(1, 'pr.review_requested', 'a'), ev(2, 'pr.ci_failed', 'a'), ev(3, 'build.failed', 'b')];
    expect(unreadByPanel(events).prs.map((e) => e.id)).toEqual([1, 2]);
    expect(unreadByPanel(events).tasks).toEqual([]);
    expect([...unreadItems(events, 'prs').entries()]).toEqual([['a', [1, 2]]]);
  });
});
