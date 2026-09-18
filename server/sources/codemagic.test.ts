import { describe, expect, test } from 'bun:test';
import apps from './__fixtures__/codemagic-apps.json';
import builds from './__fixtures__/codemagic-builds.json';
import { codemagicJson, codemagicSource, createCodemagicActions, diffCodemagic, isRunning, parseApps, parseBuilds } from './codemagic';
import type { Build, CodemagicSnapshot } from '../../shared/types';

const fakeFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;

describe('parseApps', () => {
  test('maps apps and their workflows', () => {
    const out = parseApps(apps);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 'app1', name: 'SGPOS', workflows: [{ id: 'wf-ios', name: 'ios-release' }, { id: 'wf-android', name: 'android-release' }] });
  });
  test('rejects an unexpected shape', () => {
    expect(() => parseApps({ nope: [] })).toThrow('unexpected response shape');
  });
});

describe('parseBuilds', () => {
  const app = parseApps(apps)[0]!;
  const out = parseBuilds(builds, app);

  test('sorts newest first and maps fields', () => {
    expect(out.map((b) => b.id)).toEqual(['b-run', 'b-fail', 'b-old']);
    expect(out[2]).toMatchObject({ workflowName: 'ios-release', branch: 'develop', status: 'finished', durationSec: 1260, url: 'https://codemagic.io/app/app1/build/b-old' });
    expect(out[2]?.artifacts).toEqual([{ name: 'SGPOS.ipa', type: 'ipa', url: 'https://api.codemagic.io/artifacts/abc/SGPOS.ipa', size: 88080384 }]);
  });
  test('a running build has no duration', () => {
    expect(out[0]?.durationSec).toBeNull();
    expect(isRunning(out[0]!.status)).toBe(true);
    expect(isRunning('failed')).toBe(false);
  });
});

const build = (id: string, status: string, over: Partial<Build> = {}): Build => ({
  id, appId: 'app1', workflowId: 'wf', workflowName: 'ios-release', branch: 'main', status, startedAt: '2026-09-17T00:00:00Z', finishedAt: null,
  durationSec: null, startedBy: null, url: `https://codemagic.io/app/app1/build/${id}`, artifacts: [], ...over,
});
const snap = (...b: Build[]): CodemagicSnapshot => ({ apps: [{ id: 'app1', name: 'SGPOS', workflows: [], builds: b }] });

describe('diffCodemagic', () => {
  test('first snapshot produces nothing', () => {
    expect(diffCodemagic(null, snap(build('a', 'failed')))).toEqual([]);
  });
  test('running -> failed is a high event; running -> finished is normal', () => {
    expect(diffCodemagic(snap(build('a', 'building')), snap(build('a', 'failed')))).toEqual([
      { source: 'codemagic', kind: 'build.failed', priority: 'high', itemId: 'a', title: 'Build failed: SGPOS · ios-release · main', url: 'https://codemagic.io/app/app1/build/a' },
    ]);
    expect(diffCodemagic(snap(build('a', 'building')), snap(build('a', 'finished'))).map((e) => [e.kind, e.priority])).toEqual([['build.finished', 'normal']]);
  });
  test('a build that appears already finished still counts once; canceled and unchanged do not', () => {
    expect(diffCodemagic(snap(), snap(build('n', 'finished'))).map((e) => e.kind)).toEqual(['build.finished']);
    expect(diffCodemagic(snap(build('a', 'building')), snap(build('a', 'canceled')))).toEqual([]);
    expect(diffCodemagic(snap(build('a', 'failed')), snap(build('a', 'failed')))).toEqual([]);
  });
  test('fastIntervalSec is 30 while anything runs', () => {
    expect(codemagicSource.fastIntervalSec!(snap(build('a', 'queued')))).toBe(30);
    expect(codemagicSource.fastIntervalSec!(snap(build('a', 'finished')))).toBeNull();
  });
});

describe('codemagicJson', () => {
  test('adds the token header and parses JSON', async () => {
    let headers: Headers | undefined;
    const f = fakeFetch((_u, init) => { headers = new Headers(init?.headers); return Response.json({ ok: 1 }); });
    expect(await codemagicJson(f, 'tok', '/apps')).toEqual({ ok: 1 });
    expect(headers?.get('x-auth-token')).toBe('tok');
  });
  test('401 carries a token hint', async () => {
    const f = fakeFetch(() => new Response('nope', { status: 401 }));
    await expect(codemagicJson(f, 'tok', '/apps')).rejects.toMatchObject({ hint: expect.stringContaining('CODEMAGIC_API_TOKEN') });
  });
});

describe('createCodemagicActions', () => {
  test('trigger posts appId, workflowId and branch', async () => {
    let body: unknown;
    const f = fakeFetch((url, init) => { if (url.endsWith('/builds') && init?.method === 'POST') { body = JSON.parse(String(init.body)); return Response.json({ buildId: 'new1' }); } return new Response('', { status: 404 }); });
    const actions = createCodemagicActions('tok', () => null, f);
    expect(await actions.trigger({ appId: 'app1', workflowId: 'wf-ios', branch: 'main' })).toEqual({ buildId: 'new1' });
    expect(body).toEqual({ appId: 'app1', workflowId: 'wf-ios', branch: 'main' });
  });

  test('artifact proxies the download with the token and a filename', async () => {
    const snapshot: CodemagicSnapshot = { apps: [{ id: 'app1', name: 'SGPOS', workflows: [], builds: [build('b1', 'finished', { artifacts: [{ name: 'SGPOS.ipa', type: 'ipa', url: 'https://api.codemagic.io/artifacts/x/SGPOS.ipa', size: 3 }] })] }] };
    let tokenSeen: string | null = null;
    const f = fakeFetch((_u: string, init?: RequestInit) => { tokenSeen = new Headers(init?.headers).get('x-auth-token'); return new Response('abc', { headers: { 'content-type': 'application/octet-stream' } }); });
    const res = await createCodemagicActions('tok', () => snapshot, f).artifact('b1', 0);
    expect(tokenSeen as string | null).toBe('tok');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="SGPOS.ipa"');
    expect(await res.text()).toBe('abc');
  });

  test('artifact does not forward the token through a redirect', async () => {
    const snapshot: CodemagicSnapshot = { apps: [{ id: 'app1', name: 'SGPOS', workflows: [], builds: [build('b1', 'finished', { artifacts: [{ name: 'SGPOS.ipa', type: 'ipa', url: 'https://api.codemagic.io/artifacts/x/SGPOS.ipa', size: 3 }] })] }] };
    let storageTokenSeen: string | null | undefined;
    const f = fakeFetch((url, init) => {
      if (url === 'https://api.codemagic.io/artifacts/x/SGPOS.ipa') return new Response(null, { status: 302, headers: { location: 'https://storage.example/x.ipa' } });
      storageTokenSeen = new Headers(init?.headers).get('x-auth-token');
      return new Response('abc');
    });
    const res = await createCodemagicActions('tok', () => snapshot, f).artifact('b1', 0);
    expect(storageTokenSeen).toBeNull();
    expect(await res.text()).toBe('abc');
  });

  test('artifact rejects unknown build or index', async () => {
    const actions = createCodemagicActions('tok', () => null, fakeFetch(() => new Response('')));
    await expect(actions.artifact('nope', 0)).rejects.toThrow('not in the current snapshot');
  });
});
