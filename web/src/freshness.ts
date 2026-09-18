import type { SourceState, Tone } from '../../shared/types';
import { relativeTime } from './time';

export type FreshTone = Tone | 'green';

/** Header dot and panel label: green within 2× the interval, amber when older, red on error, grey when off or not yet fetched (spec §4.1). */
export function freshness(state: SourceState, intervalSec: number, now: number): { tone: FreshTone; label: string } {
  if (state.disabled) return { tone: 'grey', label: 'off' };
  if (state.error) return { tone: 'red', label: 'error' };
  if (state.fetchedAt == null) return { tone: 'grey', label: 'waiting' };
  const age = Math.max(0, now - state.fetchedAt); // a poll can land after the 30 s "now" sample; never show a negative age
  if (age > 2 * intervalSec * 1000) return { tone: 'amber', label: `stale ${relativeTime(state.fetchedAt, now)}` };
  return { tone: 'green', label: age < 60_000 ? `${Math.floor(age / 1000)} s` : relativeTime(state.fetchedAt, now) };
}
