import { describe, expect, test } from 'bun:test';
import { computeAttention, emptyStates, parseDays } from './attention';
import type { SourceStates } from './types';

const cfg = { pendingLaunchStatus: 'PENDING TO LAUNCH', showIssueStatuses: ['OPEN', 'CHECKING'] };
const NOW = Date.parse('2026-09-17T02:00:00Z');
const withSnapshot = <K extends keyof SourceStates>(states: SourceStates, key: K, snapshot: NonNullable<SourceStates[K]['snapshot']>): SourceStates =>
  ({ ...states, [key]: { ...states[key], snapshot, fetchedAt: NOW } });

const pr = (over: Record<string, unknown>) => ({ id: 'x', number: 1, title: 't', url: 'u', isDraft: false, createdAt: '', updatedAt: '', authorLogin: 'a', authorAvatarUrl: '', repo: 'o/r', reviewDecision: null, ci: null, ...over });

describe('computeAttention', () => {
  test('empty states produce no chips', () => {
    expect(computeAttention(emptyStates(), cfg, NOW)).toEqual([]);
  });

  test('pull requests: non-draft incoming and my PRs needing changes', () => {
    const states = withSnapshot(emptyStates(), 'github', {
      login: 'j',
      incoming: [pr({ id: '1' }), pr({ id: '2', isDraft: true }), pr({ id: '3' })],
      mine: [pr({ id: '4', reviewDecision: 'CHANGES_REQUESTED' }), pr({ id: '5', ci: 'FAILURE' }), pr({ id: '6' })],
    });
    const chips = computeAttention(states, cfg, NOW);
    expect(chips.map((c) => [c.id, c.text, c.tone, c.target])).toEqual([
      ['prs-incoming', '2 PRs await your review', 'amber', 'prs'],
      ['prs-mine', '2 of your PRs need changes', 'amber', 'prs'],
    ]);
  });

  test('a single non-draft incoming PR uses singular verb agreement', () => {
    const states = withSnapshot(emptyStates(), 'github', { login: 'j', incoming: [pr({ id: '1' })], mine: [] });
    const chips = computeAttention(states, cfg, NOW);
    expect(chips.map((c) => c.text)).toEqual(['1 PR awaits your review']);
  });

  test('builds: failures in the last 24 h and running builds', () => {
    const build = (id: string, status: string, finishedAt: string | null) => ({ id, appId: 'a', workflowId: 'w', workflowName: 'ios-release', branch: 'main', status, startedAt: null, finishedAt, durationSec: null, startedBy: null, url: 'u', artifacts: [] });
    const states = withSnapshot(emptyStates(), 'codemagic', {
      apps: [{ id: 'a', name: 'SGPOS', workflows: [], builds: [build('1', 'failed', '2026-09-17T01:00:00Z'), build('2', 'failed', '2026-09-15T01:00:00Z'), build('3', 'building', null)] }],
    });
    const chips = computeAttention(states, cfg, NOW);
    expect(chips.map((c) => [c.id, c.text, c.detail, c.tone, c.pulse])).toEqual([
      ['builds-failed', '1 build failed', 'SGPOS · ios-release', 'red', false],
      ['builds-running', '1 building', null, 'grey', true],
    ]);
  });

  test('lark: open issues with oldest age, checking count, pending launch tasks', () => {
    const rec = (id: string, fields: Record<string, string>) => ({ recordId: id, url: 'u', fields });
    const states = withSnapshot(emptyStates(), 'lark', {
      tasks: { groups: [{ status: 'PENDING TO LAUNCH', records: [rec('t1', {}), rec('t2', {})] }, { status: 'IN PROGRESS', records: [rec('t3', {})] }], total: 3 },
      issues: {
        groups: [
          { status: 'OPEN', records: [rec('i1', { hoursSince: '24 hours | 1 days' }), rec('i2', { hoursSince: '1237 hours | 51.5 days' })] },
          { status: 'CHECKING', records: [rec('i3', { hoursSince: '217 hours | 9 days' })] },
        ],
        counts: { OPEN: 2, CHECKING: 1 },
      },
      feedback: { records: [] },
    });
    expect(computeAttention(states, cfg, NOW).map((c) => [c.id, c.text, c.detail, c.tone])).toEqual([
      ['issues-open', '2 open issues', 'oldest 51.5 d', 'amber'],
      ['issues-checking', '1 checking', null, 'grey'],
      ['tasks-pending', '2 pending to launch', null, 'blue'],
    ]);
  });

  test('stores: one chip per iOS app in an attention state and per Android rollout', () => {
    let states = withSnapshot(emptyStates(), 'appstore', {
      apps: [
        { account: 'A', appId: '1', name: 'SGPOS', bundleId: 'b', live: { version: '1', state: 'READY_FOR_SALE' }, inflight: { version: '2', state: 'REJECTED' }, url: 'u' },
        { account: 'A', appId: '2', name: 'Shop', bundleId: 'b', live: { version: '1', state: 'READY_FOR_SALE' }, inflight: { version: '2', state: 'WAITING_FOR_REVIEW' }, url: 'u' },
        { account: 'A', appId: '3', name: 'Quiet', bundleId: 'b', live: { version: '1', state: 'READY_FOR_SALE' }, inflight: null, url: 'u' },
      ],
    });
    states = withSnapshot(states, 'playstore', {
      apps: [{ account: 'A', packageName: 'p', name: 'SGPOS', url: 'u', releases: [
        { track: 'production', name: '1', versionCodes: [], status: 'completed', userFraction: null },
        { track: 'beta', name: '2', versionCodes: [], status: 'inProgress', userFraction: 0.2 },
      ] }],
    });
    expect(computeAttention(states, cfg, NOW).map((c) => [c.id, c.text, c.detail, c.tone])).toEqual([
      ['ios-A-1', 'SGPOS iOS', 'Rejected', 'red'],
      ['ios-A-2', 'Shop iOS', 'Waiting for Review', 'amber'],
      ['android-A-p-beta', 'SGPOS Android', 'beta 20% rollout', 'blue'],
    ]);
  });
});

test('parseDays reads the days figure, falls back to hours', () => {
  expect(parseDays('1237 hours | 51.5 days')).toBe(51.5);
  expect(parseDays('6 hours')).toBe(0.25);
  expect(parseDays('')).toBeNull();
});
