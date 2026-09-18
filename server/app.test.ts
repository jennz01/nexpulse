import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApp } from './app';
import { Scheduler } from './scheduler';
import { SseHub } from './sse';
import { Store } from './store';
import type { PublicConfig } from '../shared/types';
import type { SSEStreamingApi } from 'hono/streaming';

const publicConfig: PublicConfig = {
  intervals: { github: 60, codemagic: 120, lark: 120, appstore: 600, playstore: 600 },
  larkDomain: 'example.larksuite.com', accounts: [], pendingLaunchStatus: 'PENDING TO LAUNCH', collapsedStatuses: ['PRODUCTION'], showIssueStatuses: ['OPEN', 'CHECKING'], taskFormUrl: null, feedbackGroupOrder: [], githubRepos: [],
};

let store: Store;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  store = new Store(':memory:');
  const scheduler = new Scheduler([], store, () => {});
  app = createApp({ store, scheduler, hub: new SseHub(), publicConfig, disabled: { codemagic: 'token missing' }, pingIntervalMs: 50 });
});
afterEach(() => store.close());

describe('GET /api/state', () => {
  test('returns states for all sources, unseen events and public config', async () => {
    store.addEvents([{ source: 'github', kind: 'pr.review_requested', priority: 'high', itemId: '1', title: 't', url: null }], 1);
    const res = await app.request('/api/state');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.states).sort()).toEqual(['appstore', 'codemagic', 'github', 'lark', 'playstore']);
    expect(body.states.codemagic.disabled).toBe('token missing');
    expect(body.events).toHaveLength(1);
    expect(body.config.larkDomain).toBe('example.larksuite.com');
  });
});

describe('POST /api/events/seen', () => {
  test('marks by ids', async () => {
    const [e] = store.addEvents([{ source: 'github', kind: 'k', priority: 'high', itemId: '1', title: 't', url: null }], 1);
    const res = await app.request('/api/events/seen', { method: 'POST', body: JSON.stringify({ ids: [e!.id] }), headers: { 'content-type': 'application/json', 'x-requested-with': 'dashboard' } });
    expect(await res.json()).toEqual({ updated: 1 });
    expect(store.unseenEvents()).toEqual([]);
  });

  test('rejects an empty body', async () => {
    const res = await app.request('/api/events/seen', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-requested-with': 'dashboard' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sources/:id/refresh', () => {
  test('404 for an unknown source, 409 for a disabled one', async () => {
    expect((await app.request('/api/sources/nope/refresh', { method: 'POST', headers: { 'x-requested-with': 'dashboard' } })).status).toBe(404);
    expect((await app.request('/api/sources/codemagic/refresh', { method: 'POST', headers: { 'x-requested-with': 'dashboard' } })).status).toBe(409);
  });
});

describe('codemagic routes without a configured client', () => {
  test('trigger returns 409 with the disabled reason', async () => {
    const res = await app.request('/api/codemagic/builds', { method: 'POST', body: JSON.stringify({ appId: 'a', workflowId: 'w', branch: 'main' }), headers: { 'content-type': 'application/json', 'x-requested-with': 'dashboard' } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('token missing');
  });
});

describe('GET /api/events', () => {
  test('is an SSE stream that greets the client', async () => {
    const res = await app.request('/api/events');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('event: hello');
    await reader.cancel();
  });
});

test('GET /api/health reports scheduler status', async () => {
  const res = await app.request('/api/health');
  expect((await res.json()).ok).toBe(true);
});

describe('cross-origin guards', () => {
  test('POST without x-requested-with is 403', async () => {
    const res = await app.request('/api/events/seen', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('missing x-requested-with header');
  });

  test('a Host header outside allowedHosts is 403 while an allowed one passes', async () => {
    const scoped = createApp({ store, scheduler: new Scheduler([], store, () => {}), hub: new SseHub(), publicConfig, disabled: {}, allowedHosts: ['127.0.0.1:6600'] });
    const blocked = await scoped.request('/api/state', { headers: { host: 'evil.example' } });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe('host not allowed');
    const allowed = await scoped.request('/api/state', { headers: { host: '127.0.0.1:6600' } });
    expect(allowed.status).toBe(200);
  });
});

describe('POST /api/dev/emit', () => {
  const body = JSON.stringify({ source: 'github', kind: 'pr.review_requested', title: 'Synthetic' });
  const headers = { 'content-type': 'application/json', 'x-requested-with': 'dashboard' };

  test('is absent unless devEmit is on', async () => {
    expect((await app.request('/api/dev/emit', { method: 'POST', body, headers })).status).toBe(404);
  });

  test('stores a high event and broadcasts it', async () => {
    const hub = new SseHub();
    const writes: string[] = [];
    hub.add({ writeSSE: async (m: { data: string }) => { writes.push(m.data); } } as unknown as SSEStreamingApi);
    const dev = createApp({ store, scheduler: new Scheduler([], store, () => {}), hub, publicConfig, disabled: {}, devEmit: true });
    const res = await dev.request('/api/dev/emit', { method: 'POST', body, headers });
    expect(res.status).toBe(200);
    expect((await res.json()).priority).toBe('high');
    expect(store.unseenEvents()).toHaveLength(1);
    expect(JSON.parse(writes[0]!).events[0].title).toBe('Synthetic');
  });
});
