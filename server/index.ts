import { serveStatic } from 'hono/bun';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { StoreAccounts } from './accounts';
import { createApp } from './app';
import type { CodemagicActions, CodemagicTokenActions, GithubActions } from './app';
import { LarkAttachments } from './attachments';
import { AuthManager } from './auth';
import { maskToken, testCodemagicToken, validateToken, writeEnvValue } from './codemagicToken';
import { isUnsetGithubAccount, loadConfig, publicConfig } from './config';
import { editConfig } from './configEdit';
import { run } from './proc';
import { Scheduler } from './scheduler';
import { codemagicSource, createCodemagicActions } from './sources/codemagic';
import { listRepos } from './sources/github';
import { buildGithubSource, buildLarkSource, buildSources, buildStoreSources } from './sources/index';
import { listTables, listViews } from './sources/lark';
import { SseHub } from './sse';
import { Store } from './store';
import type { CodemagicSnapshot, SourceId } from '../shared/types';

const ROOT = resolve(import.meta.dir, '..');
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const loaded = loadConfig(ROOT);
mkdirSync(resolve(ROOT, 'data'), { recursive: true });
const store = new Store(resolve(ROOT, 'data', 'dashboard.sqlite'));
const pruned = store.pruneEvents(30 * 24 * 3600 * 1000, Date.now());
if (pruned) log(`pruned ${pruned} events older than 30 days`);

const hub = new SseHub();
const { sources, codemagic } = await buildSources(loaded, {
  log,
  getSnapshot: <S>(id: SourceId): S | null => store.getSnapshot<S>(id)?.data ?? null,
});
const disabled: Partial<Record<SourceId, string>> = { ...loaded.problems };
for (const s of sources) if (s.disabled) disabled[s.source.id] = s.disabled;

const scheduler = new Scheduler(sources, store, (msg) => void hub.broadcast(msg), { log });
const devEmit = process.env.DASHBOARD_DEV === '1';
if (devEmit) log('DASHBOARD_DEV=1: POST /api/dev/emit is enabled');
const port = loaded.config.server.port;
const pub = publicConfig(loaded.config);
// Reassigned when the Base changes in Settings, so attachment downloads use the new token without a restart.
let attachments = new LarkAttachments(loaded.config.lark, resolve(ROOT, 'data', 'attachments'));

// Settings page edits: rewrite the config, then swap the two store sources in place and poll them at once.
const accounts = new StoreAccounts({
  rootDir: ROOT,
  onChange: (fresh) => {
    for (const reg of buildStoreSources(fresh, log)) {
      const id = reg.source.id;
      if (reg.disabled) disabled[id] = reg.disabled;
      else delete disabled[id];
      scheduler.replace(reg);
      log(`source ${id}: ${reg.disabled ? `disabled (${reg.disabled})` : 'reconfigured from Settings, polling now'}`);
    }
    Object.assign(pub, publicConfig(fresh.config));
  },
});

// gh / lark-cli sessions: status for the Settings page and banner, sign-ins driven from the browser. A completed
// GitHub sign-in rebuilds that source, since it may have been disabled at startup for a missing or wrong account.
const auth = new AuthManager({
  githubAccount: loaded.config.github.account,
  log,
  onLogin: async (provider) => {
    if (provider === 'lark') { void scheduler.refresh('lark'); return; }
    const before = loaded.config.github.account;
    await auth.status(true); // a first sign-in adopts the account into the config (onAdoptGithubAccount below), which rebuilds the source itself
    if (loaded.config.github.account === before) await rebuildGithub('signed in');
  },
  // Fresh install: the example config carries no real account, so the login gh signed in as is saved and the source rebuilt around it.
  onAdoptGithubAccount: async (login) => {
    const fresh = editConfig(ROOT, (raw) => {
      const gh = (raw.github && typeof raw.github === 'object' ? raw.github : {}) as Record<string, unknown>;
      raw.github = { ...gh, account: login };
    });
    loaded.config = fresh.config;
    loaded.problems = fresh.problems;
    Object.assign(pub, publicConfig(fresh.config));
    await rebuildGithub(`signed in as ${login}; saved as github.account in the config`);
  },
});

// Codemagic token from the Settings page: tested, written to config/secrets/.env, then the source and its actions are swapped in place.
const envPath = resolve(loaded.configDir, 'secrets', '.env');
const codemagicRef: { current: CodemagicActions | undefined } = { current: codemagic };
const applyCodemagicToken = (token: string | null): void => {
  loaded.secrets.CODEMAGIC_API_TOKEN = token ?? undefined;
  const problem = !loaded.config.codemagic.enabled ? 'disabled in config' : !token ? 'CODEMAGIC_API_TOKEN missing from config/secrets/.env' : null;
  scheduler.replace({ source: codemagicSource, ctx: { run, fetch, log, now: Date.now, config: { token: token ?? '' } }, intervalSec: loaded.config.polling.codemagic, disabled: problem });
  if (problem) { disabled.codemagic = problem; codemagicRef.current = undefined; }
  else { delete disabled.codemagic; codemagicRef.current = createCodemagicActions(token!, () => store.getSnapshot<CodemagicSnapshot>('codemagic')?.data ?? null); }
  log(`codemagic: ${problem ? `disabled (${problem})` : 'token saved from Settings, polling now'}`);
};
const codemagicToken: CodemagicTokenActions = {
  status: async () => {
    const token = loaded.secrets.CODEMAGIC_API_TOKEN;
    return { configured: !!token, masked: token ? maskToken(token) : null, enabled: loaded.config.codemagic.enabled, apps: store.getSnapshot<CodemagicSnapshot>('codemagic')?.data?.apps.length ?? null, error: disabled.codemagic ?? null };
  },
  test: (token) => testCodemagicToken(validateToken(token)),
  save: async (token) => {
    const clean = validateToken(token);
    await testCodemagicToken(clean);
    writeEnvValue(envPath, 'CODEMAGIC_API_TOKEN', clean);
    applyCodemagicToken(clean);
    return codemagicToken.status();
  },
  remove: async () => {
    writeEnvValue(envPath, 'CODEMAGIC_API_TOKEN', null);
    applyCodemagicToken(null);
    return codemagicToken.status();
  },
};
// Repositories for the Pull Requests panel's All tab: saved into the config, then the GitHub source is rebuilt and polled.
const rebuildGithub = async (why: string): Promise<void> => {
  const reg = await buildGithubSource(loaded, log);
  if (reg.disabled) disabled.github = reg.disabled;
  else delete disabled.github;
  scheduler.replace(reg);
  log(`github: ${why}${reg.disabled ? `; still disabled (${reg.disabled})` : ', polling now'}`);
};
const github: GithubActions = {
  listRepos: () => listRepos(run),
  setRepos: async (repos) => {
    const fresh = editConfig(ROOT, (raw) => {
      const gh = (raw.github && typeof raw.github === 'object' ? raw.github : {}) as Record<string, unknown>;
      raw.github = { ...gh, repos };
    });
    loaded.config = fresh.config;
    loaded.problems = fresh.problems;
    Object.assign(pub, publicConfig(fresh.config));
    await rebuildGithub(`repositories updated from Settings (${repos.length})`);
    return fresh.config.github.repos;
  },
};

const noCodemagic = (): never => { throw new Error(disabled.codemagic ?? 'Codemagic not configured'); };
const codemagicActions: CodemagicActions = {
  trigger: (input) => (codemagicRef.current ?? noCodemagic()).trigger(input),
  artifact: (buildId, index) => (codemagicRef.current ?? noCodemagic()).artifact(buildId, index),
};

const app = createApp({
  store, scheduler, hub, publicConfig: pub, disabled, codemagic: codemagicActions, accounts, devEmit, auth, codemagicToken, github,
  lark: {
    attachment: (table, recordId, token, name, range) => attachments.response(table, recordId, token, name, range),
    listTables: () => listTables(run, loaded.config.lark),
    listViews: (tableId) => listViews(run, loaded.config.lark, tableId),
    // Base link and table/view pairs picked in Settings: written to the config, then the Lark source is rebuilt around them and polled at once.
    saveBase: async (input) => {
      const fresh = editConfig(ROOT, (raw) => {
        const lark = (raw.lark && typeof raw.lark === 'object' ? raw.lark : {}) as Record<string, unknown>;
        const tables = { ...(lark.tables && typeof lark.tables === 'object' ? lark.tables : {}) } as Record<string, unknown>;
        for (const [key, value] of Object.entries(input.tables ?? {})) {
          const before = (tables[key] && typeof tables[key] === 'object' ? tables[key] : {}) as Record<string, unknown>;
          tables[key] = { ...before, tableId: value.tableId, viewId: value.viewId, viewName: value.viewName || undefined };
        }
        raw.lark = {
          ...lark,
          ...(input.domain ? { domain: input.domain } : {}),
          ...(input.baseToken ? { baseToken: input.baseToken } : {}),
          tables,
        };
      });
      loaded.config = fresh.config;
      loaded.problems = fresh.problems;
      Object.assign(pub, publicConfig(fresh.config));
      attachments = new LarkAttachments(fresh.config.lark, resolve(ROOT, 'data', 'attachments'));
      const reg = buildLarkSource(loaded, log);
      if (reg.disabled) disabled.lark = reg.disabled;
      else delete disabled.lark;
      scheduler.replace(reg);
      const what = [input.baseToken ? `base ${input.domain}` : null, input.tables ? `${Object.keys(input.tables).length} table(s)` : null].filter(Boolean).join(' and ');
      log(`lark: ${what} set from Settings${reg.disabled ? `; still disabled (${reg.disabled})` : ', polling now'}`);
      return pub.larkBase;
    },
  },
  allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
});

// Static UI: serveStatic paths are relative to the process cwd, so run from the repo root.
if (existsSync(resolve(ROOT, 'web', 'dist', 'index.html'))) {
  app.use('/*', serveStatic({ root: './web/dist' }));
  app.get('*', serveStatic({ path: './web/dist/index.html' }));
} else {
  app.get('/', (c) => c.text('UI not built yet. Run `bun run build`, or `bun run dev` and open the Vite URL it prints.'));
}

scheduler.start();
// A fresh config has no GitHub account yet: if gh is already signed in on this PC, adopt that login now rather than at the first Settings visit.
if (isUnsetGithubAccount(loaded.config.github.account)) void auth.status(true);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 0, // SSE connections stay open; the route sends its own pings
  fetch: app.fetch,
});
log(`dashboard listening on http://127.0.0.1:${server.port}`);
for (const s of sources) log(`source ${s.source.id}: ${s.disabled ? `disabled (${s.disabled})` : `every ${s.intervalSec} s`}`);
for (const [id, reason] of Object.entries(loaded.problems)) if (!sources.some((s) => s.source.id === id)) log(`source ${id}: disabled (${reason})`);
