import { serveStatic } from 'hono/bun';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { StoreAccounts } from './accounts';
import { createApp } from './app';
import { LarkAttachments } from './attachments';
import { loadConfig, publicConfig } from './config';
import { Scheduler } from './scheduler';
import { buildSources, buildStoreSources } from './sources/index';
import { SseHub } from './sse';
import { Store } from './store';
import type { SourceId } from '../shared/types';

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

const app = createApp({
  store, scheduler, hub, publicConfig: pub, disabled, codemagic, accounts, devEmit,
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
