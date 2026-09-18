import { expect, test } from 'bun:test';
import { iosStateClass, joinStoreApps, playStatusClass } from './Stores';
import type { AppStoreApp, PlayApp } from '../../../shared/types';

const ios = (account: string, name: string): AppStoreApp => ({ account, appId: name, name, bundleId: 'b', live: null, inflight: null, url: 'u' });
const android = (account: string, name: string): PlayApp => ({ account, packageName: name, name, releases: [], url: 'u' });

test('joinStoreApps groups by account in config order and pairs by name', () => {
  const rows = joinStoreApps({ apps: [ios('B', 'Shop'), ios('A', 'SGPOS')] }, { apps: [android('A', 'SGPOS'), android('A', 'Only Android')] }, ['A', 'B']);
  expect(rows.map((r) => [r.account, r.name, !!r.ios, !!r.android])).toEqual([
    ['A', 'SGPOS', true, true],
    ['A', 'Only Android', false, true],
    ['B', 'Shop', true, false],
  ]);
});

test('joinStoreApps tolerates a missing snapshot', () => {
  expect(joinStoreApps(null, { apps: [android('A', 'X')] }, []).map((r) => r.name)).toEqual(['X']);
});

test('state classes', () => {
  expect(iosStateClass('READY_FOR_SALE')).toBe('ok');
  expect(iosStateClass('REJECTED')).toBe('fail');
  expect(iosStateClass('IN_REVIEW')).toBe('warn');
  expect(iosStateClass('PREPARE_FOR_SUBMISSION')).toBe('plain');
  expect(playStatusClass('completed')).toBe('ok');
  expect(playStatusClass('inProgress')).toBe('run');
  expect(playStatusClass('halted')).toBe('fail');
  expect(playStatusClass('draft')).toBe('plain');
});
