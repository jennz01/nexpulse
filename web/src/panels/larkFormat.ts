import { parseDays } from '../../../shared/attention';
import type { LarkRecord } from '../../../shared/types';

export function progressPercent(v: string): number | null {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n <= 1 ? n * 100 : n)));
}

export function ageClass(hoursSince: string): 'fail' | 'warn' | 'plain' {
  const d = parseDays(hoursSince);
  if (d == null) return 'plain';
  return d > 3 ? 'fail' : d > 1 ? 'warn' : 'plain';
}
export function ageLabel(hoursSince: string): string {
  const d = parseDays(hoursSince);
  return d == null ? hoursSince : `${Math.round(d * 10) / 10} d`;
}

export function typeClass(type: string): 'feature' | 'chore' | 'qe' | 'plain' {
  const t = type.trim().toLowerCase();
  return t === 'feature' || t === 'chore' || t === 'qe' ? t : 'plain';
}
export function priorityClass(priority: string): 'high' | 'normal' | 'plain' {
  const p = priority.trim().toLowerCase();
  return p === 'high' ? 'high' : p === 'normal' ? 'normal' : 'plain';
}

export function shortCategory(category: string): string {
  const parts = category.split('>').map((s) => s.trim()).filter(Boolean);
  return (parts.length >= 3 ? parts.slice(1) : parts).join(' · ');
}
export function categoryClass(category: string): 'qe' | 'feature' | 'warn' | 'plain' {
  const c = category.toUpperCase();
  if (c.includes('NEW REQUEST')) return 'qe';
  if (c.includes('SGPOS')) return 'feature';
  if (c.includes('SHOPPING APP')) return 'warn';
  return 'plain';
}

export function shortDate(value: string): string {
  const dmy = /^(\d{2})\/(\d{2})\/\d{4}$/.exec(value);
  if (dmy) return `${dmy[1]}/${dmy[2]}`;
  const ymd = /^\d{4}\/(\d{2})\/(\d{2})/.exec(value);
  if (ymd) return `${ymd[2]}/${ymd[1]}`;
  return value;
}

/** First non-empty line of a multi-line cell, trimmed; '' for empty input. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';
}

/** Collapses line breaks and runs of spaces so a multi-line cell reads as one paragraph inside a line clamp. */
export const flatText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** "2026/09/16 09:22" -> "16/09 09:22"; date-only values go through shortDate. */
export function shortDateTime(value: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})(?: (\d{2}:\d{2}))?/.exec(value);
  if (m) return `${m[3]}/${m[2]}${m[4] ? ` ${m[4]}` : ''}`;
  return shortDate(value);
}

export function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Types the server serves inline (see INLINE_TYPES in server/attachments.ts); SVG is excluded on purpose, it downloads instead. */
export const isImageName = (name: string): boolean => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);

export type AttachmentKind = 'image' | 'video' | 'pdf' | 'file';
/** What the viewer can do with an attachment: images zoom, videos play, PDFs render in the browser viewer, the rest download. */
export function attachmentKind(name: string): AttachmentKind {
  if (isImageName(name)) return 'image';
  if (/\.(mp4|m4v|webm|mov)$/i.test(name)) return 'video';
  if (/\.pdf$/i.test(name)) return 'pdf';
  return 'file';
}

export type FeedbackTone = 'blue' | 'green' | 'amber' | 'grey';
/** Group dot and tag colour for an R&D status: accepted-ish green, waiting-ish amber, closed-ish grey, anything else blue. */
export function feedbackStatusTone(status: string): FeedbackTone {
  const s = status.toUpperCase();
  if (/ACCEPT|DONE|RELEASE|COMPLETE/.test(s)) return 'green';
  if (/KIV|HOLD|PENDING|WAIT/.test(s)) return 'amber';
  if (/DECLIN|CLOSE|REJECT|CANCEL/.test(s)) return 'grey';
  return 'blue';
}
export const TONE_TAG: Record<FeedbackTone, 'normal' | 'ok' | 'warn' | 'plain'> = { blue: 'normal', green: 'ok', amber: 'warn', grey: 'plain' };

/** Groups records by their status field: configured statuses first in that order, then the rest by first appearance. */
export function groupFeedback(records: LarkRecord[], order: string[]): { status: string; records: LarkRecord[] }[] {
  const groups = new Map<string, LarkRecord[]>();
  for (const s of order) groups.set(s, []);
  for (const r of records) {
    const s = r.fields.status ?? '';
    (groups.get(s) ?? groups.set(s, []).get(s)!).push(r);
  }
  return [...groups.entries()].filter(([, rs]) => rs.length > 0).map(([status, rs]) => ({ status, records: rs }));
}
