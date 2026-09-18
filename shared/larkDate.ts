/**
 * Epoch milliseconds for a date as Lark renders it, or null when the text is not one.
 *
 * The same Base yields several shapes, because each column carries its own display format and the CLI returns the
 * rendered text: `YYYY/MM/DD HH:mm` (Issue Tracker's Reported Date), `DD/MM/YYYY` (Merchant Feedback's), and ISO
 * from formula columns. Anything else falls back to Date.parse, then to null, so callers can sort around it.
 */
export function larkDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = value.trim();
  const ymd = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
  if (ymd) return Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]), Number(ymd[4] ?? 0), Number(ymd[5] ?? 0));
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
  if (dmy) return Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), Number(dmy[4] ?? 0), Number(dmy[5] ?? 0));
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Newest first; records with no readable date sink to the bottom. */
export const byNewestDate = (a: string | null | undefined, b: string | null | undefined): number =>
  (larkDateMs(b) ?? Number.NEGATIVE_INFINITY) - (larkDateMs(a) ?? Number.NEGATIVE_INFINITY);
