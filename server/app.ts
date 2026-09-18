import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { LarkTableKey } from './config';
import { SOURCE_IDS } from '../shared/types';
import type { AuthProvider, AuthStatus, CodemagicTokenStatus, LoginState, NewEvent, PublicConfig, SourceId, StateResponse, StoreAccountInput } from '../shared/types';
import { AccountInputError } from './accounts';
import type { StoreAccounts } from './accounts';
import type { Scheduler } from './scheduler';
import { describeError } from './sources/types';
import type { SseHub } from './sse';
import type { Store } from './store';

export interface CodemagicActions {
  trigger(input: { appId: string; workflowId: string; branch: string }): Promise<{ buildId: string }>;
  /** Streams the artifact body with the auth token added server-side. */
  artifact(buildId: string, index: number): Promise<Response>;
}

export interface AuthActions {
  status(fresh: boolean): Promise<AuthStatus>;
  login(provider: AuthProvider): LoginState;
  startLogin(provider: AuthProvider): Promise<LoginState>;
  cancelLogin(provider: AuthProvider): LoginState;
  switchGithub(): Promise<AuthStatus>;
}
const isProvider = (p: string): p is AuthProvider => p === 'github' || p === 'lark';

export interface CodemagicTokenActions {
  status(): Promise<CodemagicTokenStatus>;
  /** Resolves to the number of apps the token can see; throws with the reason otherwise. */
  test(token: string): Promise<number>;
  save(token: string): Promise<CodemagicTokenStatus>;
  remove(): Promise<CodemagicTokenStatus>;
}

export interface LarkActions {
  /** Streams a Base attachment, downloaded through lark-cli and cached on disk; `range` is the request's Range header. */
  attachment(table: LarkTableKey, recordId: string, token: string, name: string, range?: string | null): Promise<Response>;
}

const isLarkTable = (t: string): t is LarkTableKey => t === 'tasks' || t === 'issues' || t === 'feedback';

export interface AppDeps {
  store: Store;
  scheduler: Scheduler;
  hub: SseHub;
  publicConfig: PublicConfig;
  disabled: Partial<Record<SourceId, string>>;
  codemagic?: CodemagicActions;
  lark?: LarkActions;
  auth?: AuthActions;
  codemagicToken?: CodemagicTokenActions;
  /** Store account management for the Settings page; absent in tests and `bun run check`. */
  accounts?: StoreAccounts;
  /** SSE keep-alive interval in ms; tests shorten it so no long timer outlives them. */
  pingIntervalMs?: number;
  devEmit?: boolean;
  /** Host header values the API accepts (lowercase comparison); empty/absent disables the check. */
  allowedHosts?: string[];
}

const isSourceId = (s: string): s is SourceId => (SOURCE_IDS as readonly string[]).includes(s);

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    const host = c.req.header('host');
    if (host && deps.allowedHosts && deps.allowedHosts.length > 0 && !deps.allowedHosts.map((h) => h.toLowerCase()).includes(host.toLowerCase())) {
      return c.json({ error: 'host not allowed' }, 403);
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-requested-with') !== 'dashboard') {
      return c.json({ error: 'missing x-requested-with header' }, 403);
    }
    await next();
  });

  app.get('/api/health', (c) => {
    const states = deps.store.allStates(deps.disabled);
    const status = deps.scheduler.status();
    const sources = {} as Record<SourceId, unknown>;
    for (const id of SOURCE_IDS) sources[id] = { ...status[id], fetchedAt: states[id].fetchedAt, error: states[id].error };
    return c.json({ ok: true, clients: deps.hub.size, sources });
  });

  app.get('/api/state', (c) => {
    const body: StateResponse = {
      states: deps.store.allStates(deps.disabled),
      events: deps.store.unseenEvents(),
      config: deps.publicConfig,
    };
    return c.json(body);
  });

  app.post('/api/events/seen', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; source?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n)) : undefined;
    const source = typeof body.source === 'string' && isSourceId(body.source) ? body.source : undefined;
    if ((!ids || ids.length === 0) && !source) return c.json({ error: 'ids[] or source required' }, 400);
    return c.json({ updated: deps.store.markSeen({ ids, source }) });
  });

  app.post('/api/sources/:id/refresh', async (c) => {
    const id = c.req.param('id');
    if (!isSourceId(id)) return c.json({ error: 'unknown source' }, 404);
    const reason = deps.disabled[id];
    if (reason) return c.json({ error: reason }, 409);
    await deps.scheduler.refresh(id);
    return c.json({ ok: true, state: deps.store.allStates(deps.disabled)[id] });
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      deps.hub.add(stream);
      stream.onAbort(() => deps.hub.remove(stream));
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ clients: deps.hub.size }) });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(deps.pingIntervalMs ?? 20_000);
        await stream.writeSSE({ event: 'ping', data: '' });
      }
      deps.hub.remove(stream);
    }),
  );

  app.post('/api/codemagic/builds', async (c) => {
    if (!deps.codemagic) return c.json({ error: deps.disabled.codemagic ?? 'Codemagic not configured' }, 409);
    const body = (await c.req.json().catch(() => null)) as { appId?: unknown; workflowId?: unknown; branch?: unknown } | null;
    if (!body || typeof body.appId !== 'string' || typeof body.workflowId !== 'string' || typeof body.branch !== 'string' || !body.branch.trim()) {
      return c.json({ error: 'appId, workflowId and branch are required' }, 400);
    }
    try {
      const result = await deps.codemagic.trigger({ appId: body.appId, workflowId: body.workflowId, branch: body.branch.trim() });
      void deps.scheduler.refresh('codemagic');
      return c.json(result);
    } catch (err) {
      return c.json({ error: describeError(err) }, 502);
    }
  });

  app.get('/api/codemagic/artifacts/:buildId/:index', async (c) => {
    if (!deps.codemagic) return c.json({ error: deps.disabled.codemagic ?? 'Codemagic not configured' }, 409);
    const index = Number(c.req.param('index'));
    if (!Number.isInteger(index) || index < 0) return c.json({ error: 'bad artifact index' }, 400);
    try {
      return await deps.codemagic.artifact(c.req.param('buildId'), index);
    } catch (err) {
      return c.json({ error: describeError(err) }, 502);
    }
  });

  // ---- Store accounts (Settings page). Input errors are 400 with the message; secrets never come back. ----
  const accountError = (c: Context, err: unknown) => c.json({ error: describeError(err) }, err instanceof AccountInputError ? 400 : 500);

  // The file name ends the path so the browser's PDF viewer and downloads show the real name; it never picks the file.
  const attachment = async (c: Context) => {
    if (!deps.lark) return c.json({ error: deps.disabled.lark ?? 'Lark not configured' }, 409);
    const table = c.req.param('table') ?? '';
    const recordId = c.req.param('recordId') ?? '';
    const token = c.req.param('token') ?? '';
    if (!isLarkTable(table) || !/^rec[A-Za-z0-9]{4,40}$/.test(recordId) || !/^[A-Za-z0-9_-]{8,80}$/.test(token)) return c.json({ error: 'bad attachment reference' }, 400);
    const name = c.req.param('name') ?? c.req.query('name') ?? 'file';
    try {
      return await deps.lark.attachment(table, recordId, token, name, c.req.header('range') ?? null);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  };
  app.get('/api/lark/attachments/:table/:recordId/:token/:name', attachment);
  app.get('/api/lark/attachments/:table/:recordId/:token', attachment);

  // ---- gh / lark-cli sessions: status and server-driven device-code sign-ins ----
  app.get('/api/auth/status', async (c) => {
    if (!deps.auth) return c.json({ error: 'not available' }, 409);
    return c.json(await deps.auth.status(c.req.query('fresh') === '1'));
  });
  const withProvider = (c: Context): AuthProvider | null => { const p = c.req.param('provider') ?? ''; return isProvider(p) ? p : null; };
  app.get('/api/auth/:provider/login', (c) => {
    const p = withProvider(c);
    if (!deps.auth || !p) return c.json({ error: 'unknown provider' }, 404);
    return c.json(deps.auth.login(p));
  });
  app.post('/api/auth/:provider/login', async (c) => {
    const p = withProvider(c);
    if (!deps.auth || !p) return c.json({ error: 'unknown provider' }, 404);
    return c.json(await deps.auth.startLogin(p));
  });
  app.delete('/api/auth/:provider/login', (c) => {
    const p = withProvider(c);
    if (!deps.auth || !p) return c.json({ error: 'unknown provider' }, 404);
    return c.json(deps.auth.cancelLogin(p));
  });
  app.post('/api/auth/github/switch', async (c) => {
    if (!deps.auth) return c.json({ error: 'not available' }, 409);
    try { return c.json(await deps.auth.switchGithub()); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
  });

  // ---- Codemagic API token, kept in config/secrets/.env ----
  app.get('/api/codemagic/token', async (c) => (deps.codemagicToken ? c.json(await deps.codemagicToken.status()) : c.json({ error: 'not available' }, 409)));
  app.post('/api/codemagic/token/test', async (c) => {
    if (!deps.codemagicToken) return c.json({ error: 'not available' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    try { return c.json({ apps: await deps.codemagicToken.test(String(body.token ?? '')) }); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.put('/api/codemagic/token', async (c) => {
    if (!deps.codemagicToken) return c.json({ error: 'not available' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    try { return c.json(await deps.codemagicToken.save(String(body.token ?? ''))); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });
  app.delete('/api/codemagic/token', async (c) => {
    if (!deps.codemagicToken) return c.json({ error: 'not available' }, 409);
    try { return c.json(await deps.codemagicToken.remove()); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
  });

  app.get('/api/stores/accounts', (c) => {
    if (!deps.accounts) return c.json({ error: 'account management is not available in this process' }, 501);
    return c.json(deps.accounts.list());
  });

  app.post('/api/stores/accounts', async (c) => {
    if (!deps.accounts) return c.json({ error: 'account management is not available in this process' }, 501);
    const body = (await c.req.json().catch(() => null)) as StoreAccountInput | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON body required' }, 400);
    try {
      return c.json(deps.accounts.upsert(body));
    } catch (err) {
      return accountError(c, err);
    }
  });

  app.delete('/api/stores/accounts/:name', (c) => {
    if (!deps.accounts) return c.json({ error: 'account management is not available in this process' }, 501);
    try {
      return c.json(deps.accounts.remove(decodeURIComponent(c.req.param('name'))));
    } catch (err) {
      return accountError(c, err);
    }
  });

  app.post('/api/stores/test', async (c) => {
    if (!deps.accounts) return c.json({ error: 'account management is not available in this process' }, 501);
    const body = (await c.req.json().catch(() => null)) as StoreAccountInput | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON body required' }, 400);
    try {
      return c.json(await deps.accounts.test(body));
    } catch (err) {
      return accountError(c, err);
    }
  });

  if (deps.devEmit) {
    app.post('/api/dev/emit', async (c) => {
      const body = (await c.req.json().catch(() => null)) as Partial<NewEvent> | null;
      if (!body || typeof body.source !== 'string' || !isSourceId(body.source) || typeof body.kind !== 'string') {
        return c.json({ error: 'source and kind are required' }, 400);
      }
      const source = body.source;
      const [event] = deps.store.addEvents(
        [{
          source,
          kind: body.kind,
          priority: body.priority === 'normal' ? 'normal' : 'high',
          itemId: String(body.itemId ?? `dev-${Date.now()}`),
          title: String(body.title ?? `Synthetic ${body.kind}`),
          url: typeof body.url === 'string' ? body.url : null,
        }],
        Date.now(),
      );
      await deps.hub.broadcast({ source, state: deps.store.allStates(deps.disabled)[source], events: event ? [event] : [] });
      return c.json(event);
    });
  }

  return app;
}
