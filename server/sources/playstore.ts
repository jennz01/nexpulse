import { readText } from '../config';
import { resolve } from 'node:path';
import { humanState } from '../../shared/status';
import type { NewEvent, PlayApp, PlayRelease, PlaySnapshot } from '../../shared/types';
import type { PlayAppConfig, StoreAccountConfig } from '../config';
import { importPrivateKey, signJwt } from '../jwt';
import { SourceError } from './types';
import type { Source, SourceContext } from './types';

export interface PlayAccount {
  name: string;
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
export const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

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

export const playConsoleUrl = (acc: PlayAccount, app: PlayAppConfig): string =>
  app.consoleUrl ?? `https://play.google.com/console/u/0/developers/${acc.developerId}/app-list`;

const tokens = new PlayTokenCache();

export async function fetchPlay(ctx: SourceContext<PlayConfig>): Promise<PlaySnapshot> {
  const apps: PlayApp[] = [];
  for (const acc of ctx.config.accounts) {
    const token = await tokens.token(acc, ctx.fetch, ctx.now());
    for (const app of acc.apps) {
      const releases = await readReleases(ctx.fetch, token, app.packageName, acc.name);
      apps.push({ account: acc.name, packageName: app.packageName, name: app.name, releases, url: playConsoleUrl(acc, app) });
    }
  }
  return { apps };
}

const releaseKey = (r: PlayRelease) => `${r.name ?? ''}|${r.versionCodes.join(',')}|${r.status}|${r.userFraction ?? ''}`;

export function diffPlay(prev: PlaySnapshot | null, next: PlaySnapshot): NewEvent[] {
  if (!prev) return [];
  const before = new Map<string, PlayRelease>();
  for (const a of prev.apps) for (const r of a.releases) before.set(`${a.account}/${a.packageName}/${r.track}`, r);
  const events: NewEvent[] = [];
  for (const app of next.apps) {
    for (const r of app.releases) {
      const id = `${app.account}/${app.packageName}/${r.track}`;
      const p = before.get(id);
      if (!p || releaseKey(p) === releaseKey(r)) continue;
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
      return { name: a.name, developerId: a.play.developerId, clientEmail: sa.client_email, privateKeyPem: sa.private_key, tokenUri: sa.token_uri ?? 'https://oauth2.googleapis.com/token', apps: a.play.apps };
    });
}
