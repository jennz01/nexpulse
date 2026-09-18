import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StoreAccountInput, StoreAccountView, StorePlayAppInput, StoreTestResult } from '../shared/types';
import { ConfigSchema, loadConfig, readText } from './config';
import type { LoadedConfig, StoreAccountConfig } from './config';
import { AscTokenCache, ascJson, parseAscApps } from './sources/appstore';
import type { AppStoreAccount } from './sources/appstore';
import { PlayTokenCache, readReleases } from './sources/playstore';
import type { PlayAccount } from './sources/playstore';
import { describeError } from './sources/types';

/** The caller got the input wrong; the route answers 400 with this message. */
export class AccountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountInputError';
  }
}

const KEY_ID = /^[A-Za-z0-9]{6,20}$/;
const ISSUER_ID = /^[0-9a-fA-F-]{20,40}$/;
const DEVELOPER_ID = /^\d{5,30}$/;
const PACKAGE_NAME = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/;
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** File-name-safe form of an account name: "SiteGiant (MY)" -> "sitegiant-my". */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
}

export function validateP8(text: string): string {
  const pem = text.trim();
  if (!/^-----BEGIN (EC )?PRIVATE KEY-----[\s\S]+-----END (EC )?PRIVATE KEY-----$/.test(pem)) {
    throw new AccountInputError('The .p8 file is not a PEM private key (it should start with "-----BEGIN PRIVATE KEY-----").');
  }
  return `${pem}\n`;
}

export interface ServiceAccountJson { client_email: string; private_key: string; token_uri: string }

export function validateServiceAccount(text: string): ServiceAccountJson {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AccountInputError('The service account file is not valid JSON.');
  }
  if (json.type !== 'service_account' || typeof json.client_email !== 'string' || typeof json.private_key !== 'string') {
    throw new AccountInputError('The JSON is not a Google service account key (it needs type "service_account", client_email and private_key).');
  }
  return { client_email: json.client_email, private_key: json.private_key, token_uri: typeof json.token_uri === 'string' ? json.token_uri : GOOGLE_TOKEN_URI };
}

function cleanApps(apps: unknown): StorePlayAppInput[] {
  if (!Array.isArray(apps) || apps.length === 0) throw new AccountInputError('Add at least one Play app (package name and display name).');
  return apps.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const packageName = String(o.packageName ?? '').trim();
    const name = String(o.name ?? '').trim();
    const consoleUrl = typeof o.consoleUrl === 'string' && o.consoleUrl.trim() ? o.consoleUrl.trim() : undefined;
    if (!PACKAGE_NAME.test(packageName)) throw new AccountInputError(`"${packageName || '(empty)'}" is not a valid package name.`);
    if (!name) throw new AccountInputError(`Display name is missing for ${packageName}.`);
    if (consoleUrl && !/^https:\/\/play\.google\.com\//.test(consoleUrl)) throw new AccountInputError(`Console URL for ${packageName} must start with https://play.google.com/.`);
    return consoleUrl ? { packageName, name, consoleUrl } : { packageName, name };
  });
}

export interface AccountsDeps {
  rootDir: string;
  /** Runs after the config file changed; the server swaps the store sources. */
  onChange: (loaded: LoadedConfig) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Add / edit / remove developer accounts from the Settings page. Key material is written only under
 * config/secrets with names derived here, the config file is rewritten atomically, and nothing secret is ever
 * returned to the browser.
 */
export class StoreAccounts {
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly secretsDir: string;

  constructor(private readonly deps: AccountsDeps) {
    this.configDir = resolve(deps.rootDir, 'config');
    this.configPath = resolve(this.configDir, 'dashboard.config.json');
    this.secretsDir = resolve(this.configDir, 'secrets');
  }

  list(): StoreAccountView[] {
    return this.current().map((a) => this.view(a));
  }

  /** Validate, write key files, rewrite the accounts section and reload. Returns the new list. */
  upsert(input: StoreAccountInput): StoreAccountView[] {
    const accounts = this.current();
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 60) throw new AccountInputError('Account name is required (up to 60 characters).');
    const originalName = typeof input.originalName === 'string' ? input.originalName : null;
    const existing = originalName ? accounts.find((a) => a.name === originalName) ?? null : null;
    if (originalName && !existing) throw new AccountInputError(`Account "${originalName}" no longer exists.`);
    if (accounts.some((a) => a !== existing && a.name.toLowerCase() === name.toLowerCase())) throw new AccountInputError(`An account named "${name}" already exists.`);
    if (!input.appstore && !input.play) throw new AccountInputError('Switch on App Store Connect, Google Play or both.');

    const writes: { path: string; text: string }[] = [];
    const entry: StoreAccountConfig = { name };

    if (input.appstore) {
      const issuerId = String(input.appstore.issuerId ?? '').trim();
      const keyId = String(input.appstore.keyId ?? '').trim();
      if (!ISSUER_ID.test(issuerId)) throw new AccountInputError('Issuer ID looks wrong; copy it from App Store Connect → Integrations → Team Keys.');
      if (!KEY_ID.test(keyId)) throw new AccountInputError('Key ID must be the short alphanumeric id shown next to the key (e.g. ABC123DEFG).');
      const keyFile = `secrets/AuthKey_${keyId}.p8`;
      if (typeof input.appstore.keyPem === 'string' && input.appstore.keyPem.trim()) {
        writes.push({ path: resolve(this.configDir, keyFile), text: validateP8(input.appstore.keyPem) });
      } else if (!existsSync(resolve(this.configDir, keyFile))) {
        throw new AccountInputError(`Choose the .p8 file for key ${keyId}.`);
      }
      entry.appstore = { issuerId, keyId, keyFile };
    }

    if (input.play) {
      const developerId = String(input.play.developerId ?? '').trim();
      if (!DEVELOPER_ID.test(developerId)) throw new AccountInputError('Developer ID must be the long number from the Play Console URL.');
      const apps = cleanApps(input.play.apps);
      const keep = existing?.play?.serviceAccountFile;
      let serviceAccountFile: string;
      if (typeof input.play.serviceAccountJson === 'string' && input.play.serviceAccountJson.trim()) {
        validateServiceAccount(input.play.serviceAccountJson);
        serviceAccountFile = `secrets/play-${slug(name)}.json`;
        writes.push({ path: resolve(this.configDir, serviceAccountFile), text: `${input.play.serviceAccountJson.trim()}\n` });
      } else if (keep && existsSync(resolve(this.configDir, keep))) {
        serviceAccountFile = keep;
      } else {
        throw new AccountInputError('Choose the service account JSON file for Google Play.');
      }
      entry.play = { developerId, serviceAccountFile, apps };
    }

    const next = existing ? accounts.map((a) => (a === existing ? entry : a)) : [...accounts, entry];
    const raw = this.withAccounts(next); // validates before anything touches disk
    for (const w of writes) this.writeSecret(w.path, w.text);
    this.commit(raw);
    if (existing) this.deleteOrphans(existing, next);
    return this.list();
  }

  remove(name: string): StoreAccountView[] {
    const accounts = this.current();
    const target = accounts.find((a) => a.name === name);
    if (!target) throw new AccountInputError(`Account "${name}" not found.`);
    const next = accounts.filter((a) => a !== target);
    this.commit(this.withAccounts(next));
    this.deleteOrphans(target, next);
    return this.list();
  }

  /** Try the credentials without saving: App Store app list, and each Play package's tracks. */
  async test(input: StoreAccountInput): Promise<StoreTestResult> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const existing = input.originalName ? this.current().find((a) => a.name === input.originalName) ?? null : null;
    const name = String(input.name ?? '').trim() || 'new account';
    const result: StoreTestResult = { appstore: null, play: null };

    if (input.appstore) {
      try {
        const pem = input.appstore.keyPem?.trim()
          ? validateP8(input.appstore.keyPem)
          : existing?.appstore ? readText(resolve(this.configDir, existing.appstore.keyFile)) : null;
        if (!pem) throw new AccountInputError('Choose the .p8 file first.');
        const acc: AppStoreAccount = { name, issuerId: String(input.appstore.issuerId ?? '').trim(), keyId: String(input.appstore.keyId ?? '').trim(), privateKeyPem: pem };
        const token = await new AscTokenCache().token(acc);
        const apps = parseAscApps(await ascJson(fetchImpl, token, '/apps?limit=200', name));
        result.appstore = { ok: true, apps: apps.map((a) => a.name), error: null };
      } catch (err) {
        result.appstore = { ok: false, apps: [], error: describeError(err) };
      }
    }

    if (input.play) {
      const perApp: NonNullable<StoreTestResult['play']>['apps'] = [];
      try {
        const text = input.play.serviceAccountJson?.trim()
          ? input.play.serviceAccountJson
          : existing?.play ? readText(resolve(this.configDir, existing.play.serviceAccountFile)) : null;
        if (!text) throw new AccountInputError('Choose the service account JSON first.');
        const sa = validateServiceAccount(text);
        const acc: PlayAccount = { name, developerId: String(input.play.developerId ?? ''), clientEmail: sa.client_email, privateKeyPem: sa.private_key, tokenUri: sa.token_uri, apps: [] };
        const token = await new PlayTokenCache().token(acc, fetchImpl);
        for (const app of cleanApps(input.play.apps)) {
          try {
            perApp.push({ packageName: app.packageName, ok: true, releases: (await readReleases(fetchImpl, token, app.packageName, name)).length, error: null });
          } catch (err) {
            perApp.push({ packageName: app.packageName, ok: false, releases: 0, error: describeError(err) });
          }
        }
        result.play = { ok: perApp.every((a) => a.ok), apps: perApp, error: null };
      } catch (err) {
        result.play = { ok: false, apps: perApp, error: describeError(err) };
      }
    }
    return result;
  }

  // ---- internals ----

  private readRaw(): Record<string, unknown> {
    return JSON.parse(readText(this.configPath)) as Record<string, unknown>;
  }

  private current(): StoreAccountConfig[] {
    return ConfigSchema.parse(this.readRaw()).stores.accounts;
  }

  private view(a: StoreAccountConfig): StoreAccountView {
    let clientEmail: string | null = null;
    let filePresent = false;
    if (a.play) {
      const p = resolve(this.configDir, a.play.serviceAccountFile);
      filePresent = existsSync(p);
      if (filePresent) {
        try { clientEmail = validateServiceAccount(readText(p)).client_email; } catch { clientEmail = null; }
      }
    }
    return {
      name: a.name,
      appstore: a.appstore ? { issuerId: a.appstore.issuerId, keyId: a.appstore.keyId, keyFile: a.appstore.keyFile, keyPresent: existsSync(resolve(this.configDir, a.appstore.keyFile)) } : null,
      play: a.play ? { developerId: a.play.developerId, serviceAccountFile: a.play.serviceAccountFile, filePresent, clientEmail, apps: a.play.apps } : null,
    };
  }

  /** The raw config with a new accounts list, checked against the schema. Everything else in the file is preserved. */
  private withAccounts(accounts: StoreAccountConfig[]): Record<string, unknown> {
    const raw = this.readRaw();
    const stores = (raw.stores && typeof raw.stores === 'object' ? raw.stores : {}) as Record<string, unknown>;
    raw.stores = { ...stores, accounts };
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) throw new AccountInputError(`Config would become invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return raw;
  }

  private commit(raw: Record<string, unknown>): void {
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.configPath);
    this.deps.onChange(loadConfig(this.deps.rootDir));
  }

  private writeSecret(path: string, text: string): void {
    if (!path.startsWith(this.secretsDir)) throw new AccountInputError('Refusing to write outside config/secrets.');
    mkdirSync(this.secretsDir, { recursive: true });
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  }

  /** Delete key files the old entry pointed at when no remaining account still uses them. */
  private deleteOrphans(old: StoreAccountConfig, remaining: StoreAccountConfig[]): void {
    const used = new Set(remaining.flatMap((a) => [a.appstore?.keyFile, a.play?.serviceAccountFile].filter((f): f is string => !!f)));
    for (const f of [old.appstore?.keyFile, old.play?.serviceAccountFile]) {
      if (!f || used.has(f)) continue;
      const p = resolve(this.configDir, f);
      if (!p.startsWith(this.secretsDir) || !existsSync(p)) continue;
      try { unlinkSync(p); } catch { /* leave it; the file is unreferenced either way */ }
    }
  }
}
