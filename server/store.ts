import { Database } from 'bun:sqlite';
import { SOURCE_IDS } from '../shared/types';
import type { Event, NewEvent, Priority, SourceId, SourceStates } from '../shared/types';

export interface SnapshotRow<S = unknown> {
  data: S | null;
  fetchedAt: number | null;
  error: string | null;
  errorAt: number | null;
}

interface SnapshotDbRow { data: string | null; fetched_at: number | null; error: string | null; error_at: number | null }
interface CommentDbRow { comment_id: string; table_id: string; record_id: string }
interface EventDbRow { id: number; source: string; kind: string; priority: string; item_id: string; title: string; url: string | null; created_at: number; seen: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  source     TEXT PRIMARY KEY,
  data       TEXT,
  fetched_at INTEGER,
  error      TEXT,
  error_at   INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  priority   TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  url        TEXT,
  created_at INTEGER NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_unseen ON events(seen, created_at);
CREATE TABLE IF NOT EXISTS lark_comments (
  comment_id TEXT PRIMARY KEY,
  base_token TEXT NOT NULL,
  table_id   TEXT NOT NULL,
  record_id  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lark_comments_record ON lark_comments(base_token, table_id, record_id);
CREATE TABLE IF NOT EXISTS lark_users (
  open_id TEXT PRIMARY KEY,
  name    TEXT NOT NULL
);
`;

function rowToEvent(r: EventDbRow): Event {
  return {
    id: r.id,
    source: r.source as SourceId,
    kind: r.kind,
    priority: r.priority as Priority,
    itemId: r.item_id,
    title: r.title,
    url: r.url,
    createdAt: r.created_at,
    seen: r.seen === 1,
  };
}

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  getSnapshot<S = unknown>(source: SourceId): SnapshotRow<S> | null {
    const row = this.db
      .query<SnapshotDbRow, [string]>('SELECT data, fetched_at, error, error_at FROM snapshots WHERE source = ?')
      .get(source);
    if (!row) return null;
    return {
      data: row.data == null ? null : (JSON.parse(row.data) as S),
      fetchedAt: row.fetched_at,
      error: row.error,
      errorAt: row.error_at,
    };
  }

  saveSnapshot(source: SourceId, data: unknown, fetchedAt: number): void {
    this.db.run(
      `INSERT INTO snapshots (source, data, fetched_at, error, error_at) VALUES (?, ?, ?, NULL, NULL)
       ON CONFLICT(source) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at, error = NULL, error_at = NULL`,
      [source, JSON.stringify(data), fetchedAt],
    );
  }

  saveError(source: SourceId, error: string, errorAt: number): void {
    this.db.run(
      `INSERT INTO snapshots (source, data, fetched_at, error, error_at) VALUES (?, NULL, NULL, ?, ?)
       ON CONFLICT(source) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`,
      [source, error, errorAt],
    );
  }

  addEvents(events: NewEvent[], now: number): Event[] {
    if (events.length === 0) return [];
    const insert = this.db.query<{ id: number }, [string, string, string, string, string, string | null, number]>(
      'INSERT INTO events (source, kind, priority, item_id, title, url, created_at, seen) VALUES (?, ?, ?, ?, ?, ?, ?, 0) RETURNING id',
    );
    const out: Event[] = [];
    const tx = this.db.transaction(() => {
      for (const e of events) {
        const row = insert.get(e.source, e.kind, e.priority, e.itemId, e.title, e.url, now);
        if (!row) throw new Error('insert returned no id');
        out.push({ ...e, id: row.id, createdAt: now, seen: false });
      }
    });
    tx();
    return out;
  }

  unseenEvents(): Event[] {
    return this.db
      .query<EventDbRow, []>('SELECT * FROM events WHERE seen = 0 ORDER BY created_at ASC, id ASC')
      .all()
      .map(rowToEvent);
  }

  markSeen(opts: { ids?: number[]; source?: SourceId }): number {
    if (opts.ids && opts.ids.length > 0) {
      const placeholders = opts.ids.map(() => '?').join(',');
      return this.db.run(`UPDATE events SET seen = 1 WHERE seen = 0 AND id IN (${placeholders})`, opts.ids).changes;
    }
    if (opts.source) return this.db.run('UPDATE events SET seen = 1 WHERE seen = 0 AND source = ?', [opts.source]).changes;
    return this.db.run('UPDATE events SET seen = 1 WHERE seen = 0').changes;
  }

  pruneEvents(maxAgeMs: number, now: number): number {
    return this.db.run('DELETE FROM events WHERE created_at < ?', [now - maxAgeMs]).changes;
  }

  allStates(disabled: Partial<Record<SourceId, string>>): SourceStates {
    const states: Partial<Record<SourceId, unknown>> = {};
    for (const id of SOURCE_IDS) {
      const row = this.getSnapshot(id);
      states[id] = {
        snapshot: row?.data ?? null,
        fetchedAt: row?.fetchedAt ?? null,
        error: row?.error ?? null,
        errorAt: row?.errorAt ?? null,
        disabled: disabled[id] ?? null,
      };
    }
    return states as SourceStates;
  }

  // ---- Lark record comments. Which thread hangs off which record; the thread bodies are always fetched live. ----

  /** The whole index for one Base, oldest thread first (comment ids are snowflakes, so id order is creation order). */
  larkCommentIndex(baseToken: string): { commentId: string; tableId: string; recordId: string }[] {
    return this.db
      .query<CommentDbRow, [string]>('SELECT comment_id, table_id, record_id FROM lark_comments WHERE base_token = ? ORDER BY CAST(comment_id AS INTEGER) ASC')
      .all(baseToken)
      .map((r) => ({ commentId: r.comment_id, tableId: r.table_id, recordId: r.record_id }));
  }

  saveLarkComments(baseToken: string, rows: { commentId: string; tableId: string; recordId: string }[]): void {
    if (rows.length === 0) return;
    const insert = this.db.query<never, [string, string, string, string]>(
      `INSERT INTO lark_comments (comment_id, base_token, table_id, record_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(comment_id) DO UPDATE SET base_token = excluded.base_token, table_id = excluded.table_id, record_id = excluded.record_id`,
    );
    this.db.transaction(() => {
      for (const r of rows) insert.run(r.commentId, baseToken, r.tableId, r.recordId);
    })();
  }

  /** The highest comment id indexed for this Base; it doubles as the cursor that asks Lark only for newer threads. */
  newestLarkComment(baseToken: string): string | null {
    const row = this.db
      .query<{ comment_id: string }, [string]>('SELECT comment_id FROM lark_comments WHERE base_token = ? ORDER BY CAST(comment_id AS INTEGER) DESC LIMIT 1')
      .get(baseToken);
    return row?.comment_id ?? null;
  }

  countLarkComments(baseToken: string): number {
    return this.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM lark_comments WHERE base_token = ?').get(baseToken)?.n ?? 0;
  }

  /** open_id -> display name, for comment authors and @mentions. */
  larkUserNames(): Map<string, string> {
    const rows = this.db.query<{ open_id: string; name: string }, []>('SELECT open_id, name FROM lark_users').all();
    return new Map(rows.map((r) => [r.open_id, r.name]));
  }

  saveLarkUserNames(names: Iterable<[string, string]>): void {
    const insert = this.db.query<never, [string, string]>(
      'INSERT INTO lark_users (open_id, name) VALUES (?, ?) ON CONFLICT(open_id) DO UPDATE SET name = excluded.name',
    );
    this.db.transaction(() => {
      for (const [id, name] of names) insert.run(id, name);
    })();
  }

  close(): void {
    this.db.close();
  }
}
