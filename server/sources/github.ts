import type { CiState, GithubSnapshot, NewEvent, PullRequest, ReviewDecision } from '../../shared/types';
import { SourceError } from './types';
import type { Runner, Source, SourceContext } from './types';

export interface GithubConfig {
  account: string;
}

export const GITHUB_QUERY = `
query {
  viewer { login }
  incoming: search(query: "is:pr is:open review-requested:@me", type: ISSUE, first: 50) { nodes { ...PR } }
  mine: search(query: "is:pr is:open author:@me", type: ISSUE, first: 50) { nodes { ...PR } }
}
fragment PR on PullRequest {
  id number title url isDraft createdAt updatedAt
  author { login avatarUrl }
  repository { nameWithOwner }
  reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

interface RawPR {
  id: string; number: number; title: string; url: string; isDraft: boolean; createdAt: string; updatedAt: string;
  author: { login: string; avatarUrl: string } | null;
  repository: { nameWithOwner: string };
  reviewDecision: string | null;
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
}
interface RawResponse {
  data?: { viewer: { login: string }; incoming: { nodes: Array<RawPR | null> }; mine: { nodes: Array<RawPR | null> } };
  errors?: Array<{ message: string }>;
}

const REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
const CI_STATES = new Set(['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED']);

function toPR(raw: RawPR): PullRequest {
  const rollup = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    isDraft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    authorLogin: raw.author?.login ?? 'ghost',
    authorAvatarUrl: raw.author?.avatarUrl ?? '',
    repo: raw.repository.nameWithOwner,
    reviewDecision: raw.reviewDecision && REVIEW_DECISIONS.has(raw.reviewDecision) ? (raw.reviewDecision as ReviewDecision) : null,
    ci: rollup && CI_STATES.has(rollup) ? (rollup as CiState) : null,
  };
}

export function parseGithub(raw: unknown): GithubSnapshot {
  const r = raw as RawResponse;
  if (r.errors?.length) throw new SourceError(`GitHub GraphQL: ${r.errors.map((e) => e.message).join('; ')}`);
  if (!r.data) throw new SourceError('GitHub GraphQL: response has no data');
  const nodes = (list: Array<RawPR | null>) => list.filter((n): n is RawPR => n != null && typeof n.number === 'number').map(toPR);
  return { login: r.data.viewer.login, incoming: nodes(r.data.incoming.nodes), mine: nodes(r.data.mine.nodes) };
}

const prLabel = (pr: PullRequest) => `${pr.repo.split('/')[1] ?? pr.repo} #${pr.number}: ${pr.title}`;
const isRed = (ci: CiState) => ci === 'FAILURE' || ci === 'ERROR';

export function diffGithub(prev: GithubSnapshot | null, next: GithubSnapshot): NewEvent[] {
  if (!prev) return [];
  const events: NewEvent[] = [];
  const prevIncoming = new Set(prev.incoming.map((p) => p.id));
  for (const pr of next.incoming) {
    if (prevIncoming.has(pr.id)) continue;
    events.push({ source: 'github', kind: 'pr.review_requested', priority: 'high', itemId: pr.id, title: `Review requested: ${prLabel(pr)}`, url: pr.url });
  }
  const prevMine = new Map(prev.mine.map((p) => [p.id, p]));
  for (const pr of next.mine) {
    const before = prevMine.get(pr.id);
    if (!before) continue;
    if (pr.reviewDecision !== before.reviewDecision && (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === 'CHANGES_REQUESTED')) {
      const word = pr.reviewDecision === 'APPROVED' ? 'Approved' : 'Changes requested';
      events.push({ source: 'github', kind: 'pr.review_decision', priority: 'normal', itemId: pr.id, title: `${word}: ${prLabel(pr)}`, url: pr.url });
    }
    if (isRed(pr.ci) && !isRed(before.ci)) {
      events.push({ source: 'github', kind: 'pr.ci_failed', priority: 'normal', itemId: pr.id, title: `CI failing: ${prLabel(pr)}`, url: pr.url });
    }
  }
  return events;
}

export function ghHint(text: string): string | undefined {
  return /auth login|not logged|authentication|token|HTTP 401|HTTP 403/i.test(text) ? 'run `gh auth login`' : undefined;
}
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? '';

export async function fetchGithub(ctx: SourceContext<GithubConfig>): Promise<GithubSnapshot> {
  const res = await ctx.run('gh', ['api', 'graphql', '--input', '-'], { stdin: JSON.stringify({ query: GITHUB_QUERY }) });
  if (res.timedOut) throw new SourceError('gh api graphql timed out after 60 s');
  if (res.code !== 0) throw new SourceError(`gh exited ${res.code}: ${firstLine(res.stderr)}`, ghHint(res.stderr));
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new SourceError(`gh returned non-JSON output: ${firstLine(res.stdout)}`);
  }
  const snap = parseGithub(json);
  if (snap.login !== ctx.config.account) {
    throw new SourceError(`gh is logged in as ${snap.login}, expected ${ctx.config.account}`, `run \`gh auth switch --user ${ctx.config.account}\``);
  }
  return snap;
}

/** Startup check: disables the source only when the active gh account is wrong; a transient/offline `gh` failure is a warning, not a disable (spec §5.1). */
export async function checkGithubAccount(run: Runner, expected: string): Promise<{ disabled: string | null; warning: string | null }> {
  const res = await run('gh', ['api', 'user', '-q', '.login'], { timeoutMs: 20_000 });
  if (res.code !== 0) {
    const hint = ghHint(res.stderr);
    return { disabled: null, warning: `gh not ready: ${firstLine(res.stderr) || 'unknown error'}${hint ? ` (${hint})` : ''}` };
  }
  const login = res.stdout.trim();
  if (login !== expected) return { disabled: `gh active account is ${login}, expected ${expected} (run \`gh auth switch --user ${expected}\`)`, warning: null };
  return { disabled: null, warning: null };
}

export const githubSource: Source<GithubSnapshot, GithubConfig> = {
  id: 'github',
  defaultIntervalSec: 60,
  fetch: fetchGithub,
  diff: diffGithub,
};
