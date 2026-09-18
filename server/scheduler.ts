import type { NewEvent, SourceId, SseMessage } from '../shared/types';
import type { Store } from './store';
import { describeError } from './sources/types';
import type { RegisteredSource, Source } from './sources/types';

export interface SchedulerOptions {
  now?: () => number;
  maxBackoffSec?: number;
  log?: (line: string) => void;
}
export interface SourceStatus {
  nextRunAt: number | null;
  inflight: boolean;
  consecutiveFailures: number;
  disabled: string | null;
}

export function backoffDelaySec(intervalSec: number, consecutiveFailures: number, maxSec: number): number {
  return Math.min(intervalSec * 2 ** consecutiveFailures, maxSec);
}

export function chooseDelaySec<S>(source: Source<S, unknown>, snapshot: S, intervalSec: number): number {
  const fast = source.fastIntervalSec?.(snapshot) ?? null;
  return fast ?? intervalSec;
}

export class Scheduler {
  private timers = new Map<SourceId, ReturnType<typeof setTimeout>>();
  private failures = new Map<SourceId, number>();
  private inflight = new Set<SourceId>();
  private nextRunAt = new Map<SourceId, number>();
  private started = false;
  private readonly now: () => number;
  private readonly maxBackoffSec: number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly sources: RegisteredSource[],
    private readonly store: Store,
    private readonly onUpdate: (msg: SseMessage) => void,
    opts: SchedulerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.maxBackoffSec = opts.maxBackoffSec ?? 600;
    this.log = opts.log ?? (() => {});
  }

  /** Begin polling. Until this is called, tick() runs once and schedules nothing (handy for tests and `bun run check`). */
  start(): void {
    this.started = true;
    for (const reg of this.sources) if (!reg.disabled) this.schedule(reg.source.id, 0);
  }

  stop(): void {
    this.started = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.nextRunAt.clear();
  }

  status(): Record<SourceId, SourceStatus> {
    const out = {} as Record<SourceId, SourceStatus>;
    for (const reg of this.sources) {
      const id = reg.source.id;
      out[id] = {
        nextRunAt: this.nextRunAt.get(id) ?? null,
        inflight: this.inflight.has(id),
        consecutiveFailures: this.failures.get(id) ?? 0,
        disabled: reg.disabled,
      };
    }
    return out;
  }

  /** Poll one source now, resetting its backoff. */
  async refresh(id: SourceId): Promise<void> {
    this.failures.set(id, 0);
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    await this.tick(id);
  }

  /** Swap a source's registration (new config, or switched on/off) and, when polling, fetch it right away. */
  replace(reg: RegisteredSource): void {
    const id = reg.source.id;
    const i = this.sources.findIndex((r) => r.source.id === id);
    if (i === -1) this.sources.push(reg);
    else this.sources[i] = reg;
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.nextRunAt.delete(id);
    this.failures.set(id, 0);
    if (!reg.disabled) this.schedule(id, 0);
  }

  async tick(id: SourceId): Promise<void> {
    const reg = this.sources.find((r) => r.source.id === id);
    if (!reg || reg.disabled || this.inflight.has(id)) return;
    this.inflight.add(id);
    const startedAt = this.now();
    try {
      const prev = this.store.getSnapshot(id);
      const next: unknown = await reg.source.fetch(reg.ctx);
      const fetchedAt = this.now();
      this.store.saveSnapshot(id, next, fetchedAt);
      const fresh: NewEvent[] = prev?.data == null ? [] : reg.source.diff(prev.data, next);
      const events = this.store.addEvents(fresh, fetchedAt);
      this.failures.set(id, 0);
      const delaySec = chooseDelaySec(reg.source, next, reg.intervalSec);
      this.log(`${id}: ok in ${fetchedAt - startedAt} ms, ${events.length} event(s), next in ${delaySec} s`);
      this.onUpdate({ source: id, state: { snapshot: next, fetchedAt, error: null, errorAt: null, disabled: null }, events });
      this.schedule(id, delaySec * 1000);
    } catch (err) {
      const message = describeError(err);
      const errorAt = this.now();
      this.store.saveError(id, message, errorAt);
      const n = (this.failures.get(id) ?? 0) + 1;
      this.failures.set(id, n);
      const delaySec = backoffDelaySec(reg.intervalSec, n, this.maxBackoffSec);
      this.log(`${id}: FAILED ${message}; retry in ${delaySec} s`);
      const row = this.store.getSnapshot(id);
      this.onUpdate({
        source: id,
        state: { snapshot: row?.data ?? null, fetchedAt: row?.fetchedAt ?? null, error: message, errorAt, disabled: null },
        events: [],
      });
      this.schedule(id, delaySec * 1000);
    } finally {
      this.inflight.delete(id);
    }
  }

  private schedule(id: SourceId, delayMs: number): void {
    if (!this.started) return;
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    this.nextRunAt.set(id, this.now() + delayMs);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.tick(id);
    }, delayMs);
    this.timers.set(id, timer);
  }
}
