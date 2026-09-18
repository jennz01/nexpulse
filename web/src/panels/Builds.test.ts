import { expect, test } from 'bun:test';
import { latestPerWorkflow, statusClass } from './Builds';
import type { Build, CodemagicApp } from '../../../shared/types';

const b = (id: string, workflowId: string, status: string): Build => ({ id, appId: 'a', workflowId, workflowName: workflowId, branch: 'main', status, startedAt: null, finishedAt: null, durationSec: null, startedBy: null, url: '', artifacts: [] });
const app: CodemagicApp = { id: 'a', name: 'A', workflows: [], builds: [b('1', 'ios', 'building'), b('2', 'android', 'finished'), b('3', 'ios', 'failed')] };

test('latestPerWorkflow keeps the first (newest) build of each workflow in order', () => {
  expect(latestPerWorkflow(app).map((x) => x.id)).toEqual(['1', '2']);
});

test('statusClass maps build statuses to tag classes', () => {
  expect(statusClass('building')).toBe('run');
  expect(statusClass('failed')).toBe('fail');
  expect(statusClass('timeout')).toBe('fail');
  expect(statusClass('finished')).toBe('ok');
  expect(statusClass('warning')).toBe('warn');
  expect(statusClass('canceled')).toBe('plain');
});
