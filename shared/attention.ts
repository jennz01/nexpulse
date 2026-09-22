import { releaseRuns } from './releases';
import { APPSTORE_ATTENTION_STATES, APPSTORE_REJECTED_STATES, PLAY_ATTENTION_STATUSES, humanState, isBuildFailed, isBuildRunning } from './status';
import { SOURCE_IDS } from './types';
import type { AttentionChip, PanelId, PublicConfig, SourceStates } from './types';

export function emptyStates(): SourceStates {
  const out: Record<string, unknown> = {};
  for (const id of SOURCE_IDS) out[id] = { snapshot: null, fetchedAt: null, error: null, errorAt: null, disabled: null };
  return out as SourceStates;
}

/** "1237 hours | 51.5 days" -> 51.5; "6 hours" -> 0.25; anything else -> null. */
export function parseDays(hoursSince: string): number | null {
  const days = /([\d.]+)\s*days?/i.exec(hoursSince);
  if (days) return Number(days[1]);
  const hours = /([\d.]+)\s*hours?/i.exec(hoursSince);
  return hours ? Number(hours[1]) / 24 : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const DAY_MS = 24 * 3600 * 1000;

export function computeAttention(states: SourceStates, config: Pick<PublicConfig, 'pendingLaunchStatus' | 'showIssueStatuses'>, now: number): AttentionChip[] {
  const chips: AttentionChip[] = [];
  const chip = (c: Omit<AttentionChip, 'detail' | 'pulse'> & Partial<Pick<AttentionChip, 'detail' | 'pulse'>>) =>
    chips.push({ detail: null, pulse: false, ...c });

  const gh = states.github.snapshot;
  if (gh) {
    const incoming = gh.incoming.filter((p) => !p.isDraft).length;
    if (incoming) chip({ id: 'prs-incoming', text: `${plural(incoming, 'PR')} await${incoming === 1 ? 's' : ''} your review`, tone: 'amber', target: 'prs' });
    const mine = gh.mine.filter((p) => p.reviewDecision === 'CHANGES_REQUESTED' || p.ci === 'FAILURE' || p.ci === 'ERROR').length;
    if (mine) chip({ id: 'prs-mine', text: `${mine} of your PRs need${mine === 1 ? 's' : ''} changes`, tone: 'amber', target: 'prs' });
  }

  const cm = states.codemagic.snapshot;
  if (cm) {
    // A chip has to land on the builds it counted, and a bulk release's builds are listed on their own page rather
    // than on Builds, so the counts split the same way the two pages do.
    const inRuns = new Set(cm.apps.flatMap((app) => releaseRuns(app).flatMap((r) => r.builds.map((b) => b.id))));
    const all = cm.apps.flatMap((app) => app.builds.map((b) => ({ app, b, target: (inRuns.has(b.id) ? 'releases' : 'builds') as PanelId })));
    for (const target of ['builds', 'releases'] as PanelId[]) {
      const mine = all.filter((x) => x.target === target);
      const failed = mine.filter(({ b }) => isBuildFailed(b.status) && b.finishedAt && now - Date.parse(b.finishedAt) < DAY_MS);
      if (failed.length) {
        const one = failed.length === 1 ? failed[0] : null;
        chip({ id: `${target}-failed`, text: `${plural(failed.length, 'build')} failed`, detail: one ? `${one.app.name} · ${one.b.brand ?? one.b.workflowName}` : null, tone: 'red', target });
      }
      const running = mine.filter(({ b }) => isBuildRunning(b.status)).length;
      if (running) chip({ id: `${target}-running`, text: `${running} building`, tone: 'grey', target, pulse: true });
    }
  }

  const lark = states.lark.snapshot;
  if (lark) {
    const [openStatus, checkingStatus] = config.showIssueStatuses;
    const open = lark.issues.groups.find((g) => g.status === openStatus);
    if (open && open.records.length) {
      const oldest = Math.max(...open.records.map((r) => parseDays(r.fields.hoursSince ?? '') ?? 0));
      chip({ id: 'issues-open', text: `${plural(open.records.length, 'open issue')}`, detail: oldest > 0 ? `oldest ${oldest} d` : null, tone: 'amber', target: 'issues' });
    }
    const checking = lark.issues.groups.find((g) => g.status === checkingStatus);
    if (checking && checking.records.length) chip({ id: 'issues-checking', text: `${checking.records.length} checking`, tone: 'grey', target: 'issues' });
    const pending = lark.tasks.groups.find((g) => g.status === config.pendingLaunchStatus);
    if (pending && pending.records.length) chip({ id: 'tasks-pending', text: `${pending.records.length} pending to launch`, tone: 'blue', target: 'tasks' });
  }

  const asc = states.appstore.snapshot;
  if (asc) {
    for (const app of asc.apps) {
      const v = app.inflight && APPSTORE_ATTENTION_STATES.has(app.inflight.state) ? app.inflight : null;
      if (!v) continue;
      chip({ id: `ios-${app.account}-${app.appId}`, text: `${app.name} iOS`, detail: humanState(v.state), tone: APPSTORE_REJECTED_STATES.has(v.state) ? 'red' : 'amber', target: 'stores' });
    }
  }

  const play = states.playstore.snapshot;
  if (play) {
    for (const app of play.apps) {
      for (const r of app.releases) {
        if (!PLAY_ATTENTION_STATUSES.has(r.status)) continue;
        const detail = r.status === 'halted' ? `${r.track} halted` : `${r.track} ${Math.round((r.userFraction ?? 0) * 100)}% rollout`;
        chip({ id: `android-${app.account}-${app.packageName}-${r.track}`, text: `${app.name} Android`, detail, tone: r.status === 'halted' ? 'red' : 'blue', target: 'stores' });
      }
    }
  }

  return chips;
}
