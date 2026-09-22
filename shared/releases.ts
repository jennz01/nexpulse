// shared/releases.ts — bulk release runs, derived from the flat build list a Codemagic poll returns.
//
// A "bulk release" fans one commit out into one build per white-label store app. Every build of the run carries the
// same commit hash and its own brand identity, so the run is recoverable from the builds alone and nothing about it
// needs to be stored or configured.

import { BUILD_TERMINAL_STATUSES, isBuildFailed } from './status';
import type { Build, CodemagicApp, CodemagicSnapshot } from './types';

/**
 * A run has to reach at least this many distinct store apps. Sharing a commit is not enough on its own: re-running
 * or cancelling and retrying an ordinary build also produces two builds of one commit, and that is not a release.
 */
export const MIN_RUN_BRANDS = 2;

export interface RunCounts {
  total: number;
  queued: number;
  /** Past the queue and on a machine: preparing, fetching, building, testing, publishing. */
  running: number;
  /** Reached any terminal status, failures included — the numerator of the progress bar. */
  settled: number;
  /** Failed or timed out; a subset of `settled`. */
  failed: number;
}

export interface ReleaseRun {
  /** The commit hash every build of the run shares. */
  id: string;
  shortId: string;
  appId: string;
  appName: string;
  /** Commit subject, e.g. "Launch v1.1.13 (#77)". */
  title: string;
  branch: string;
  version: string | null;
  /** When the run's first build was accepted. */
  createdAt: string | null;
  /** Running first, then the queue in the order it will be worked, then everything settled. */
  builds: Build[];
  counts: RunCounts;
  /** Something is still queued or on a machine. */
  active: boolean;
  /** The poll stopped paging before this run's oldest build, so builds may be missing from it. */
  partial: boolean;
}

const isTerminal = (status: string): boolean => BUILD_TERMINAL_STATUSES.has(status);

/** Distinct store apps among these builds. Builds with no brand at all are ordinary builds and count for nothing. */
export function brandCount(builds: Build[]): number {
  return new Set(builds.map((b) => b.brand).filter((brand): brand is string => !!brand)).size;
}

/** True when these builds are a bulk release: one commit reaching several store apps. */
export const isFanOut = (builds: Build[]): boolean => brandCount(builds) >= MIN_RUN_BRANDS;

/** True when any one run among these builds is a fan-out — how a poll decides an app is worth paging deeper. */
export function hasFanOut(builds: Build[]): boolean {
  const byRun = new Map<string, Build[]>();
  for (const b of builds) {
    if (!b.runId) continue;
    byRun.set(b.runId, [...(byRun.get(b.runId) ?? []), b]);
  }
  return [...byRun.values()].some(isFanOut);
}

export function countBuilds(builds: Build[]): RunCounts {
  const counts: RunCounts = { total: builds.length, queued: 0, running: 0, settled: 0, failed: 0 };
  for (const b of builds) {
    if (b.status === 'queued') counts.queued++;
    else if (!isTerminal(b.status)) counts.running++;
    else {
      counts.settled++;
      if (isBuildFailed(b.status)) counts.failed++;
    }
  }
  return counts;
}

/** 0–1. An empty run reads as complete rather than dividing by zero. */
export const runProgress = (counts: RunCounts): number => (counts.total === 0 ? 1 : counts.settled / counts.total);

/** Brand first, falling back to the bundle id and finally the build number, so a row always says which app it is. */
export function buildLabel(b: Build): string {
  return b.brand || b.bundleId || (b.buildNumber != null ? `#${b.buildNumber}` : b.id.slice(0, 8));
}

/** Running, then queued, then settled; each group keeps the order Codemagic will work it, oldest first. */
function orderWithinRun(builds: Build[]): Build[] {
  const rank = (b: Build): number => (b.status === 'queued' ? 1 : isTerminal(b.status) ? 2 : 0);
  const when = (b: Build): string => b.createdAt ?? b.startedAt ?? '';
  return [...builds].sort((a, b) => rank(a) - rank(b) || when(a).localeCompare(when(b)));
}

/**
 * The app's builds grouped into runs, newest run first. Only fan-outs qualify, so an app that never bulk-releases
 * yields nothing and never shows up on the Releases page.
 */
export function releaseRuns(app: CodemagicApp): ReleaseRun[] {
  const byRun = new Map<string, Build[]>();
  for (const b of app.builds) {
    if (!b.runId) continue;
    byRun.set(b.runId, [...(byRun.get(b.runId) ?? []), b]);
  }

  const runs = [...byRun.entries()]
    .filter(([, builds]) => isFanOut(builds))
    .map(([id, group]) => {
      const builds = orderWithinRun(group);
      const counts = countBuilds(builds);
      const newest = group[0]!;
      return {
        id,
        shortId: id.slice(0, 7),
        appId: app.id,
        appName: app.name,
        title: newest.commitMessage ?? newest.workflowName,
        branch: newest.branch,
        version: builds.find((b) => b.version)?.version ?? null,
        createdAt: builds.map((b) => b.createdAt ?? b.startedAt ?? '').filter(Boolean).sort()[0] ?? null,
        builds,
        counts,
        active: counts.queued + counts.running > 0,
        partial: false,
      };
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  // Only the oldest run can have been cut off by where the poll stopped paging; everything newer is whole by
  // construction, because paging continues until the live run is complete.
  const oldest = runs[runs.length - 1];
  if (oldest && app.moreBuilds) oldest.partial = true;
  return runs;
}

/** Every app that bulk-releases, in snapshot order, with its runs. Apps without runs are dropped. */
export function releaseApps(snapshot: CodemagicSnapshot | null): { app: CodemagicApp; runs: ReleaseRun[] }[] {
  if (!snapshot) return [];
  return snapshot.apps
    .map((app) => ({ app, runs: releaseRuns(app) }))
    .filter((entry) => entry.runs.length > 0);
}

/** Builds still queued or on a machine across every run — what the page header and the nav badge count. */
export function inFlightCount(snapshot: CodemagicSnapshot | null): number {
  return releaseApps(snapshot).reduce(
    (n, { runs }) => n + runs.reduce((m, r) => m + r.counts.queued + r.counts.running, 0),
    0,
  );
}
