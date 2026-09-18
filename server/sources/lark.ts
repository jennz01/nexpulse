import type { LarkAttachment, LarkGroup, LarkRecord, LarkSnapshot, NewEvent } from '../../shared/types';
import type { LarkConfig, LarkTableKey } from '../config';
import { cliMessage } from '../proc';
import { SourceError } from './types';
import type { Runner, Source, SourceContext } from './types';

export const PAGE_SIZE = 200;
const MAX_PAGES = 25;

export interface RawRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

const isRawRecord = (x: unknown): x is RawRecord =>
  !!x && typeof x === 'object' && typeof (x as RawRecord).record_id === 'string' && typeof (x as RawRecord).fields === 'object';

/**
 * lark-cli wraps the Lark API payload. Accepted shapes: the tabular envelope lark-cli 1.0 returns
 * (`data.data` rows aligned with `data.fields` names and `data.record_id_list`), an `items`/`records`
 * list at top level or under `data`, or a bare array of records. An `ok: false` envelope becomes a SourceError.
 */
export function extractPage(json: unknown): { items: RawRecord[]; hasMore: boolean } {
  if (Array.isArray(json)) return { items: json.filter(isRawRecord), hasMore: false };
  if (!json || typeof json !== 'object') throw new SourceError('lark-cli returned no JSON object');
  const top = json as Record<string, unknown>;
  if (top.ok === false) {
    const err = (top.error ?? {}) as { message?: string; hint?: string };
    throw new SourceError(`lark-cli: ${err.message ?? 'request failed'}`, err.hint?.split(/\r?\n/)[0]);
  }
  const data = (top.data && typeof top.data === 'object' ? top.data : top) as Record<string, unknown>;
  if (Array.isArray(data.data) && Array.isArray(data.fields) && Array.isArray(data.record_id_list)) {
    const names = data.fields as unknown[];
    const ids = data.record_id_list as unknown[];
    const items = (data.data as unknown[]).flatMap((row, i): RawRecord[] => {
      const id = ids[i];
      if (!Array.isArray(row) || typeof id !== 'string') return [];
      const fields: Record<string, unknown> = {};
      names.forEach((name, j) => {
        if (typeof name === 'string') fields[name] = row[j];
      });
      return [{ record_id: id, fields }];
    });
    return { items, hasMore: data.has_more === true };
  }
  const list = [data.items, data.records, data.list].find(Array.isArray) as unknown[] | undefined;
  if (!list) throw new SourceError(`lark-cli response has no items array (keys: ${Object.keys(data).join(', ')})`);
  return { items: list.filter(isRawRecord), hasMore: data.has_more === true };
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Flatten any Lark cell value (text segments, people, selects, formulas, dates) to display text. */
export function cellToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
      const ms = Date.parse(s);
      if (Number.isFinite(ms)) return formatDate(ms); // datetime cells arrive as ISO strings
    }
    return s.replace(/\[([^\]]+)\]\((?:mailto:)?[^)]*\)/g, '$1'); // "[x@y.com](mailto:x@y.com)" -> "x@y.com"
  }
  if (typeof v === 'number') return v > 1e11 && v < 1e13 ? formatDate(v) : String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) {
    const parts = v.map(cellToString).filter(Boolean);
    const segments = v.length > 0 && v.every((x) => x && typeof x === 'object' && 'type' in (x as object) && 'text' in (x as object));
    return parts.join(segments ? '' : ', ');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text.trim();
    if (typeof o.name === 'string') return o.name.trim();
    if ('value' in o) return cellToString(o.value);
    if (typeof o.link === 'string') return o.link;
    if (typeof o.en_name === 'string') return o.en_name;
    return '';
  }
  return String(v);
}

export const recordUrl = (domain: string, baseToken: string, tableId: string, viewId: string, recordId: string): string =>
  `https://${domain}/base/${baseToken}?table=${tableId}&view=${viewId}&record=${recordId}`;

/** An attachment cell is a list of `{ file_token, name, size }`; anything else means no attachments. */
export function parseAttachments(v: unknown): LarkAttachment[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a): LarkAttachment[] => {
    if (!a || typeof a !== 'object') return [];
    const o = a as { file_token?: unknown; name?: unknown; size?: unknown };
    if (typeof o.file_token !== 'string' || !o.file_token) return [];
    return [{ token: o.file_token, name: typeof o.name === 'string' && o.name ? o.name : 'file', size: typeof o.size === 'number' ? o.size : 0 }];
  });
}

/** Maps the configured columns to display strings; the `attachments` column (when mapped) becomes structured data instead. */
export function mapRecord(raw: RawRecord, fields: Record<string, string | undefined>, url: string): LarkRecord {
  const out: Record<string, string> = {};
  const rec: LarkRecord = { recordId: raw.record_id, url, fields: out };
  for (const [logical, larkName] of Object.entries(fields)) {
    if (!larkName) continue;
    if (logical === 'attachments') rec.attachments = parseAttachments(raw.fields[larkName]);
    else out[logical] = cellToString(raw.fields[larkName]);
  }
  return rec;
}

/** Group by fields.status. With `order`, groups follow it and unlisted statuses are dropped; otherwise order of first appearance. */
export function groupByStatus(records: LarkRecord[], order?: string[]): LarkGroup[] {
  const groups = new Map<string, LarkRecord[]>();
  if (order) for (const s of order) groups.set(s, []);
  for (const r of records) {
    const status = r.fields.status ?? '';
    if (order && !groups.has(status)) continue;
    (groups.get(status) ?? groups.set(status, []).get(status)!).push(r);
  }
  return [...groups.entries()].filter(([, rs]) => rs.length > 0).map(([status, rs]) => ({ status, records: rs }));
}

/**
 * Order task groups for display: `first` statuses in that order, then the remaining groups in their given
 * order, then `last` statuses (the collapsed ones) at the end. lark-cli does not return records in view order.
 */
export function orderGroups(groups: LarkGroup[], first: string[], last: string[]): LarkGroup[] {
  const rank = (status: string): number => {
    const f = first.indexOf(status);
    if (f !== -1) return f;
    const l = last.indexOf(status);
    if (l !== -1) return first.length + groups.length + l;
    return first.length + groups.findIndex((g) => g.status === status);
  };
  return [...groups].sort((a, b) => rank(a.status) - rank(b.status));
}

export function buildLarkSnapshot(raw: Record<LarkTableKey, RawRecord[]>, cfg: LarkConfig): LarkSnapshot {
  const t = cfg.tables;
  const url = (key: LarkTableKey, id: string) => recordUrl(cfg.domain, cfg.baseToken, t[key].tableId, t[key].viewId, id);

  const tasks = raw.tasks.map((r) => mapRecord(r, t.tasks.fields, url('tasks', r.record_id)));
  const issues = raw.issues.map((r) => mapRecord(r, t.issues.fields, url('issues', r.record_id)));
  const counts: Record<string, number> = {};
  for (const r of issues) {
    const s = r.fields.status ?? '';
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const feedback = raw.feedback.slice(0, t.feedback.limit).map((r) => mapRecord(r, t.feedback.fields, url('feedback', r.record_id)));

  return {
    tasks: { groups: orderGroups(groupByStatus(tasks), t.tasks.groupOrder, t.tasks.collapsedStatuses), total: tasks.length },
    issues: { groups: groupByStatus(issues, t.issues.showStatuses), counts },
    feedback: { records: feedback },
  };
}

export function diffLark(prev: LarkSnapshot | null, next: LarkSnapshot, openStatus = 'OPEN'): NewEvent[] {
  if (!prev) return [];
  const events: NewEvent[] = [];
  const known = new Set(prev.issues.groups.flatMap((g) => g.records.map((r) => r.recordId)));
  for (const r of next.issues.groups.find((g) => g.status === openStatus)?.records ?? []) {
    if (known.has(r.recordId)) continue;
    const f = r.fields;
    events.push({ source: 'lark', kind: 'issue.opened', priority: 'high', itemId: r.recordId, title: `New issue ${f.ticketId ?? r.recordId}: ${(f.description ?? '').slice(0, 120)}`, url: r.url });
  }
  const knownFeedback = new Set(prev.feedback.records.map((r) => r.recordId));
  for (const r of next.feedback.records) {
    if (knownFeedback.has(r.recordId)) continue;
    const f = r.fields;
    events.push({ source: 'lark', kind: 'feedback.new', priority: 'normal', itemId: r.recordId, title: `New feedback (${f.category ?? ''}): ${(f.text ?? '').slice(0, 120)}`, url: r.url });
  }
  return events;
}

export const larkHint = (text: string): string | undefined =>
  /not configured|config init/i.test(text) ? 'run `lark-cli config init` once on this PC (Settings → Connections shows the steps)'
  : /token|auth|login|permission|forbidden|99991|not logged/i.test(text) ? 'run `lark-cli auth login`' : undefined;
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? '';

export async function listRecords(run: Runner, cfg: LarkConfig, key: LarkTableKey): Promise<RawRecord[]> {
  const t = cfg.tables[key];
  const all: RawRecord[] = [];
  // Project only the mapped columns: a full row of a wide table is several KB, and only these are read.
  // Naming a column here also returns it when the view hides it (lark-cli reports field_scope "selected_fields").
  const projection = [...new Set(Object.values(t.fields).filter((name): name is string => !!name))].flatMap((name) => ['--field-id', name]);
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = [
      'base', '+record-list',
      '--base-token', cfg.baseToken,
      '--table-id', t.tableId,
      '--view-id', t.viewId,
      '--as', 'user',
      '--format', 'json',
      ...projection,
      '--limit', String(PAGE_SIZE),
      '--offset', String(page * PAGE_SIZE),
    ];
    const res = await run('lark-cli', args);
    if (res.timedOut) throw new SourceError(`lark-cli timed out reading ${key}`);
    if (res.code !== 0) throw new SourceError(`lark-cli exited ${res.code} reading ${key}: ${cliMessage(res.stderr || res.stdout, 'no output')}`, larkHint(res.stderr + res.stdout));
    let json: unknown;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      throw new SourceError(`lark-cli returned non-JSON for ${key}: ${firstLine(res.stdout)}`);
    }
    const { items, hasMore } = extractPage(json);
    all.push(...items);
    if (items.length === 0 || (!hasMore && items.length < PAGE_SIZE)) break;
  }
  return all;
}

export async function fetchLark(ctx: SourceContext<LarkConfig>): Promise<LarkSnapshot> {
  const [tasks, issues, feedback] = await Promise.all([
    listRecords(ctx.run, ctx.config, 'tasks'),
    listRecords(ctx.run, ctx.config, 'issues'),
    listRecords(ctx.run, ctx.config, 'feedback'),
  ]);
  return buildLarkSnapshot({ tasks, issues, feedback }, ctx.config);
}

export const larkSource: Source<LarkSnapshot, LarkConfig> = {
  id: 'lark',
  defaultIntervalSec: 120,
  fetch: fetchLark,
  diff: diffLark,
};
