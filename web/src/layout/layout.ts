import type { PanelId } from '../../../shared/types';

/** Colour preset for a card: a tinted header band and a faint body wash, each with a light and a dark variant in styles.css. */
export type Tint = 'none' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'teal' | 'pink';
export const TINTS: Tint[] = ['none', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink'];
export const TINT_LABEL: Record<Tint, string> = { none: 'No tint', blue: 'Blue', green: 'Green', amber: 'Amber', red: 'Red', purple: 'Purple', teal: 'Teal', pink: 'Pink' };

/** Card width in columns of the six-column grid: a third, a half, two thirds or the full row. */
export type Width = 2 | 3 | 4 | 6;
export const WIDTHS: Width[] = [2, 3, 4, 6];
export const WIDTH_LABEL: Record<Width, string> = { 2: '⅓', 3: '½', 4: '⅔', 6: 'Full' };
export const COLUMNS = 6;

/** Row unit and gap of the grid in px. Must match `.grid` in styles.css. */
export const ROW_PX = 80;
export const GAP_PX = 20;
export const MIN_ROWS = 2;
export const MAX_ROWS = 14;
export const HEIGHT_PRESETS = [3, 4, 6, 8];

/** 'auto' follows the content; a number is a fixed height in rows with the body scrolling inside. */
export type Height = 'auto' | number;

export interface CardLayout { id: PanelId; w: Width; h: Height; tint: Tint; hidden: boolean }
export type CardPatch = Partial<Omit<CardLayout, 'id'>>;
/** The Home page: every panel exactly once, in display order. Hidden cards keep their place so un-hiding puts them back. */
export interface HomeLayout { version: 1; cards: CardLayout[] }

export const HOME_PANELS: PanelId[] = ['prs', 'tasks', 'issues', 'feedback', 'builds', 'stores'];
export const PANEL_TITLE: Record<PanelId, string> = { prs: 'Pull Requests', tasks: 'Tasks', issues: 'Issues', feedback: 'Merchant Feedback', builds: 'Builds', stores: 'Stores' };

const card = (id: PanelId, hidden = false, w: Width = 3): CardLayout => ({ id, w, h: 'auto', tint: 'none', hidden });
/** Reproduces the original page: four half-width panels; Builds and Stores stay on their own pages. */
export const DEFAULT_LAYOUT: HomeLayout = {
  version: 1,
  cards: [card('prs'), card('tasks'), card('issues'), card('feedback'), card('builds', true, 6), card('stores', true, 6)],
};

const KEY = 'dashboard.layout';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadLayout(storage: StorageLike | null): HomeLayout {
  if (!storage) return DEFAULT_LAYOUT;
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? 'null') as { cards?: unknown } | null;
    if (!raw || !Array.isArray(raw.cards)) return DEFAULT_LAYOUT;
    return normalize(raw.cards);
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(storage: StorageLike | null, layout: HomeLayout): void {
  try { storage?.setItem(KEY, JSON.stringify(layout)); } catch { /* private mode etc. */ }
}

/** Keeps every known panel exactly once (unknown ids dropped, missing ones appended hidden) and clamps each field. */
export function normalize(cards: unknown[]): HomeLayout {
  const out: CardLayout[] = [];
  for (const c of cards) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    const id = r.id as PanelId;
    if (!HOME_PANELS.includes(id) || out.some((x) => x.id === id)) continue;
    const def = DEFAULT_LAYOUT.cards.find((x) => x.id === id)!;
    out.push({
      id,
      w: WIDTHS.includes(r.w as Width) ? (r.w as Width) : def.w,
      h: typeof r.h === 'number' && Number.isFinite(r.h) ? clampRows(r.h) : 'auto',
      tint: TINTS.includes(r.tint as Tint) ? (r.tint as Tint) : 'none',
      hidden: typeof r.hidden === 'boolean' ? r.hidden : def.hidden,
    });
  }
  for (const def of DEFAULT_LAYOUT.cards) if (!out.some((x) => x.id === def.id)) out.push({ ...def, hidden: true });
  return { version: 1, cards: out };
}

export const clampRows = (n: number): number => Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.round(n)));
/** Rows a card must span to show `px` of content without clipping. */
export const rowsForHeight = (px: number): number => Math.max(1, Math.ceil((px + GAP_PX) / (ROW_PX + GAP_PX)));
/** The row count whose height is closest to `px` (resize handle), within the allowed range. */
export const nearestRows = (px: number): number => clampRows((px + GAP_PX) / (ROW_PX + GAP_PX));
export const heightForRows = (rows: number): number => rows * ROW_PX + (rows - 1) * GAP_PX;
/** Pixel width of `w` columns when the grid's content box is `gridPx` wide. */
export const widthForCols = (w: number, gridPx: number): number => {
  const col = (gridPx - GAP_PX * (COLUMNS - 1)) / COLUMNS;
  return w * col + (w - 1) * GAP_PX;
};
export function nearestWidth(px: number, gridPx: number): Width {
  return WIDTHS.reduce((best, w) => (Math.abs(widthForCols(w, gridPx) - px) < Math.abs(widthForCols(best, gridPx) - px) ? w : best));
}

export function updateCard(layout: HomeLayout, id: PanelId, patch: CardPatch): HomeLayout {
  return { ...layout, cards: layout.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

/** Moves `id` to sit just before `target`, or just after it when `after` is set. */
export function moveCard(layout: HomeLayout, id: PanelId, target: PanelId, after: boolean): HomeLayout {
  if (id === target) return layout;
  const moving = layout.cards.find((c) => c.id === id);
  if (!moving) return layout;
  const rest = layout.cards.filter((c) => c.id !== id);
  const i = rest.findIndex((c) => c.id === target);
  if (i === -1) return layout;
  rest.splice(after ? i + 1 : i, 0, moving);
  return { ...layout, cards: rest };
}

export function moveCardToEnd(layout: HomeLayout, id: PanelId): HomeLayout {
  const moving = layout.cards.find((c) => c.id === id);
  if (!moving) return layout;
  return { ...layout, cards: [...layout.cards.filter((c) => c.id !== id), moving] };
}

export const isOnHome = (layout: HomeLayout, id: PanelId): boolean => layout.cards.some((c) => c.id === id && !c.hidden);
export const isDefaultLayout = (layout: HomeLayout): boolean => JSON.stringify(layout) === JSON.stringify(DEFAULT_LAYOUT);
