import { BUILD_TERMINAL_STATUSES, isBuildRunning } from '../../shared/status';
import type { Build, CodemagicApp, CodemagicSnapshot, NewEvent } from '../../shared/types';
import type { CodemagicActions } from '../app';
import { SourceError } from './types';
import type { Source, SourceContext } from './types';

export interface CodemagicConfig {
  token: string;
}

export const CODEMAGIC_API = 'https://api.codemagic.io';
export const CODEMAGIC_WEB = 'https://codemagic.io';
export const TERMINAL_STATUSES = BUILD_TERMINAL_STATUSES;
export const isRunning = isBuildRunning;

interface RawApp { _id: string; appName: string; workflows?: Record<string, { name?: string } | null> }
interface RawArtifact { name?: string; type?: string; url?: string; size?: number }
interface RawBuild {
  _id: string; appId: string; workflowId: string; branch?: string; status: string;
  startedAt?: string | null; finishedAt?: string | null; config?: { name?: string } | null;
  artefacts?: RawArtifact[]; startedBy?: { name?: string; email?: string } | string | null;
  commit?: { authorName?: string | null; commitMessage?: string | null } | null;
  version?: string | null; index?: number | null;
}

export type AppMeta = Omit<CodemagicApp, 'builds'>;

export function parseApps(raw: unknown): AppMeta[] {
  const list = (raw as { applications?: unknown }).applications;
  if (!Array.isArray(list)) throw new SourceError('Codemagic /apps: unexpected response shape');
  return (list as RawApp[]).map((a) => ({
    id: a._id,
    name: a.appName,
    workflows: Object.entries(a.workflows ?? {}).map(([id, w]) => ({ id, name: w?.name ?? id })),
  }));
}

export const buildUrl = (appId: string, buildId: string): string => `${CODEMAGIC_WEB}/app/${appId}/build/${buildId}`;

function durationSec(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}
function startedBy(v: RawBuild['startedBy']): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.name ?? v.email ?? null;
}

export function parseBuilds(raw: unknown, app: AppMeta): Build[] {
  const list = (raw as { builds?: unknown }).builds;
  if (!Array.isArray(list)) throw new SourceError(`Codemagic /builds for ${app.name}: unexpected response shape`);
  const names = new Map(app.workflows.map((w) => [w.id, w.name]));
  return (list as RawBuild[])
    .map<Build>((b) => ({
      id: b._id,
      appId: b.appId,
      workflowId: b.workflowId,
      workflowName: b.config?.name ?? names.get(b.workflowId) ?? b.workflowId,
      branch: b.branch ?? '',
      status: b.status,
      startedAt: b.startedAt ?? null,
      finishedAt: b.finishedAt ?? null,
      durationSec: durationSec(b.startedAt, b.finishedAt),
      startedBy: startedBy(b.startedBy),
      author: b.commit?.authorName ?? null,
      commitMessage: b.commit?.commitMessage?.split(/\r?\n/)[0]?.trim() || null,
      version: b.version ?? null,
      buildNumber: typeof b.index === 'number' ? b.index : null,
      url: buildUrl(b.appId, b._id),
      artifacts: (b.artefacts ?? [])
        .filter((a) => typeof a.url === 'string')
        .map((a) => ({ name: a.name ?? 'artifact', type: a.type ?? '', url: a.url!, size: typeof a.size === 'number' ? a.size : null })),
    }))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .slice(0, 10);
}

export async function codemagicJson(fetchImpl: typeof fetch, token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetchImpl(`${CODEMAGIC_API}${path}`, {
    ...init,
    headers: { 'x-auth-token': token, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
  if (res.status === 401 || res.status === 403) throw new SourceError(`Codemagic ${path}: HTTP ${res.status}`, 'Codemagic token rejected; check CODEMAGIC_API_TOKEN in config/secrets/.env');
  if (!res.ok) throw new SourceError(`Codemagic ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function fetchCodemagic(ctx: SourceContext<CodemagicConfig>): Promise<CodemagicSnapshot> {
  const apps = parseApps(await codemagicJson(ctx.fetch, ctx.config.token, '/apps'));
  const out: CodemagicApp[] = [];
  for (let i = 0; i < apps.length; i += 4) {
    const chunk = apps.slice(i, i + 4);
    const done = await Promise.all(
      chunk.map(async (app) => ({
        ...app,
        builds: parseBuilds(await codemagicJson(ctx.fetch, ctx.config.token, `/builds?appId=${encodeURIComponent(app.id)}&limit=10`), app),
      })),
    );
    out.push(...done);
  }
  return { apps: out };
}

export function diffCodemagic(prev: CodemagicSnapshot | null, next: CodemagicSnapshot): NewEvent[] {
  if (!prev) return [];
  const before = new Map<string, Build>();
  for (const a of prev.apps) for (const b of a.builds) before.set(b.id, b);
  const events: NewEvent[] = [];
  for (const app of next.apps) {
    for (const b of app.builds) {
      const p = before.get(b.id);
      const wasRunning = !p || isRunning(p.status);
      if (!wasRunning || isRunning(b.status)) continue;
      const label = `${app.name} · ${b.workflowName} · ${b.branch}`;
      if (b.status === 'failed' || b.status === 'timeout') {
        events.push({ source: 'codemagic', kind: 'build.failed', priority: 'high', itemId: b.id, title: `Build failed: ${label}`, url: b.url });
      } else if (b.status === 'finished' || b.status === 'warning') {
        events.push({ source: 'codemagic', kind: 'build.finished', priority: 'normal', itemId: b.id, title: `Build finished: ${label}`, url: b.url });
      }
    }
  }
  return events;
}

export const codemagicSource: Source<CodemagicSnapshot, CodemagicConfig> = {
  id: 'codemagic',
  defaultIntervalSec: 120,
  fetch: fetchCodemagic,
  diff: diffCodemagic,
  fastIntervalSec: (s) => (s.apps.some((a) => a.builds.some((b) => isRunning(b.status))) ? 30 : null),
};

export function createCodemagicActions(token: string, getSnapshot: () => CodemagicSnapshot | null, fetchImpl: typeof fetch = fetch): CodemagicActions {
  return {
    async trigger(input) {
      const json = (await codemagicJson(fetchImpl, token, '/builds', { method: 'POST', body: JSON.stringify(input) })) as { buildId?: string };
      if (!json.buildId) throw new SourceError('Codemagic did not return a buildId');
      return { buildId: json.buildId };
    },
    async artifact(buildId, index) {
      const build = getSnapshot()?.apps.flatMap((a) => a.builds).find((b) => b.id === buildId);
      const artifact = build?.artifacts[index];
      if (!build || !artifact) throw new SourceError(`artifact ${index} of build ${buildId} is not in the current snapshot`);
      let upstream = await fetchImpl(artifact.url, { headers: { 'x-auth-token': token }, redirect: 'manual' });
      const location = upstream.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(upstream.status) && location) {
        upstream = await fetchImpl(location, { redirect: 'follow' });
      }
      if (!upstream.ok || !upstream.body) throw new SourceError(`Codemagic artifact download: HTTP ${upstream.status}`);
      const headers = new Headers({
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${artifact.name.replace(/"/g, '')}"`,
      });
      const len = upstream.headers.get('content-length');
      if (len) headers.set('content-length', len);
      return new Response(upstream.body, { headers });
    },
  };
}
