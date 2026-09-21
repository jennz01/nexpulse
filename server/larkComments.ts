import type { LarkComment, LarkCommentReply } from '../shared/types';
import type { LarkConfig, LarkTableKey } from './config';
import { cliMessage, run } from './proc';
import type { Runner } from './sources/types';
import type { Store } from './store';

/** The comment list API's maximum page size. */
const PAGE_SIZE = 100;
/** A hard stop on the first sweep; 100 pages is 10 000 threads, far more than any Base this dashboard watches. */
const MAX_PAGES = 100;
/** batch_query accepts at most 100 comment ids per call. */
const ID_BATCH = 100;
/** Contact lookups are chunked smaller so the comma-joined argument stays short. */
const NAME_BATCH = 50;
/** How many long threads are re-read at once; each one is a lark-cli process. */
const REPLY_FETCHES = 4;

export interface RawElement {
  text_run?: { text?: string } | null;
  person?: { user_id?: string } | null;
  docs_link?: { url?: string } | null;
}
export interface RawReply {
  reply_id?: string;
  user_id?: string;
  create_time?: number;
  content?: { elements?: RawElement[] } | null;
  extra?: { image_list?: unknown; notify_extra?: { record?: string; table?: string } | null } | null;
}
export interface RawComment {
  comment_id?: string;
  is_solved?: boolean;
  /** Set by batch_query when the thread holds more replies than the five it returns. */
  has_more?: boolean;
  reply_list?: { replies?: RawReply[] } | null;
}

/** Comment ids are snowflakes: bigger means newer, and they run past the safe integer range. */
const isId = (s: string): boolean => /^\d{1,19}$/.test(s);
export const newerId = (a: string, b: string | null): boolean => {
  if (!isId(a)) return false;
  if (b == null || !isId(b)) return true;
  return BigInt(a) > BigInt(b);
};

/** One reply's text. A `person` element is an @mention and carries only an open_id, so the name is looked up here. */
export function replyText(elements: RawElement[] | undefined | null, nameOf: (id: string) => string): string {
  if (!elements) return '';
  return elements
    .map((e) => {
      if (typeof e.text_run?.text === 'string') return e.text_run.text;
      if (e.person?.user_id) return `@${nameOf(e.person.user_id)}`;
      if (typeof e.docs_link?.url === 'string') return e.docs_link.url;
      return '';
    })
    .join('')
    .trim();
}

/** Drive media tokens of the images pasted into a reply. */
export function imageTokens(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(t));
}

/**
 * Which record a thread hangs off. Lark records it on the reply rather than the thread, and only on the replies it
 * notified about, so the first reply naming one decides; a thread with none is a comment on the Base itself.
 */
export function anchorOf(c: RawComment): { tableId: string; recordId: string } | null {
  for (const r of c.reply_list?.replies ?? []) {
    const ne = r.extra?.notify_extra;
    if (ne?.table && ne.record) return { tableId: ne.table, recordId: ne.record };
  }
  return null;
}

export function toComment(c: RawComment, nameOf: (id: string) => string): LarkComment {
  const replies = (c.reply_list?.replies ?? []).map((r): LarkCommentReply => ({
    id: r.reply_id ?? '',
    author: nameOf(r.user_id ?? ''),
    createdAt: typeof r.create_time === 'number' ? r.create_time * 1000 : 0,
    text: replyText(r.content?.elements, nameOf),
    images: imageTokens(r.extra?.image_list),
  }));
  return { id: c.comment_id ?? '', isSolved: c.is_solved === true, replies };
}

/** lark-cli wraps the API payload as `{ code, data }` on success and `{ ok: false, error }` on failure. */
export function extractComments(json: unknown): { items: RawComment[]; hasMore: boolean; pageToken: string | null } {
  if (!json || typeof json !== 'object') throw new Error('lark-cli returned no JSON object');
  const top = json as Record<string, unknown>;
  if (top.ok === false) {
    const err = (top.error ?? {}) as { message?: string };
    throw new Error(`lark-cli: ${err.message ?? 'request failed'}`);
  }
  const data = (top.data && typeof top.data === 'object' ? top.data : top) as Record<string, unknown>;
  const items = Array.isArray(data.items) ? (data.items as RawComment[]) : [];
  const token = typeof data.page_token === 'string' && data.page_token ? data.page_token : null;
  return { items, hasMore: data.has_more === true, pageToken: token };
}

const key = (tableId: string, recordId: string): string => `${tableId}:${recordId}`;

/**
 * A Base record's comments are Drive comments on the Base document, tagged with the record they were written on.
 * Lark offers no way to ask for one record's comments, so this keeps an index of thread -> record, persisted in
 * SQLite so a restart costs nothing.
 *
 * Staying current is two problems, not one. New threads are cheap: the list is ordered by comment id and its
 * `page_token` is literally the last id returned, so passing the newest known id asks only for threads created
 * since. New *replies* to old threads are invisible that way, because a thread never moves when it is replied to.
 * So thread bodies are never cached: opening a record batch-queries its threads and gets them as they are now.
 */
export class LarkComments {
  private readonly names = new Map<string, string>();
  private readonly index = new Map<string, string[]>();
  private newest: string | null = null;
  private indexing = false;
  private running: Promise<void> | null = null;
  private swept: boolean;

  constructor(
    private readonly cfg: LarkConfig,
    private readonly store: Store,
    private readonly runner: Runner = run,
    private readonly log: (line: string) => void = () => {},
  ) {
    const rows = store.larkCommentIndex(cfg.baseToken);
    for (const r of rows) this.remember(r.tableId, r.recordId, r.commentId);
    this.newest = store.newestLarkComment(cfg.baseToken);
    this.swept = rows.length > 0;
    for (const [id, name] of store.larkUserNames()) this.names.set(id, name);
  }

  /** Starts the first index in the background, or catches up when one is already stored. Never throws. */
  start(): void {
    const first = !this.swept;
    if (first) this.indexing = true;
    const started = Date.now();
    void this.refresh()
      .then((added) => {
        if (first) this.log(`lark comments: indexed ${this.store.countLarkComments(this.cfg.baseToken)} threads in ${Math.round((Date.now() - started) / 1000)} s`);
        else if (added) this.log(`lark comments: ${added} new thread(s)`);
      })
      .catch((e) => this.log(`lark comments: ${first ? 'first index' : 'refresh'} failed (${(e as Error).message})`))
      .finally(() => { this.indexing = false; });
  }

  /** Picks up threads created since the last run, sweeping the whole Base when nothing is indexed yet. One at a time. */
  refresh(): Promise<number> {
    if (this.running) return this.running.then(() => 0);
    let added = 0;
    const job = this.walk(this.swept ? this.newest : null)
      .then((n) => { added = n; this.swept = true; })
      .finally(() => { this.running = null; });
    this.running = job;
    return job.then(() => added);
  }

  /**
   * One record's comments as Lark has them right now. The index says which threads to ask for; their contents are
   * always fetched, so replies added to an old thread show up. `indexing` warns that the first sweep is still running.
   */
  async forRecord(table: LarkTableKey, recordId: string): Promise<{ comments: LarkComment[]; indexing: boolean }> {
    const ids = this.index.get(key(this.cfg.tables[table].tableId, recordId)) ?? [];
    if (ids.length === 0) return { comments: [], indexing: this.indexing };
    const raw: RawComment[] = [];
    for (let i = 0; i < ids.length; i += ID_BATCH) raw.push(...(await this.batch(ids.slice(i, i + ID_BATCH))));
    await this.fillReplies(raw);
    await this.resolveNames(raw);
    const nameOf = (id: string): string => this.names.get(id) ?? id;
    // Oldest thread first, the order Lark's own comment panel uses.
    const comments = raw.map((c) => toComment(c, nameOf)).sort((a, b) => (newerId(a.id, b.id) ? 1 : -1));
    return { comments, indexing: this.indexing };
  }

  private remember(tableId: string, recordId: string, commentId: string): void {
    const k = key(tableId, recordId);
    const ids = this.index.get(k);
    if (!ids) this.index.set(k, [commentId]);
    else if (!ids.includes(commentId)) ids.push(commentId);
  }

  /** Walks pages from `from` (null = from the very beginning), indexing every thread that names a record. */
  private async walk(from: string | null): Promise<number> {
    let token = from;
    let added = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { items, hasMore, pageToken } = await this.list(token);
      const rows: { commentId: string; tableId: string; recordId: string }[] = [];
      for (const c of items) {
        if (c.comment_id && newerId(c.comment_id, this.newest)) this.newest = c.comment_id;
        const a = anchorOf(c);
        if (a && c.comment_id) rows.push({ commentId: c.comment_id, tableId: a.tableId, recordId: a.recordId });
      }
      this.store.saveLarkComments(this.cfg.baseToken, rows);
      for (const r of rows) this.remember(r.tableId, r.recordId, r.commentId);
      added += rows.length;
      if (!hasMore || !pageToken || items.length === 0) break;
      token = pageToken;
    }
    return added;
  }

  private async list(pageToken: string | null): Promise<{ items: RawComment[]; hasMore: boolean; pageToken: string | null }> {
    const params: Record<string, unknown> = { file_token: this.cfg.baseToken, file_type: 'bitable', page_size: PAGE_SIZE };
    if (pageToken) params.page_token = pageToken;
    return extractComments(await this.cli(['drive', 'file.comments', 'list', '--params', JSON.stringify(params)], 'listing comments'));
  }

  private async batch(ids: string[]): Promise<RawComment[]> {
    const params = JSON.stringify({ file_token: this.cfg.baseToken, file_type: 'bitable' });
    const args = ['drive', 'file.comments', 'batch_query', '--params', params, '--data', JSON.stringify({ comment_ids: ids })];
    return extractComments(await this.cli(args, 'reading comments')).items;
  }

  /**
   * batch_query returns only a thread's first five replies and flags the rest with `has_more`, so a long
   * conversation would quietly show as five. Those threads are re-read in full, a few at a time. A thread that
   * cannot be re-read keeps its first five rather than disappearing.
   */
  private async fillReplies(threads: RawComment[]): Promise<void> {
    const long = threads.filter((c) => c.has_more === true && c.comment_id);
    for (let i = 0; i < long.length; i += REPLY_FETCHES) {
      await Promise.all(long.slice(i, i + REPLY_FETCHES).map(async (c) => {
        try {
          const replies = await this.replies(c.comment_id!);
          if (replies.length > 0) c.reply_list = { replies };
        } catch (e) {
          this.log(`lark comments: could not read every reply of ${c.comment_id} (${(e as Error).message})`);
        }
      }));
    }
  }

  private async replies(commentId: string): Promise<RawReply[]> {
    const params = JSON.stringify({ file_token: this.cfg.baseToken, file_type: 'bitable', comment_id: commentId, page_size: 100 });
    const out = await this.cli(['drive', 'file.comment.replys', 'list', '--page-all', '--page-limit', '10', '--params', params], 'reading replies');
    const top = (out ?? {}) as Record<string, unknown>;
    const data = (top.data && typeof top.data === 'object' ? top.data : top) as Record<string, unknown>;
    return Array.isArray(data.items) ? (data.items as RawReply[]) : [];
  }

  private async cli(args: string[], what: string): Promise<unknown> {
    const res = await this.runner('lark-cli', [...args, '--as', 'user', '--format', 'json'], { timeoutMs: 60_000 });
    if (res.timedOut) throw new Error(`lark-cli timed out ${what}`);
    if (res.code !== 0) throw new Error(`lark-cli exited ${res.code} ${what}: ${cliMessage(res.stderr || res.stdout, 'no output')}`);
    try {
      return JSON.parse(res.stdout) as unknown;
    } catch {
      throw new Error(`lark-cli returned non-JSON ${what}: ${res.stdout.trim().split(/\r?\n/)[0] ?? ''}`);
    }
  }

  /**
   * Display names for comment authors and @mentions. Names are cached for good, and an id the lookup does not
   * return is cached as itself so a deactivated account is not looked up again on every open. A failed lookup is
   * logged and swallowed: the comments are still worth showing with raw ids where names would be.
   */
  private async resolveNames(raw: RawComment[]): Promise<void> {
    const want = new Set<string>();
    for (const c of raw) {
      for (const r of c.reply_list?.replies ?? []) {
        if (r.user_id) want.add(r.user_id);
        for (const e of r.content?.elements ?? []) if (e.person?.user_id) want.add(e.person.user_id);
      }
    }
    const missing = [...want].filter((id) => !this.names.has(id));
    if (missing.length === 0) return;
    const found = new Map<string, string>();
    try {
      for (let i = 0; i < missing.length; i += NAME_BATCH) {
        const chunk = missing.slice(i, i + NAME_BATCH);
        const res = await this.runner('lark-cli', ['contact', '+search-user', '--as', 'user', '--format', 'json', '--user-ids', chunk.join(',')], { timeoutMs: 30_000 });
        if (res.code !== 0) throw new Error(cliMessage(res.stderr || res.stdout, 'no output'));
        const json = JSON.parse(res.stdout) as { data?: { users?: unknown[] } };
        for (const u of json.data?.users ?? []) {
          const o = u as { open_id?: unknown; localized_name?: unknown; name?: unknown };
          const name = [o.localized_name, o.name].find((v): v is string => typeof v === 'string' && v.trim() !== '');
          if (typeof o.open_id === 'string' && name) found.set(o.open_id, name.trim());
        }
      }
    } catch (e) {
      this.log(`lark comments: name lookup failed (${(e as Error).message})`);
    }
    for (const id of missing) this.names.set(id, found.get(id) ?? id);
    if (found.size > 0) this.store.saveLarkUserNames(found);
  }
}
