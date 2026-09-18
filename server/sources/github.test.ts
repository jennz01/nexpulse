import { describe, expect, test } from 'bun:test';
import fixture from './__fixtures__/github.json';
import { checkGithubAccount, diffGithub, fetchGithub, parseGithub } from './github';
import type { GithubSnapshot, PullRequest } from '../../shared/types';
import type { Runner, SourceContext } from './types';

describe('parseGithub', () => {
  const snap = parseGithub(fixture);

  test('maps both lists and the viewer login', () => {
    expect(snap.login).toBe('jennsg');
    expect(snap.incoming.map((p) => p.number)).toEqual([482, 217]);
    expect(snap.mine.map((p) => p.number)).toEqual([470]);
  });

  test('maps repo, author, review decision and CI rollup', () => {
    const pr = snap.incoming[0]!;
    expect(pr).toMatchObject({ repo: 'sitegiant/sgpos-mobile', authorLogin: 'syamil', reviewDecision: 'REVIEW_REQUIRED', ci: 'SUCCESS', isDraft: false });
  });

  test('tolerates a deleted author and a missing rollup', () => {
    const pr = snap.incoming[1]!;
    expect(pr.authorLogin).toBe('ghost');
    expect(pr.ci).toBeNull();
    expect(pr.reviewDecision).toBeNull();
  });

  test('throws a SourceError on GraphQL errors', () => {
    expect(() => parseGithub({ errors: [{ message: 'Bad credentials' }] })).toThrow('Bad credentials');
  });
});

const pr = (id: string, over: Partial<PullRequest> = {}): PullRequest => ({
  id, number: 1, title: 'T', url: `https://github.com/o/r/pull/${id}`, isDraft: false, createdAt: '', updatedAt: '',
  authorLogin: 'a', authorAvatarUrl: '', repo: 'o/r', reviewDecision: 'REVIEW_REQUIRED', ci: 'SUCCESS', ...over,
});
const snap = (incoming: PullRequest[], mine: PullRequest[]): GithubSnapshot => ({ login: 'jennsg', incoming, mine });

describe('diffGithub', () => {
  test('first snapshot produces nothing', () => {
    expect(diffGithub(null, snap([pr('a')], []))).toEqual([]);
  });

  test('a new incoming PR is a high-priority review request', () => {
    const events = diffGithub(snap([pr('a')], []), snap([pr('a'), pr('b', { number: 9, title: 'New' })], []));
    expect(events).toEqual([{ source: 'github', kind: 'pr.review_requested', priority: 'high', itemId: 'b', title: 'Review requested: r #9: New', url: 'https://github.com/o/r/pull/b' }]);
  });

  test('review decision changes on my PRs are normal events', () => {
    const events = diffGithub(snap([], [pr('m')]), snap([], [pr('m', { reviewDecision: 'CHANGES_REQUESTED' })]));
    expect(events.map((e) => e.kind)).toEqual(['pr.review_decision']);
    expect(events[0]?.title).toStartWith('Changes requested:');
  });

  test('CI turning red on my PR is a normal event, staying red is not', () => {
    const red = pr('m', { ci: 'FAILURE' });
    expect(diffGithub(snap([], [pr('m')]), snap([], [red])).map((e) => e.kind)).toEqual(['pr.ci_failed']);
    expect(diffGithub(snap([], [red]), snap([], [red]))).toEqual([]);
  });

  test('unchanged snapshots produce nothing', () => {
    const s = snap([pr('a')], [pr('m')]);
    expect(diffGithub(s, s)).toEqual([]);
  });
});

describe('fetchGithub / checkGithubAccount', () => {
  const ctxWith = (run: Runner): SourceContext<{ account: string }> => ({ config: { account: 'jennsg' }, run, fetch, log: () => {}, now: Date.now });

  test('sends the query on stdin and parses stdout', async () => {
    let seen: { args: string[]; stdin?: string } | null = null;
    const run: Runner = async (_cmd, args, opts) => { seen = { args, stdin: opts?.stdin }; return { stdout: JSON.stringify(fixture), stderr: '', code: 0, timedOut: false }; };
    const snap = await fetchGithub(ctxWith(run));
    expect(snap.incoming).toHaveLength(2);
    expect(seen!.args).toEqual(['api', 'graphql', '--input', '-']);
    expect(JSON.parse(seen!.stdin!).query).toContain('review-requested:@me');
  });

  test('a non-zero exit with an auth message carries a hint', async () => {
    const run: Runner = async () => ({ stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login', code: 4, timedOut: false });
    await expect(fetchGithub(ctxWith(run))).rejects.toThrow('gh exited 4');
    await expect(fetchGithub(ctxWith(run))).rejects.toMatchObject({ hint: 'run `gh auth login`' });
  });

  test('a different active account is rejected', async () => {
    const other = { ...fixture, data: { ...fixture.data, viewer: { login: 'mobileapp-sitegiant' } } };
    const run: Runner = async () => ({ stdout: JSON.stringify(other), stderr: '', code: 0, timedOut: false });
    await expect(fetchGithub(ctxWith(run))).rejects.toThrow('logged in as mobileapp-sitegiant');
  });

  test('checkGithubAccount returns no disable/warning when the login matches, a disable reason on a wrong account, a warning (not a disable) on a transient failure', async () => {
    expect(await checkGithubAccount(async () => ({ stdout: 'jennsg\n', stderr: '', code: 0, timedOut: false }), 'jennsg')).toEqual({ disabled: null, warning: null });
    expect((await checkGithubAccount(async () => ({ stdout: 'other\n', stderr: '', code: 0, timedOut: false }), 'jennsg')).disabled).toContain('gh auth switch');
    const transient = await checkGithubAccount(async () => ({ stdout: '', stderr: 'error connecting', code: 1, timedOut: false }), 'jennsg');
    expect(transient.warning).toContain('gh not ready');
    expect(transient.disabled).toBeNull();
  });
});
