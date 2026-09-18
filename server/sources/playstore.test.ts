import { describe, expect, test } from 'bun:test';
import tracks from './__fixtures__/play-tracks.json';
import { PlayTokenCache, diffPlay, fetchPlay, loadPlayAccounts, parseTracks, playConsoleUrl } from './playstore';
import type { PlayAccount } from './playstore';
import type { SourceContext } from './types';
import type { PlayApp, PlaySnapshot } from '../../shared/types';

async function testAccount(): Promise<PlayAccount> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return { name: 'Acc', developerId: '999', clientEmail: 'sa@example.iam.gserviceaccount.com', privateKeyPem: pem, tokenUri: 'https://oauth2.googleapis.com/token', apps: [{ packageName: 'com.x.app', name: 'SGPOS' }] };
}
const fakeFetch = (handler: (url: string, init?: RequestInit) => Response): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;

describe('parseTracks', () => {
  test('flattens releases across tracks and drops empty tracks', () => {
    expect(parseTracks(tracks)).toEqual([
      { track: 'production', name: '3.47.1', versionCodes: ['347102'], status: 'completed', userFraction: null },
      { track: 'beta', name: '3.47.2', versionCodes: ['347201'], status: 'inProgress', userFraction: 0.2 },
    ]);
  });
  test('rejects an unexpected shape', () => {
    expect(() => parseTracks({})).toThrow('unexpected response shape');
  });
});

describe('PlayTokenCache', () => {
  test('exchanges a signed assertion for an access token and caches it', async () => {
    const acc = await testAccount();
    let posted: URLSearchParams | null = null;
    let calls = 0;
    const f = fakeFetch((url, init) => { calls++; expect(url).toBe(acc.tokenUri); posted = new URLSearchParams(String(init?.body)); return Response.json({ access_token: 'ya29.x', expires_in: 3600 }); });
    const cache = new PlayTokenCache();
    expect(await cache.token(acc, f, 1_000_000_000_000)).toBe('ya29.x');
    expect(posted!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = JSON.parse(atob(posted!.get('assertion')!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(claims).toMatchObject({ iss: acc.clientEmail, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: acc.tokenUri });
    await cache.token(acc, f, 1_000_000_000_000 + 1000);
    expect(calls).toBe(1);
  });
});

describe('fetchPlay', () => {
  test('creates an edit, reads tracks, deletes the edit', async () => {
    const acc = await testAccount();
    const seen: string[] = [];
    const f = fakeFetch((url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/token')) return Response.json({ access_token: 't', expires_in: 3600 });
      if (url.endsWith('/edits') && init?.method === 'POST') return Response.json({ id: 'edit1' });
      if (url.endsWith('/edits/edit1/tracks')) return Response.json(tracks);
      if (url.endsWith('/edits/edit1') && init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('nope', { status: 404 });
    });
    const ctx: SourceContext<{ accounts: PlayAccount[] }> = { config: { accounts: [acc] }, run: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }), fetch: f, log: () => {}, now: Date.now };
    const snap = await fetchPlay(ctx);
    expect(snap.apps).toHaveLength(1);
    expect(snap.apps[0]).toMatchObject({ account: 'Acc', packageName: 'com.x.app', name: 'SGPOS', url: 'https://play.google.com/console/u/0/developers/999/app-list' });
    expect(snap.apps[0]?.releases.map((r) => r.track)).toEqual(['production', 'beta']);
    expect(seen.some((s) => s.startsWith('DELETE ') && s.endsWith('/edits/edit1'))).toBe(true);
  });

  test('a 403 names the account', async () => {
    const acc = await testAccount();
    const f = fakeFetch((url) => (url.endsWith('/token') ? Response.json({ access_token: 't', expires_in: 3600 }) : new Response('{}', { status: 403 })));
    const ctx: SourceContext<{ accounts: PlayAccount[] }> = { config: { accounts: [acc] }, run: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }), fetch: f, log: () => {}, now: Date.now };
    await expect(fetchPlay(ctx)).rejects.toMatchObject({ hint: 'Play service account for account Acc rejected or not invited' });
  });
});

test('playConsoleUrl prefers the configured url', () => {
  const acc = { developerId: '999' } as PlayAccount;
  expect(playConsoleUrl(acc, { packageName: 'p', name: 'n', consoleUrl: 'https://c' })).toBe('https://c');
  expect(playConsoleUrl(acc, { packageName: 'p', name: 'n' })).toBe('https://play.google.com/console/u/0/developers/999/app-list');
});

const app = (releases: PlayApp['releases']): PlayApp => ({ account: 'Acc', packageName: 'com.x.app', name: 'SGPOS', releases, url: 'u' });
const snap = (...apps: PlayApp[]): PlaySnapshot => ({ apps });

describe('diffPlay', () => {
  const prod = { track: 'production', name: '3.47.1', versionCodes: ['347102'], status: 'completed', userFraction: null };
  test('first snapshot produces nothing', () => {
    expect(diffPlay(null, snap(app([prod])))).toEqual([]);
  });
  test('a rollout change is normal, a halt is high, no change is nothing', () => {
    const rolling = { track: 'production', name: '3.47.2', versionCodes: ['347201'], status: 'inProgress', userFraction: 0.2 };
    expect(diffPlay(snap(app([prod])), snap(app([rolling])))).toEqual([
      { source: 'playstore', kind: 'store.state_changed', priority: 'normal', itemId: 'Acc/com.x.app/production', title: 'SGPOS Android production 3.47.2: In progress 20%', url: 'u' },
    ]);
    expect(diffPlay(snap(app([rolling])), snap(app([{ ...rolling, status: 'halted' }])))[0]?.priority).toBe('high');
    expect(diffPlay(snap(app([prod])), snap(app([prod])))).toEqual([]);
  });
});

test('loadPlayAccounts reads the service-account json', () => {
  const sa = JSON.stringify({ client_email: 'sa@x', private_key: 'PEM', token_uri: 'https://t' });
  const out = loadPlayAccounts([{ name: 'A', play: { serviceAccountFile: 'secrets/p.json', developerId: '1', apps: [{ packageName: 'p', name: 'n' }] } }, { name: 'B' }], 'C:/repo/config', () => sa);
  expect(out).toEqual([{ name: 'A', developerId: '1', clientEmail: 'sa@x', privateKeyPem: 'PEM', tokenUri: 'https://t', apps: [{ packageName: 'p', name: 'n' }] }]);
});
