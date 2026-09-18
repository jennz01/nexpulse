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

  close(): void {
    this.db.close();
  }
}
