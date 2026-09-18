import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readText } from './config';
import { dirname } from 'node:path';
import { CODEMAGIC_API } from './sources/codemagic';

/** Sets (or, with null, removes) `KEY=value` in an env file, keeping every other line, including comments, as it is. */
export function writeEnvValue(envPath: string, key: string, value: string | null): void {
  const existing = existsSync(envPath) ? readText(envPath) : '';
  const own = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  const kept = existing.split(/\r?\n/).filter((line) => !own.test(line));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  if (value !== null) kept.push(`${key}=${value}`);
  mkdirSync(dirname(envPath), { recursive: true });
  const tmp = `${envPath}.tmp`;
  writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, envPath);
}

/** Calls Codemagic's apps endpoint with the token; resolves to the number of apps it can see, or throws with the reason. */
export async function testCodemagicToken(token: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(`${CODEMAGIC_API}/apps`, { headers: { 'x-auth-token': token }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw new Error('Codemagic rejected the token');
  if (!res.ok) throw new Error(`Codemagic answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { applications?: unknown[] };
  return Array.isArray(body.applications) ? body.applications.length : 0;
}

/** A token is opaque text without whitespace; anything else is a paste error. */
export function validateToken(input: unknown): string {
  const token = typeof input === 'string' ? input.trim() : '';
  if (!token) throw new Error('Paste the Codemagic API token first.');
  if (token.length > 300 || /\s/.test(token)) throw new Error('That does not look like a Codemagic token.');
  return token;
}

export const maskToken = (token: string): string => (token.length <= 8 ? '••••' : `${token.slice(0, 3)}…${token.slice(-4)}`);
