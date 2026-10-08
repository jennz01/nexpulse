import { readText } from '../config';
import { resolve } from 'node:path';
import { humanState } from '../../shared/status';
import type { NewEvent, PlayApp, PlayFoundApp, PlayRelease, PlaySnapshot } from '../../shared/types';
import type { PlayAppConfig, StoreAccountConfig } from '../config';
import { importPrivateKey, signJwt } from '../jwt';
import { SourceError } from './types';
import type { Source, SourceContext } from './types';

export interface PlayAccount {
  name: string;
  /** '' when not set; only used to open the right developer account in Play Console. */
  developerId: string;
  clientEmail: string;
  privateKeyPem: string;
  tokenUri: string;
  apps: PlayAppConfig[];
}
export interface PlayConfig {
  accounts: PlayAccount[];
}

export const PLAY_API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
/** The Android Publisher API has no "list my apps"; the Reporting API's apps:search does, with the same key. */
export const REPORTING_API = 'https://playdeveloperreporting.googleapis.com/v1beta1';
export const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting';

export class PlayTokenCache {
  private cache = new Map<string, { token: string; expMs: number }>();

  async token(acc: PlayAccount, fetchImpl: typeof fetch, now: number = Date.now()): Promise<string> {
    const hit = this.cache.get(acc.clientEmail);
    if (hit && hit.expMs - 60_000 > now) return hit.token;
    const key = await importPrivateKey(acc.privateKeyPem, 'RS256');
    const iat = Math.floor(now / 1000);
    const assertion = await signJwt({ alg: 'RS256', payload: { iss: acc.clientEmail, scope: PLAY_SCOPE, aud: acc.tokenUri, iat, exp: iat + 3600 }, key });
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    const res = await fetchImpl(acc.tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new SourceError(`Google token exchange for ${acc.name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, `Play service account for account ${acc.name} rejected or not invited`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new SourceError(`Google token exchange for ${acc.name}: no access_token`);
    this.cache.set(acc.clientEmail, { token: json.access_token, expMs: now + (json.expires_in ?? 3600) * 1000 });
    return json.access_token;
  }
}

interface RawTrack { track: string; releases?: Array<{ name?: string; versionCodes?: string[]; status?: string; userFraction?: number }> }

export function parseTracks(raw: unknown): PlayRelease[] {
  const list = (raw as { tracks?: unknown }).tracks;
  if (!Array.isArray(list)) throw new SourceError('Google Play tracks: unexpected response shape');
  return (list as RawTrack[]).flatMap((t) =>
    (t.releases ?? []).map((r) => ({
      track: t.track,
      name: r.name ?? null,
      versionCodes: r.versionCodes ?? [],
      status: r.status ?? 'statusUnspecified',
      userFraction: typeof r.userFraction === 'number' ? r.userFraction : null,
    })),
  );
}

async function playFetch(fetchImpl: typeof fetch, token: string, url: string, accountName: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetchImpl(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) } });
  if (res.status === 401 || res.status === 403) throw new SourceError(`Google Play ${url}: HTTP ${res.status}`, `Play service account for account ${accountName} rejected or not invited`);
  if (!res.ok) throw new SourceError(`Google Play ${url} (${accountName}): HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

export async function readReleases(fetchImpl: typeof fetch, token: string, packageName: string, accountName: string): Promise<PlayRelease[]> {
  const base = `${PLAY_API}/${encodeURIComponent(packageName)}/edits`;
  const edit = (await (await playFetch(fetchImpl, token, base, accountName, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json()) as { id?: string };
  if (!edit.id) throw new SourceError(`Google Play edits.insert for ${packageName}: no edit id`);
  try {
    return parseTracks(await (await playFetch(fetchImpl, token, `${base}/${edit.id}/tracks`, accountName)).json());
  } finally {
    await fetchImpl(`${base}/${edit.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
}

/** Every app the service account can see, sorted by title. */
export async function searchApps(fetchImpl: typeof fetch, token: string, accountName: string): Promise<PlayFoundApp[]> {
  const found: PlayFoundApp[] = [];
  let pageToken = '';
  do {
    const url = `${REPORTING_API}/apps:search?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (res.status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(body)) {
        throw new SourceError(`Google Play apps:search (${accountName}): HTTP 403 ${body}`, `Enable the Google Play Developer Reporting API in the Cloud project of the ${accountName} service account`);
      }
      if (res.status === 401 || res.status === 403) throw new SourceError(`Google Play apps:search: HTTP ${res.status}`, `Play service account for account ${accountName} rejected or not invited`);
      throw new SourceError(`Google Play apps:search (${accountName}): HTTP ${res.status} ${body}`);
    }
    const json = (await res.json()) as { apps?: Array<{ packageName?: string; displayName?: string }>; nextPageToken?: string };
    for (const a of json.apps ?? []) if (a.packageName) found.push({ packageName: a.packageName, displayName: a.displayName || a.packageName });
    pageToken = json.nextPageToken ?? '';
  } while (pageToken);
  return found.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The account's app list in Play Console; Google's APIs do not expose the console's per-app ids. */
export const playConsoleUrl = (acc: PlayAccount): string =>
  acc.developerId ? `https://play.google.com/console/u/0/developers/${acc.developerId}/app-list` : 'https://play.google.com/console/';

/** Found apps minus the hidden ones, under their overridden names. */
export function visibleApps(found: PlayFoundApp[], overrides: PlayAppConfig[]): { packageName: string; name: string }[] {
  const byPackage = new Map(overrides.map((o) => [o.packageName, o]));
  return found
    .filter((f) => !byPackage.get(f.packageName)?.hidden)
    .map((f) => ({ packageName: f.packageName, name: byPackage.get(f.packageName)?.name ?? f.displayName }));
}

const tokens = new PlayTokenCache();

export async function fetchPlay(ctx: SourceContext<PlayConfig>): Promise<PlaySnapshot> {
  const apps: PlayApp[] = [];
  for (const acc of ctx.config.accounts) {
    const token = await tokens.token(acc, ctx.fetch, ctx.now());
    for (const app of visibleApps(await searchApps(ctx.fetch, token, acc.name), acc.apps)) {
      // Only production matters here; test tracks (internal, alpha, beta, custom) would just add noise and events.
      const releases = (await readReleases(ctx.fetch, token, app.packageName, acc.name)).filter((r) => r.track === 'production');
      apps.push({ account: acc.name, packageName: app.packageName, name: app.name, releases, url: playConsoleUrl(acc) });
    }
  }
  return { apps };
}

const releaseKey = (r: PlayRelease) => `${r.name ?? ''}|${r.versionCodes.join(',')}|${r.status}|${r.userFraction ?? ''}`;

export function diffPlay(prev: PlaySnapshot | null, next: PlaySnapshot): NewEvent[] {
  if (!prev) return [];
  // A track can hold several releases at once (live + staged rollout), so compare against all of them.
  const before = new Map<string, Set<string>>();
  for (const a of prev.apps) {
    for (const r of a.releases) {
      const id = `${a.account}/${a.packageName}/${r.track}`;
      before.set(id, (before.get(id) ?? new Set()).add(releaseKey(r)));
    }
  }
  const events: NewEvent[] = [];
  for (const app of next.apps) {
    for (const r of app.releases) {
      const id = `${app.account}/${app.packageName}/${r.track}`;
      const p = before.get(id);
      if (!p || p.has(releaseKey(r))) continue;
      const pct = r.userFraction != null ? ` ${Math.round(r.userFraction * 100)}%` : '';
      events.push({
        source: 'playstore',
        kind: 'store.state_changed',
        priority: r.status === 'halted' ? 'high' : 'normal',
        itemId: id,
        title: `${app.name} Android ${r.track} ${r.name ?? r.versionCodes.join(',')}: ${humanState(r.status)}${pct}`,
        url: app.url,
      });
    }
  }
  return events;
}

export const playstoreSource: Source<PlaySnapshot, PlayConfig> = {
  id: 'playstore',
  defaultIntervalSec: 600,
  fetch: fetchPlay,
  diff: diffPlay,
};

export function loadPlayAccounts(
  accounts: StoreAccountConfig[],
  configDir: string,
  readFile: (path: string) => string = (p) => readText(p),
): PlayAccount[] {
  return accounts
    .filter((a): a is StoreAccountConfig & { play: NonNullable<StoreAccountConfig['play']> } => !!a.play)
    .map((a) => {
      const sa = JSON.parse(readFile(resolve(configDir, a.play.serviceAccountFile))) as { client_email?: string; private_key?: string; token_uri?: string };
      if (!sa.client_email || !sa.private_key) throw new Error(`service account file for ${a.name} lacks client_email/private_key`);
      return { name: a.name, developerId: a.play.developerId ?? '', clientEmail: sa.client_email, privateKeyPem: sa.private_key, tokenUri: sa.token_uri ?? 'https://oauth2.googleapis.com/token', apps: a.play.apps };
    });
}
