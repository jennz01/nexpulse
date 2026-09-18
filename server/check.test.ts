import { expect, test } from 'bun:test';
import { formatTable, summarize } from './check';

test('summarize gives a one-line count per source', () => {
  expect(summarize('github', { login: 'j', incoming: [1, 2], mine: [3] })).toBe('2 incoming, 1 mine');
  expect(summarize('codemagic', { apps: [{ builds: [1, 2] }, { builds: [] }] })).toBe('2 apps, 2 builds');
  expect(summarize('lark', { tasks: { total: 5 }, issues: { counts: { OPEN: 4, CLOSED: 1 } }, feedback: { records: [1] } })).toBe('5 tasks, 5 issues, 1 feedback');
  expect(summarize('appstore', { apps: [1] })).toBe('1 apps');
  expect(summarize('playstore', { apps: [1, 2] })).toBe('2 apps');
});

test('formatTable pads columns', () => {
  expect(formatTable([['a', 'OK', 'x'], ['long', 'ERROR', 'y']])).toBe('a     OK     x\nlong  ERROR  y');
});
