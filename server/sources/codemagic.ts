import { hasFanOut } from '../../shared/releases';
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
  _id: string; appId: string; workflowId: string | null; branch?: string; status: string;
  startedAt?: string | null; finishedAt?: string | null; createdAt?: string | null; config?: { name?: string } | null;
  artefacts?: RawArtifact[]; startedBy?: { name?: string; email?: string } | string | null;
  commit?: { authorName?: string | null; commitMessage?: string | null; hash?: string | null } | null;
  /** Set when the workflow comes from codemagic.yaml rather than the UI, which is the case for every bulk release. */
  fileWorkflowId?: string | null;
  /** Per-build environment; a bulk release puts the white-label brand's identity here. */
  dynamicConfig?: { environment?: { variables?: Record<string, string> | null } | null } | null;
  version?: string | null; index?: number | null;
}

/** Codemagic caps one page of /builds at 30 whatever limit is asked for, so paging is the only way past it. */
export const PAGE_SIZE = 30;
/**
 * Safety valve: never spend more than this many pages on a single app, however long its run is. A shopping-app
 * release fans out to roughly 70 builds, which needs three pages for the run and a fourth for history, so this
 * leaves room for a release several times that size before the live run itself would start being cut off. It is a
 * ceiling rather than a target: an app that needs one page still costs one page.
 */
export const MAX_PAGES = 8;

/** Brand variables arrive URL-encoded ("Mochi%20Friends"); a stray % must not take the whole poll down. */
function safeDecode(value: string | undefined): string | null {
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return value; }
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

/**
 * Newest first. A queued build has no startedAt at all, so createdAt leads and startedAt is only a fallback for
 * anything stored before createdAt was recorded; sorting on startedAt alone buries a whole queue under old history.
 */
export const sortBuilds = (builds: Build[]): Build[] =>
  [...builds].sort((a, b) => (b.createdAt ?? b.startedAt ?? '').localeCompare(a.createdAt ?? a.startedAt ?? ''));

export function parseBuilds(raw: unknown, app: AppMeta): Build[] {
  const list = (raw as { builds?: unknown }).builds;
  if (!Array.isArray(list)) throw new SourceError(`Codemagic /builds for ${app.name}: unexpected response shape`);
  const names = new Map(app.workflows.map((w) => [w.id, w.name]));
  return sortBuilds((list as RawBuild[])
    .map<Build>((b) => {
      const vars = b.dynamicConfig?.environment?.variables ?? {};
      return {
        id: b._id,
        appId: b.appId,
        workflowId: b.workflowId ?? null,
        workflowName: b.config?.name ?? (b.workflowId ? names.get(b.workflowId) : null) ?? b.fileWorkflowId ?? b.workflowId ?? 'build',
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
        createdAt: b.createdAt ?? null,
        runId: b.commit?.hash ?? null,
        brand: safeDecode(vars.APP_NAME),
        storeId: vars.STORE_ID ?? null,
        bundleId: vars.APP_ID ?? null,
        iconUrl: vars.APP_ICON_URL ?? null,
        url: buildUrl(b.appId, b._id),
        artifacts: (b.artefacts ?? [])
          .filter((a) => typeof a.url === 'string')
          .map((a) => ({ name: a.name ?? 'artifact', type: a.type ?? '', url: a.url!, size: typeof a.size === 'number' ? a.size : null })),
      };
    }));
}

/** True while the oldest build in hand still belongs to the newest one's run: the run is being cut off by the page edge. */
export function runStillOpen(builds: Build[]): boolean {
  const newest = builds[0];
  const oldest = builds[builds.length - 1];
  return !!newest?.runId && newest.runId === oldest?.runId;
}

const hasNextPage = (raw: unknown): boolean => typeof (raw as { nextPageUrl?: unknown }).nextPageUrl === 'string';

/**
 * Creation time in seconds from a Codemagic build id, which is a MongoDB ObjectId whose first four bytes are a unix
 * timestamp. Reading the floor off the id rather than off a field is what makes the backfill guard below hold against
 * a snapshot stored by an older build of this app: ids are always there, added fields are not.
 *
 * An id that does not parse reads as infinitely new, never infinitely old. The guard's job is to drop builds it can
 * prove are older than what was already seen, so anything unprovable has to stay a notification: a stray duplicate
 * alert is a nuisance, a silently swallowed build failure is not.
 */
export function idTime(id: string): number {
  const seconds = Number.parseInt(id.slice(0, 8), 16);
  return Number.isFinite(seconds) ? seconds : Number.POSITIVE_INFINITY;
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

/** How many builds are kept per app. The oldest fall off beyond this, bounding both the stored snapshot and the state the browser loads. */
export const MAX_BUILDS = PAGE_SIZE * MAX_PAGES;

/** Newest first, with this poll's answer winning over anything stored for the same build. */
export function mergeBuilds(fetched: Build[], stored: Build[]): Build[] {
  const fresh = new Set(fetched.map((b) => b.id));
  return sortBuilds([...fetched, ...stored.filter((b) => !fresh.has(b.id))]).slice(0, MAX_BUILDS);
}

/**
 * One app's builds, merged into what the last poll stored.
 *
 * A build that has reached a terminal status never changes again, so re-reading it every thirty seconds is waste:
 * on a release fanning out to seventy store apps that is megabytes a minute spent on builds that finished hours
 * ago. So each poll reads from the newest build downwards only as far as the first page it already knows to be
 * settled, and keeps everything below that from the stored snapshot.
 *
 * When nothing is in flight the poll is cheap anyway, so it spends one page extending the window downwards
 * instead. That is how history fills in: a run too deep to reach in a single poll completes over the quiet polls
 * that follow, rather than costing anything while a release is actually running.
 */
async function fetchAppBuilds(
  ctx: SourceContext<CodemagicConfig>,
  app: AppMeta,
  stored: Build[],
  storedMore: boolean,
): Promise<{ builds: Build[]; moreBuilds: boolean }> {
  const known = new Map(stored.map((b) => [b.id, b]));
  const alreadySettled = (b: Build): boolean => {
    const before = known.get(b.id);
    return !!before && !isRunning(before.status);
  };
  const page = async (skip: number) => {
    const raw = await codemagicJson(ctx.fetch, ctx.config.token, `/builds?appId=${encodeURIComponent(app.id)}&limit=${PAGE_SIZE}&skip=${skip}`);
    return { batch: parseBuilds(raw, app), more: hasNextPage(raw) };
  };

  // The builds that could have moved since last time are exactly the ones that were not finished then. Codemagic
  // works a run oldest first and adds new builds on top, so those live builds sit at the newest end -- usually
  // inside the very first page.
  const wasLive = [...known.values()].filter((b) => isRunning(b.status)).map((b) => b.id);
  const fetchedIds = new Set<string>();

  const fetched: Build[] = [];
  let more = false;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const { batch, more: hasMore } = await page(fetched.length);
    fetched.push(...batch);
    for (const b of batch) fetchedIds.add(b.id);
    more = hasMore;
    if (batch.length === 0 || !hasMore) break;
    // Every build that could have changed has been re-read, and this page reaches builds already held, so there is
    // no gap and nothing below can have moved. This is the case that makes a release poll cheap.
    if (wasLive.every((id) => fetchedIds.has(id)) && batch.some(alreadySettled)) break;
    // Paging deeper is only worth it for an app that bulk-releases, and that is read off the data rather than
    // configured: a new bulk-releasing app starts paging on its own, and a retired one stops costing anything.
    if (!hasFanOut(fetched) || !runStillOpen(fetched)) break; // the newest run is covered end to end
  }

  let builds = mergeBuilds(fetched, stored);
  // `more` describes the page it came from. That is a statement about the whole window only when this poll read to
  // the bottom of it; when the poll stopped early the stored answer is the one that still holds.
  let moreBuilds = fetched.length >= builds.length ? more : storedMore;

  if (moreBuilds && builds.length < MAX_BUILDS && !builds.some((b) => isRunning(b.status))) {
    const { batch, more: hasMore } = await page(builds.length);
    builds = mergeBuilds([...fetched, ...batch], stored);
    moreBuilds = hasMore;
  }
  return { builds, moreBuilds };
}

/**
 * How long an app with nothing in flight may go without being re-read. While a release runs the poll drops to
 * thirty seconds for the sake of the builds that are moving, and there is no reason to drag six idle apps along at
 * that rate: every /builds response carries the full application list, so a call for an app with no builds still
 * costs about a tenth of a megabyte. Idle apps keep the ordinary interval and their stored builds are reused.
 */
export const QUIET_APP_MS = 120_000;

export async function fetchCodemagic(ctx: SourceContext<CodemagicConfig>, previous: CodemagicSnapshot | null, force = false): Promise<CodemagicSnapshot> {
  const apps = parseApps(await codemagicJson(ctx.fetch, ctx.config.token, '/apps'));
  const stored = new Map((previous?.apps ?? []).map((a) => [a.id, a]));
  const now = ctx.now();
  const out: CodemagicApp[] = [];
  for (let i = 0; i < apps.length; i += 4) {
    const chunk = apps.slice(i, i + 4);
    const done = await Promise.all(chunk.map(async (app): Promise<CodemagicApp> => {
      const before = stored.get(app.id);
      const quiet = !force
        && before != null
        && !before.builds.some((b) => isRunning(b.status))
        && now - (before.checkedAt ?? 0) < QUIET_APP_MS;
      if (quiet && before) {
        return { ...app, builds: before.builds, moreBuilds: before.moreBuilds, checkedAt: before.checkedAt };
      }
      return { ...app, ...(await fetchAppBuilds(ctx, app, before?.builds ?? [], before?.moreBuilds ?? false)), checkedAt: now };
    }));
    out.push(...done);
  }
  return { apps: out };
}

export function diffCodemagic(prev: CodemagicSnapshot | null, next: CodemagicSnapshot): NewEvent[] {
  if (!prev) return [];
  const before = new Map<string, Build>();
  for (const a of prev.apps) for (const b of a.builds) before.set(b.id, b);
  /**
   * Newest build already seen per app. An unseen build normally means one that appeared and finished between two
   * polls, which is worth an event -- but paging deeper also backfills old finished builds that were simply never in
   * a snapshot before. Without this floor, the first poll after the window grows fires one notification per backfilled
   * build; on a 24-app bulk release that is 42 alerts about builds that finished weeks ago.
   *
   * An app missing from `prev` altogether has no floor to compare against and is skipped for one poll. An app that
   * was present but empty floors at zero, so its builds still notify -- there is no history there to backfill.
   */
  const floor = new Map<string, number>();
  for (const a of prev.apps) floor.set(a.id, a.builds.reduce((newest, b) => Math.max(newest, idTime(b.id)), 0));
  const events: NewEvent[] = [];
  for (const app of next.apps) {
    for (const b of app.builds) {
      const p = before.get(b.id);
      if (!p && idTime(b.id) <= (floor.get(app.id) ?? Number.POSITIVE_INFINITY)) continue;
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
