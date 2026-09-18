import { describe, expect, test } from 'bun:test';
import apps from './__fixtures__/asc-apps.json';
import versions from './__fixtures__/asc-versions.json';
import { AscTokenCache, ascJson, diffAppStore, fetchAppStore, loadAppStoreAccounts, parseAscApps, summarizeVersions } from './appstore';
import type { AppStoreAccount } from './appstore';
import type { SourceContext } from './types';
import type { AppStoreApp, AppStoreSnapshot } from '../../shared/types';
import { humanState } from '../../shared/status';

async function testAccount(): Promise<AppStoreAccount> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return { name: 'Acc', issuerId: 'iss-1', keyId: 'KEY1', privateKeyPem: pem };
}
const fakeFetch = (handler: (url: string, init?: RequestInit) => Response): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;

describe('parseAscApps / summarizeVersions', () => {
  test('maps apps', () => {
    expect(parseAscApps(apps)).toEqual([
      { id: '1111111111', name: 'SGPOS', bundleId: 'com.sitegiant.sgpos' },
      { id: '2222222222', name: 'Shopping App', bundleId: 'com.sitegiant.shopping' },
    ]);
  });
  test('picks the live version and the newest in-flight one, ignoring replaced versions', () => {
    expect(summarizeVersions(versions)).toEqual({ live: { version: '3.47.1', state: 'READY_FOR_DISTRIBUTION' }, inflight: { version: '3.47.2', state: 'REJECTED' } });
  });
  test('falls back to appStoreState and handles no in-flight version', () => {
    const only = { data: [{ id: 'v', attributes: { versionString: '1.0', appStoreState: 'READY_FOR_SALE', createdAt: '2026-01-01T00:00:00Z' } }] };
    expect(summarizeVersions(only)).toEqual({ live: { version: '1.0', state: 'READY_FOR_SALE' }, inflight: null });
  });
  test('humanState reads well', () => {
    expect(humanState('READY_FOR_SALE')).toBe('Ready for Sale');
    expect(humanState('PENDING_DEVELOPER_RELEASE')).toBe('Pending Developer Release');
    expect(humanState('inProgress')).toBe('In progress');
  });
});

describe('AscTokenCache', () => {
  test('issues an ES256 token with kid and caches it for the account', async () => {
    const acc = await testAccount();
    const cache = new AscTokenCache();
    const t1 = await cache.token(acc, 1_000_000_000_000);
    const t2 = await cache.token(acc, 1_000_000_000_000 + 60_000);
    expect(t1).toBe(t2);
    const header = JSON.parse(atob(t1.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'KEY1' });
    const t3 = await cache.token(acc, 1_000_000_000_000 + 16 * 60_000);
    expect(t3).not.toBe(t1);
  });
});

describe('ascJson', () => {
  test('sends a bearer token and names the account on 401', async () => {
    let auth: string | null = null;
    const ok = fakeFetch((_u, init) => { auth = new Headers(init?.headers).get('authorization'); return Response.json({ data: [] }); });
    expect(await ascJson(ok, 'tok', '/apps', 'Acc')).toEqual({ data: [] });
    expect(auth!).toBe('Bearer tok');
    const bad = fakeFetch(() => new Response('{}', { status: 401 }));
    await expect(ascJson(bad, 'tok', '/apps', 'Acc')).rejects.toMatchObject({ hint: 'App Store key for account Acc rejected' });
  });
});

describe('fetchAppStore', () => {
  test('walks every account and app', async () => {
    const acc = await testAccount();
    const f = fakeFetch((url) => (url.includes('/appStoreVersions') ? Response.json(versions) : Response.json(apps)));
    const ctx: SourceContext<{ accounts: AppStoreAccount[] }> = { config: { accounts: [acc] }, run: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }), fetch: f, log: () => {}, now: Date.now };
    const snap = await fetchAppStore(ctx);
    expect(snap.apps.map((a) => [a.account, a.name, a.inflight?.state])).toEqual([['Acc', 'SGPOS', 'REJECTED'], ['Acc', 'Shopping App', 'REJECTED']]);
    expect(snap.apps[0]?.url).toBe('https://appstoreconnect.apple.com/apps/1111111111/distribution');
  });
});

const app = (over: Partial<AppStoreApp> = {}): AppStoreApp => ({
  account: 'Acc', appId: '1', name: 'SGPOS', bundleId: 'b', live: { version: '1.0', state: 'READY_FOR_SALE' }, inflight: null, url: 'u', ...over,
});
const snap = (...apps: AppStoreApp[]): AppStoreSnapshot => ({ apps });

describe('diffAppStore', () => {
  test('first snapshot produces nothing', () => {
    expect(diffAppStore(null, snap(app()))).toEqual([]);
  });
  test('a rejection is high priority, entering review is normal', () => {
    expect(diffAppStore(snap(app()), snap(app({ inflight: { version: '1.1', state: 'REJECTED' } })))).toEqual([
      { source: 'appstore', kind: 'store.state_changed', priority: 'high', itemId: 'Acc/1', title: 'SGPOS iOS 1.1: Rejected', url: 'u' },
    ]);
    expect(diffAppStore(snap(app()), snap(app({ inflight: { version: '1.1', state: 'IN_REVIEW' } })))[0]?.priority).toBe('normal');
  });
  test('a new live version is a normal event; no change is nothing', () => {
    const a = app({ inflight: { version: '1.1', state: 'IN_REVIEW' } });
    const b = app({ live: { version: '1.1', state: 'READY_FOR_SALE' } });
    expect(diffAppStore(snap(a), snap(b)).map((e) => e.title)).toEqual(['SGPOS iOS 1.1: Ready for Sale']);
    expect(diffAppStore(snap(a), snap(a))).toEqual([]);
  });
});

describe('loadAppStoreAccounts', () => {
  test('reads each key file relative to the config dir', () => {
    const accounts = loadAppStoreAccounts(
      [{ name: 'A', appstore: { issuerId: 'i', keyId: 'k', keyFile: 'secrets/a.p8' } }, { name: 'B' }],
      'C:/repo/config',
      (p) => `PEM(${p.replace(/\\/g, '/')})`,
    );
    expect(accounts).toEqual([{ name: 'A', issuerId: 'i', keyId: 'k', privateKeyPem: 'PEM(C:/repo/config/secrets/a.p8)' }]);
  });
});
