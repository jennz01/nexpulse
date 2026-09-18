import { describe, expect, test } from 'bun:test';
import fixture from './__fixtures__/lark-record-list.json';
import tabular from './__fixtures__/lark-record-list-tabular.json';
import { PAGE_SIZE, buildLarkSnapshot, cellToString, diffLark, extractPage, groupByStatus, listRecords, orderGroups, recordUrl } from './lark';
import type { LarkConfig } from '../config';
import type { LarkGroup, LarkRecord, LarkSnapshot } from '../../shared/types';
import type { Runner } from './types';

const cfg: LarkConfig = {
  domain: 'example.larksuite.com',
  baseToken: 'bascT',
  tables: {
    tasks: { tableId: 'tblTasks', viewId: 'vewJ1', pendingLaunchStatus: 'PENDING TO LAUNCH', collapsedStatuses: ['PRODUCTION'], groupOrder: [],
      fields: { title: 'Task Name', status: 'Status', pic: 'PIC', type: 'Task Type', priority: 'Priority', progress: 'Progress' } },
    issues: { tableId: 'tblIssues', viewId: 'vewJ2', showStatuses: ['OPEN', 'CHECKING'],
      fields: { ticketId: 'Ticket ID', reportedDate: 'Reported Date', hoursSince: 'Hours Since', priority: 'Priority', store: 'ERP Store Name / Email', description: 'Issue Description', status: 'Status' } },
    feedback: { tableId: 'tblFb', viewId: 'vewJ3', limit: 2, groupOrder: [],
      fields: { reportedDate: 'Reported Date', category: 'Category', store: 'ERP Store Name / Email', text: 'Feedback / Suggestion' } },
  },
};

describe('cellToString', () => {
  test('flattens text segments, people, selects, numbers and formulas', () => {
    const f = fixture.data.items[2]!.fields;
    expect(cellToString(f['Task Name'])).toBe('[QE] MOBILE/SGPOS (GENERAL) - BCRS');
    expect(cellToString(fixture.data.items[0]!.fields.PIC)).toBe('Jenn, Syamil Aiman');
    expect(cellToString(f.Status)).toBe('SENIOR QC');
    expect(cellToString(f.Progress)).toBe('0.6');
    expect(cellToString(f['Hours Since'])).toBe('24 hours | 1 days');
    expect(cellToString(f['ERP Store Name / Email'])).toBe('store@example.com');
    expect(cellToString(f['Reported Date'])).toMatch(/^2026\/09\/1\d \d\d:\d\d$/);
    expect(cellToString(null)).toBe('');
    expect(cellToString(true)).toBe('Yes');
  });
});

describe('extractPage', () => {
  test('reads items and has_more from a wrapped payload', () => {
    const page = extractPage(fixture);
    expect(page.items.map((i) => i.record_id)).toEqual(['recA1', 'recA2', 'recA3']);
    expect(page.hasMore).toBe(false);
  });
  test('accepts an unwrapped payload and a bare array', () => {
    expect(extractPage({ items: fixture.data.items, has_more: true }).hasMore).toBe(true);
    expect(extractPage(fixture.data.items).items).toHaveLength(3);
  });
  test('rejects a payload without records', () => {
    expect(() => extractPage({ data: { foo: 1 } })).toThrow('no items array');
  });
  test('reads the tabular envelope lark-cli 1.0 returns (rows aligned with fields and record_id_list)', () => {
    const page = extractPage(tabular);
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]?.record_id).toBe(tabular.data.record_id_list[0]);
    expect(page.items[0]?.fields['Task Name']).toBe(tabular.data.data[0]?.[0]);
    expect(page.items[0]?.fields['Dev Status']).toEqual(['CLOSED']);
    expect(page.items[2]?.fields['Dev Status']).toEqual(['PRODUCTION']);
  });
  test('surfaces an ok:false envelope as a SourceError carrying the hint', () => {
    const bad = { ok: false, error: { type: 'authentication', message: 'need_user_authorization', hint: 'run: lark-cli auth login to re-authorize\ncurrent command requires scope(s): base:record:read' } };
    expect(() => extractPage(bad)).toThrow('need_user_authorization');
    try {
      extractPage(bad);
    } catch (e) {
      expect((e as { hint?: string }).hint).toBe('run: lark-cli auth login to re-authorize');
    }
  });
});

describe('cellToString on real lark-cli cell shapes', () => {
  test('ISO datetimes render as local yyyy/mm/dd hh:mm', () => {
    expect(cellToString('2026-09-16T09:22:58.000+08:00')).toMatch(/^2026\/09\/1\d \d\d:\d\d$/);
  });
  test('markdown mailto links collapse to their text; select arrays join', () => {
    expect(cellToString('Leverex / [rem@example.com](mailto:rem@example.com)')).toBe('Leverex / rem@example.com');
    expect(cellToString(['OPEN'])).toBe('OPEN');
    expect(cellToString([{ id: 'ou_1', name: 'Person A' }, { id: 'ou_2', name: 'Person B' }])).toBe('Person A, Person B');
  });
});

describe('buildLarkSnapshot', () => {
  const rec = (id: string, fields: Record<string, unknown>) => ({ record_id: id, fields });
  const raw = {
    tasks: fixture.data.items,
    issues: [
      rec('i1', { 'Ticket ID': '#G001', Status: 'RESOLVED', Priority: 'Normal' }),
      rec('i2', { 'Ticket ID': '#G002', Status: 'OPEN', Priority: 'Normal', 'Hours Since': '69 hours | 2.9 days' }),
      rec('i3', { 'Ticket ID': '#G003', Status: 'CHECKING', Priority: 'Normal' }),
      rec('i4', { 'Ticket ID': '#G004', Status: 'CLOSED' }),
    ],
    feedback: [rec('f1', { Category: 'A' }), rec('f2', { Category: 'B' }), rec('f3', { Category: 'C' })],
  };
  const snap = buildLarkSnapshot(raw, cfg);

  test('groups tasks by status in order of first appearance', () => {
    expect(snap.tasks.groups.map((g) => [g.status, g.records.length])).toEqual([['PENDING TO LAUNCH', 2], ['SENIOR QC', 1]]);
    expect(snap.tasks.total).toBe(3);
    expect(snap.tasks.groups[0]?.records[0]?.fields).toMatchObject({ title: '[FEATURE] MOBILE/SGPOS (RECEIPT) - Show item based discount on Receipt', priority: 'High', pic: 'Jenn, Syamil Aiman' });
  });
  test('issues: only shown statuses become groups, counts cover every status', () => {
    expect(snap.issues.groups.map((g) => g.status)).toEqual(['OPEN', 'CHECKING']);
    expect(snap.issues.counts).toEqual({ RESOLVED: 1, OPEN: 1, CHECKING: 1, CLOSED: 1 });
  });
  test('feedback is truncated to the configured limit', () => {
    expect(snap.feedback.records.map((r) => r.recordId)).toEqual(['f1', 'f2']);
  });
  test('every record deep-links to itself in its table and view', () => {
    expect(snap.issues.groups[0]?.records[0]?.url).toBe('https://example.larksuite.com/base/bascT?table=tblIssues&view=vewJ2&record=i2');
    expect(recordUrl('d', 'b', 't', 'v', 'r')).toBe('https://d/base/b?table=t&view=v&record=r');
  });
});

describe('orderGroups', () => {
  const g = (status: string): LarkGroup => ({ status, records: [] });
  test('configured statuses first, then the rest as given, collapsed ones last', () => {
    const groups = [g('CLOSED'), g('PRODUCTION'), g('IN PROGRESS'), g('SENIOR QC'), g('ON HOLD'), g('PENDING TO LAUNCH')];
    expect(orderGroups(groups, ['PENDING TO LAUNCH', 'SENIOR QC', 'IN PROGRESS'], ['PRODUCTION', 'CLOSED']).map((x) => x.status)).toEqual([
      'PENDING TO LAUNCH', 'SENIOR QC', 'IN PROGRESS', 'ON HOLD', 'PRODUCTION', 'CLOSED',
    ]);
  });
  test('with no configuration the order is unchanged', () => {
    expect(orderGroups([g('B'), g('A')], [], []).map((x) => x.status)).toEqual(['B', 'A']);
  });
});

describe('groupByStatus', () => {
  const r = (id: string, status: string): LarkRecord => ({ recordId: id, url: '', fields: { status } });
  test('honours an explicit order and drops empty groups', () => {
    expect(groupByStatus([r('a', 'CHECKING'), r('b', 'OPEN')], ['OPEN', 'CHECKING', 'X']).map((g) => g.status)).toEqual(['OPEN', 'CHECKING']);
  });
});

describe('diffLark', () => {
  const r = (id: string, status: string): LarkRecord => ({ recordId: id, url: `u/${id}`, fields: { status, ticketId: `#${id}`, description: 'd', text: 't', category: 'c' } });
  const s = (open: LarkRecord[], checking: LarkRecord[], feedback: LarkRecord[]): LarkSnapshot => ({
    tasks: { groups: [], total: 0 },
    issues: { groups: [{ status: 'OPEN', records: open }, { status: 'CHECKING', records: checking }], counts: {} },
    feedback: { records: feedback },
  });
  test('first snapshot produces nothing', () => {
    expect(diffLark(null, s([r('a', 'OPEN')], [], []))).toEqual([]);
  });
  test('a new record in the first issue group is a high event; new feedback is normal', () => {
    const events = diffLark(s([r('a', 'OPEN')], [], [r('f1', '')]), s([r('a', 'OPEN'), r('b', 'OPEN')], [], [r('f2', ''), r('f1', '')]));
    expect(events).toEqual([
      { source: 'lark', kind: 'issue.opened', priority: 'high', itemId: 'b', title: 'New issue #b: d', url: 'u/b' },
      { source: 'lark', kind: 'feedback.new', priority: 'normal', itemId: 'f2', title: 'New feedback (c): t', url: 'u/f2' },
    ]);
  });
  test('a record moving from CHECKING to OPEN is not "new"', () => {
    expect(diffLark(s([], [r('a', 'CHECKING')], []), s([r('a', 'OPEN')], [], []))).toEqual([]);
  });

  test('a new CHECKING record does not fire when the OPEN group is empty', () => {
    const prev: LarkSnapshot = { tasks: { groups: [], total: 0 }, issues: { groups: [{ status: 'CHECKING', records: [r('a', 'CHECKING')] }], counts: {} }, feedback: { records: [] } };
    const next: LarkSnapshot = { tasks: { groups: [], total: 0 }, issues: { groups: [{ status: 'CHECKING', records: [r('a', 'CHECKING'), r('b', 'CHECKING')] }], counts: {} }, feedback: { records: [] } };
    expect(diffLark(prev, next)).toEqual([]);
  });

  test('the open status is configurable', () => {
    const prev: LarkSnapshot = { tasks: { groups: [], total: 0 }, issues: { groups: [{ status: 'CHECKING', records: [] }, { status: 'OPEN', records: [r('a', 'OPEN')] }], counts: {} }, feedback: { records: [] } };
    const next: LarkSnapshot = { tasks: { groups: [], total: 0 }, issues: { groups: [{ status: 'CHECKING', records: [] }, { status: 'OPEN', records: [r('a', 'OPEN'), r('b', 'OPEN')] }], counts: {} }, feedback: { records: [] } };
    expect(diffLark(prev, next, 'OPEN').map((e) => e.kind)).toEqual(['issue.opened']);
  });
});

describe('listRecords', () => {
  test('pages with --offset until a short page arrives', async () => {
    const calls: string[][] = [];
    const page = (n: number) => ({ data: { has_more: n >= PAGE_SIZE, items: Array.from({ length: n }, (_, i) => ({ record_id: `r${i}`, fields: {} })) } });
    const run: Runner = async (_c, args) => { calls.push(args); const offset = Number(args[args.indexOf('--offset') + 1]); return { stdout: JSON.stringify(offset === 0 ? page(200) : page(5)), stderr: '', code: 0, timedOut: false }; };
    const items = await listRecords(run, cfg, 'issues');
    expect(items).toHaveLength(205);
    expect(calls).toHaveLength(2);
    const projection = ['Ticket ID', 'Reported Date', 'Hours Since', 'Priority', 'ERP Store Name / Email', 'Issue Description', 'Status'].flatMap((n) => ['--field-id', n]);
    expect(calls[0]).toEqual(['base', '+record-list', '--base-token', 'bascT', '--table-id', 'tblIssues', '--view-id', 'vewJ2', '--as', 'user', '--format', 'json', ...projection, '--limit', '200', '--offset', '0']);
  });
  test('a failing CLI with an auth message carries a login hint', async () => {
    const run: Runner = async () => ({ stdout: '', stderr: 'Error: user access token expired, please run lark-cli auth login', code: 1, timedOut: false });
    await expect(listRecords(run, cfg, 'tasks')).rejects.toMatchObject({ hint: 'run `lark-cli auth login`' });
  });
});
