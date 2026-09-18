import { serveStatic } from 'hono/bun';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { StoreAccounts } from './accounts';
import { createApp } from './app';
import type { CodemagicActions, CodemagicTokenActions } from './app';
import { LarkAttachments } from './attachments';
import { AuthManager } from './auth';
import { maskToken, testCodemagicToken, validateToken, writeEnvValue } from './codemagicToken';
import { loadConfig, publicConfig } from './config';
import { run } from './proc';
import { Scheduler } from './scheduler';
import { codemagicSource, createCodemagicActions } from './sources/codemagic';
import { buildGithubSource, buildSources, buildStoreSources } from './sources/index';
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
const attachments = new LarkAttachments(loaded.config.lark, resolve(ROOT, 'data', 'attachments'));

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
    if (provider === 'github') {
      const reg = await buildGithubSource(loaded, log);
      if (reg.disabled) disabled.github = reg.disabled;
      else delete disabled.github;
      scheduler.replace(reg);
      log(`github: ${reg.disabled ? `still disabled (${reg.disabled})` : 'signed in, polling now'}`);
    } else {
      void scheduler.refresh('lark');
    }
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
const noCodemagic = (): never => { throw new Error(disabled.codemagic ?? 'Codemagic not configured'); };
const codemagicActions: CodemagicActions = {
  trigger: (input) => (codemagicRef.current ?? noCodemagic()).trigger(input),
  artifact: (buildId, index) => (codemagicRef.current ?? noCodemagic()).artifact(buildId, index),
};

const app = createApp({
  store, scheduler, hub, publicConfig: pub, disabled, codemagic: codemagicActions, accounts, devEmit, auth, codemagicToken,
  lark: { attachment: (table, recordId, token, name, range) => attachments.response(table, recordId, token, name, range) },
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
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 0, // SSE connections stay open; the route sends its own pings
  fetch: app.fetch,
});
log(`dashboard listening on http://127.0.0.1:${server.port}`);
for (const s of sources) log(`source ${s.source.id}: ${s.disabled ? `disabled (${s.disabled})` : `every ${s.intervalSec} s`}`);
for (const [id, reason] of Object.entries(loaded.problems)) if (!sources.some((s) => s.source.id === id)) log(`source ${id}: disabled (${reason})`);
