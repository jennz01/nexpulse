import type { CodemagicSnapshot, LarkSnapshot, SourceId } from '../../shared/types';
import type { CodemagicActions } from '../app';
import type { LoadedConfig } from '../config';
import { run } from '../proc';
import { appstoreSource, loadAppStoreAccounts } from './appstore';
import type { AppStoreAccount } from './appstore';
import { codemagicSource, createCodemagicActions } from './codemagic';
import { checkGithubAccount, githubSource } from './github';
import { diffLark, larkSource } from './lark';
import { loadPlayAccounts, playstoreSource } from './playstore';
import type { PlayAccount } from './playstore';
import { describeError } from './types';
import type { RegisteredSource } from './types';

export interface BuiltSources {
  sources: RegisteredSource[];
  codemagic?: CodemagicActions;
}

export interface BuildDeps {
  log: (line: string) => void;
  /** Latest stored snapshot for a source, or null before its first fetch. Used by actions that need current data (artifact lookup). */
  getSnapshot: <S>(id: SourceId) => S | null;
}

/**
 * The two store sources, built from the current config. Used at startup and again whenever the Settings page
 * changes an account. A key file that fails to load disables just that source with the reason instead of crashing.
 */
export function buildStoreSources(loaded: LoadedConfig, log: (line: string) => void): RegisteredSource[] {
  const base = { run, fetch, log, now: Date.now };
  const accounts = loaded.config.stores.accounts;

  let appstoreDisabled = loaded.problems.appstore ?? null;
  let ascAccounts: AppStoreAccount[] = [];
  if (!appstoreDisabled) {
    try { ascAccounts = loadAppStoreAccounts(accounts, loaded.configDir); } catch (err) { appstoreDisabled = describeError(err); }
  }

  let playDisabled = loaded.problems.playstore ?? null;
  let playAccounts: PlayAccount[] = [];
  if (!playDisabled) {
    try { playAccounts = loadPlayAccounts(accounts, loaded.configDir); } catch (err) { playDisabled = describeError(err); }
  }

  return [
    { source: appstoreSource, ctx: { ...base, config: { accounts: ascAccounts } }, intervalSec: loaded.config.polling.stores, disabled: appstoreDisabled },
    { source: playstoreSource, ctx: { ...base, config: { accounts: playAccounts } }, intervalSec: loaded.config.polling.stores, disabled: playDisabled },
  ];
}

/**
 * The GitHub source, disabled when gh's active account is not the configured one. Built at startup and again after a
 * sign-in from the Settings page, so a source disabled at startup comes back without a restart.
 */
export async function buildGithubSource(loaded: LoadedConfig, log: (line: string) => void): Promise<RegisteredSource> {
  const base = { run, fetch, log, now: Date.now };
  const gh = await checkGithubAccount(run, loaded.config.github.account);
  if (gh.warning) log(`github: ${gh.warning}; will retry on the first poll`);
  return { source: githubSource, ctx: { ...base, config: loaded.config.github }, intervalSec: loaded.config.polling.github, disabled: gh.disabled };
}

/** Instantiate every source from the loaded config. Sources with a config problem are registered as disabled so the UI can show why. */
export async function buildSources(loaded: LoadedConfig, deps: BuildDeps): Promise<BuiltSources> {
  const { log } = deps;
  const base = { run, fetch, log, now: Date.now };
  const sources: RegisteredSource[] = [];

  sources.push(await buildGithubSource(loaded, log));

  const token = loaded.secrets.CODEMAGIC_API_TOKEN ?? '';
  const codemagicDisabled = loaded.problems.codemagic ?? null;
  sources.push({ source: codemagicSource, ctx: { ...base, config: { token } }, intervalSec: loaded.config.polling.codemagic, disabled: codemagicDisabled });
  const codemagic = codemagicDisabled ? undefined : createCodemagicActions(token, () => deps.getSnapshot<CodemagicSnapshot>('codemagic'));

  sources.push({
    source: { ...larkSource, diff: (p: LarkSnapshot | null, n: LarkSnapshot) => diffLark(p, n, loaded.config.lark.tables.issues.showStatuses[0] ?? 'OPEN') },
    ctx: { ...base, config: loaded.config.lark },
    intervalSec: loaded.config.polling.lark,
    disabled: loaded.problems.lark ?? null,
  });

  sources.push(...buildStoreSources(loaded, log));

  return { sources, codemagic };
}
