import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APPSTORE_DEAD_STATES, APPSTORE_HIGH_STATES, APPSTORE_LIVE_STATES, humanState } from '../../shared/status';
import type { AppStoreApp, AppStoreSnapshot, AppStoreVersion, NewEvent } from '../../shared/types';
import type { StoreAccountConfig } from '../config';
import { importPrivateKey, signJwt } from '../jwt';
import { SourceError } from './types';
import type { Source, SourceContext } from './types';

export interface AppStoreAccount {
  name: string;
  issuerId: string;
  keyId: string;
  privateKeyPem: string;
}
export interface AppStoreConfig {
  accounts: AppStoreAccount[];
}

export const ASC_API = 'https://api.appstoreconnect.apple.com/v1';
const TOKEN_TTL_SEC = 15 * 60;

export class AscTokenCache {
  private cache = new Map<string, { token: string; expMs: number }>();

  async token(acc: AppStoreAccount, now: number = Date.now()): Promise<string> {
    const hit = this.cache.get(acc.keyId);
    if (hit && hit.expMs - 60_000 > now) return hit.token;
    const key = await importPrivateKey(acc.privateKeyPem, 'ES256');
    const iat = Math.floor(now / 1000);
    const exp = iat + TOKEN_TTL_SEC;
    const token = await signJwt({ alg: 'ES256', header: { kid: acc.keyId }, payload: { iss: acc.issuerId, iat, exp, aud: 'appstoreconnect-v1' }, key });
    this.cache.set(acc.keyId, { token, expMs: exp * 1000 });
    return token;
  }
}

interface RawApp { id: string; attributes: { name: string; bundleId: string } }
interface RawVersion { id: string; attributes: { versionString: string; appStoreState?: string | null; appVersionState?: string | null; createdAt?: string } }

export function parseAscApps(raw: unknown): { id: string; name: string; bundleId: string }[] {
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new SourceError('App Store Connect /apps: unexpected response shape');
  return (data as RawApp[]).map((a) => ({ id: a.id, name: a.attributes.name, bundleId: a.attributes.bundleId }));
}

export function summarizeVersions(raw: unknown): { live: AppStoreVersion | null; inflight: AppStoreVersion | null } {
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new SourceError('App Store Connect /appStoreVersions: unexpected response shape');
  const versions = (data as RawVersion[])
    .map((v) => ({ version: v.attributes.versionString, state: v.attributes.appVersionState ?? v.attributes.appStoreState ?? 'UNKNOWN', createdAt: v.attributes.createdAt ?? '' }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const live = versions.find((v) => APPSTORE_LIVE_STATES.has(v.state)) ?? null;
  const inflight = versions.find((v) => v !== live && !APPSTORE_LIVE_STATES.has(v.state) && !APPSTORE_DEAD_STATES.has(v.state) && (!live || v.createdAt >= live.createdAt)) ?? null;
  const strip = (v: typeof live): AppStoreVersion | null => (v ? { version: v.version, state: v.state } : null);
  return { live: strip(live), inflight: strip(inflight) };
}

export async function ascJson(fetchImpl: typeof fetch, token: string, path: string, accountName: string): Promise<unknown> {
  const res = await fetchImpl(`${ASC_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) throw new SourceError(`App Store Connect ${path}: HTTP ${res.status}`, `App Store key for account ${accountName} rejected`);
  if (!res.ok) throw new SourceError(`App Store Connect ${path} (${accountName}): HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const tokens = new AscTokenCache();
export const ascAppUrl = (appId: string): string => `https://appstoreconnect.apple.com/apps/${appId}/distribution`;

export async function fetchAppStore(ctx: SourceContext<AppStoreConfig>): Promise<AppStoreSnapshot> {
  const apps: AppStoreApp[] = [];
  for (const acc of ctx.config.accounts) {
    const token = await tokens.token(acc, ctx.now());
    const list = parseAscApps(await ascJson(ctx.fetch, token, '/apps?limit=200', acc.name));
    for (const app of list) {
      const versions = summarizeVersions(await ascJson(ctx.fetch, token, `/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=5`, acc.name));
      apps.push({ account: acc.name, appId: app.id, name: app.name, bundleId: app.bundleId, live: versions.live, inflight: versions.inflight, url: ascAppUrl(app.id) });
    }
  }
  return { apps };
}

const versionKey = (v: AppStoreVersion | null) => (v ? `${v.version}@${v.state}` : '');

export function diffAppStore(prev: AppStoreSnapshot | null, next: AppStoreSnapshot): NewEvent[] {
  if (!prev) return [];
  const before = new Map(prev.apps.map((a) => [`${a.account}/${a.appId}`, a]));
  const events: NewEvent[] = [];
  for (const app of next.apps) {
    const id = `${app.account}/${app.appId}`;
    const p = before.get(id);
    if (!p) continue;
    const changed: AppStoreVersion[] = [];
    if (versionKey(p.inflight) !== versionKey(app.inflight) && app.inflight) changed.push(app.inflight);
    if (versionKey(p.live) !== versionKey(app.live) && app.live) changed.push(app.live);
    for (const v of changed) {
      events.push({
        source: 'appstore',
        kind: 'store.state_changed',
        priority: APPSTORE_HIGH_STATES.has(v.state) ? 'high' : 'normal',
        itemId: id,
        title: `${app.name} iOS ${v.version}: ${humanState(v.state)}`,
        url: app.url,
      });
    }
  }
  return events;
}

export const appstoreSource: Source<AppStoreSnapshot, AppStoreConfig> = {
  id: 'appstore',
  defaultIntervalSec: 600,
  fetch: fetchAppStore,
  diff: diffAppStore,
};

export function loadAppStoreAccounts(
  accounts: StoreAccountConfig[],
  configDir: string,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): AppStoreAccount[] {
  return accounts
    .filter((a): a is StoreAccountConfig & { appstore: NonNullable<StoreAccountConfig['appstore']> } => !!a.appstore)
    .map((a) => ({ name: a.name, issuerId: a.appstore.issuerId, keyId: a.appstore.keyId, privateKeyPem: readFile(resolve(configDir, a.appstore.keyFile)) }));
}
