import type { LarkRecord } from '../../../shared/types';

/** A search box query as lowercase words; no words means no filter. */
export const queryWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * True when every word appears somewhere in the named fields, in any order and anywhere inside a field, so "login crash"
 * finds "App crashes on login". Fields are joined by newlines so a word cannot match across the seam of two fields.
 */
export function matchesWords(r: LarkRecord, words: string[], keys: readonly string[]): boolean {
  if (words.length === 0) return true;
  const hay = keys.map((k) => r.fields[k] ?? '').join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}
