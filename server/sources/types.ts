import type { NewEvent, SourceId } from '../../shared/types';
import type { RunOptions, RunResult } from '../proc';

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Everything a source may touch. Sources never import the store or the SSE hub. */
export interface SourceContext<C> {
  config: C;
  run: Runner;
  fetch: typeof fetch;
  log: (message: string) => void;
  now: () => number;
}

export interface Source<S, C> {
  id: SourceId;
  defaultIntervalSec: number;
  /**
   * Talk to the outside world and return a normalised snapshot. Throw SourceError on failure.
   * `previous` is the last stored snapshot, for sources that can avoid re-reading what cannot have changed since.
   * `force` marks a poll the user asked for, where any such shortcut should be given up and everything re-read.
   */
  fetch(ctx: SourceContext<C>, previous: S | null, force: boolean): Promise<S>;
  /** What changed and matters. Must return [] when prev is null. */
  diff(prev: S | null, next: S): NewEvent[];
  /** Optional shorter interval while something is in flight (Codemagic builds). */
  fastIntervalSec?(snapshot: S): number | null;
}

export interface RegisteredSource {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry; each source is typed at its definition
  source: Source<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: SourceContext<any>;
  intervalSec: number;
  disabled: string | null;
}

/** A failure with an optional human hint, e.g. "run `gh auth login`". */
export class SourceError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'SourceError';
  }
}

export function describeError(err: unknown): string {
  if (err instanceof SourceError) return err.hint ? `${err.message} (${err.hint})` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
