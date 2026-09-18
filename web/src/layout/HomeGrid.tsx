import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { PanelId } from '../../../shared/types';
import { IconCheck, IconEyeOff, IconGrip, IconPalette, IconPlus, IconResize } from '../icons';
import type { PageContext } from '../pages/context';
import { renderCard } from '../panels/cards';
import type { CardChrome } from '../panels/cards';
import { CardOptions } from './CardOptions';
import { PANEL_TITLE, WIDTH_LABEL, heightForRows, moveCard, moveCardToEnd, nearestRows, nearestWidth, rowsForHeight, updateCard, widthForCols } from './layout';
import type { CardLayout, CardPatch, Height } from './layout';

type Drop = { id: PanelId; after: boolean } | null;

/**
 * The Home page grid: six columns, 80 px rows, dense packing. Each visible card spans its saved width and either
 * its fixed rows or the rows its content needs. In customize mode cards can be dragged to reorder, resized from the
 * corner, tinted and hidden; hidden cards wait in the tray below.
 */
export function HomeGrid({ ctx }: { ctx: PageContext }) {
  const { layout, setLayout, customizing } = ctx;
  const gridRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState<PanelId | null>(null);
  const [drag, setDrag] = useState<PanelId | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  useEffect(() => { if (!customizing) { setOpen(null); setDrag(null); setDrop(null); } }, [customizing]);

  const endDrag = () => { setDrag(null); setDrop(null); };
  // Dropping on the grid's own background (not on a card) sends the card to the end.
  const onGridDragOver = (e: DragEvent<HTMLElement>) => {
    if (!drag || e.target !== e.currentTarget) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (drop) setDrop(null);
  };
  const onGridDrop = (e: DragEvent<HTMLElement>) => {
    if (!drag || e.target !== e.currentTarget) return;
    e.preventDefault();
    const id = drag;
    setLayout((l) => moveCardToEnd(l, id));
    endDrag();
  };

  const visible = layout.cards.filter((c) => !c.hidden);
  return (
    <>
      {customizing && (
        <div className="tray" role="group" aria-label="Panels on Home">
          <span className="tray-label">Panels</span>
          {layout.cards.map((c) => (
            <button key={c.id} className={`chip ${c.hidden ? 'off' : 'on'}`} aria-pressed={!c.hidden}
              title={c.hidden ? `Show ${PANEL_TITLE[c.id]} on Home` : `Hide ${PANEL_TITLE[c.id]} from Home`}
              onClick={() => { setLayout((l) => updateCard(l, c.id, { hidden: !c.hidden })); if (!c.hidden) setOpen((o) => (o === c.id ? null : o)); }}>
              {c.hidden ? <IconPlus size={14} /> : <IconCheck size={14} />}{PANEL_TITLE[c.id]}
            </button>
          ))}
          <span className="hint">Click a panel to show or hide it on Home. Hidden panels keep their own page.</span>
        </div>
      )}
      <main className="grid" ref={gridRef} onDragOver={onGridDragOver} onDrop={onGridDrop}>
        {visible.map((card) => (
          <GridCard key={card.id} ctx={ctx} card={card} customizing={customizing} gridRef={gridRef}
            open={open === card.id} onToggleOpen={() => setOpen((o) => (o === card.id ? null : card.id))} onClose={() => setOpen(null)}
            dragging={drag === card.id} drop={drop?.id === card.id ? drop.after : null}
            onDragStart={() => setDrag(card.id)}
            onDragOverCard={(after) => {
              if (!drag || drag === card.id) return false;
              if (!drop || drop.id !== card.id || drop.after !== after) setDrop({ id: card.id, after });
              return true;
            }}
            onDropCard={(after) => {
              const id = drag;
              if (id && id !== card.id) setLayout((l) => moveCard(l, id, card.id, after));
              endDrag();
            }}
            onDragEnd={endDrag}
            onPatch={(p) => setLayout((l) => updateCard(l, card.id, p))} />
        ))}
      </main>
    </>
  );
}

interface CardProps {
  ctx: PageContext;
  card: CardLayout;
  customizing: boolean;
  gridRef: RefObject<HTMLElement | null>;
  open: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  dragging: boolean;
  /** null: not a drop target; false: the dragged card lands before this one; true: after it. */
  drop: boolean | null;
  onDragStart: () => void;
  /** Returns whether this card accepts the drop (false while nothing, or itself, is being dragged). */
  onDragOverCard: (after: boolean) => boolean;
  onDropCard: (after: boolean) => void;
  onDragEnd: () => void;
  onPatch: (patch: CardPatch) => void;
}

interface ResizeStart { x0: number; y0: number; w0: number; rows0: number; h0: number; gridPx: number; touchedH: boolean }

function GridCard(p: CardProps) {
  const { card, customizing } = p;
  const innerRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(1);
  const [resizing, setResizing] = useState(false);
  const rs = useRef<ResizeStart | null>(null);

  // Auto height: the inner column keeps its natural height, so measuring it never depends on the span it produces.
  useLayoutEffect(() => {
    if (card.h !== 'auto') return;
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setMeasured(rowsForHeight(el.getBoundingClientRect().height + 2)); // + the card's top and bottom border
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [card.h]);

  const rows = card.h === 'auto' ? measured : card.h;
  const style = { gridColumn: `span ${card.w}`, gridRow: `span ${rows}` };

  /** Past the diagonal from top-left to bottom-right counts as "after", which reads right in rows and in a single column. */
  const isAfter = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return (e.clientX - r.left) / r.width + (e.clientY - r.top) / r.height > 1;
  };

  const onResizeDown = (e: ReactPointerEvent<HTMLElement>) => {
    const grid = p.gridRef.current;
    if (!grid) return;
    e.preventDefault();
    e.stopPropagation();
    const cs = getComputedStyle(grid);
    const gridPx = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    rs.current = { x0: e.clientX, y0: e.clientY, w0: widthForCols(card.w, gridPx), rows0: rows, h0: heightForRows(rows), gridPx, touchedH: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    setResizing(true);
  };
  const onResizeMove = (e: ReactPointerEvent<HTMLElement>) => {
    const s = rs.current;
    if (!s) return;
    const w = nearestWidth(s.w0 + e.clientX - s.x0, s.gridPx);
    const rowsNow = nearestRows(s.h0 + e.clientY - s.y0);
    if (rowsNow !== s.rows0) s.touchedH = true;
    // A purely sideways drag keeps an auto height; crossing a row boundary pins it.
    const h: Height = card.h === 'auto' && !s.touchedH ? 'auto' : rowsNow;
    if (w !== card.w || h !== card.h) p.onPatch({ w, h });
  };
  const onResizeUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (!rs.current) return;
    rs.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setResizing(false);
  };

  const hide = () => { p.onPatch({ hidden: true }); p.onClose(); };

  const chrome: CardChrome = customizing
    ? {
        leading: <span className="grip" aria-hidden="true"><IconGrip size={16} /></span>,
        tools: (
          <>
            <span className="meta mono">{WIDTH_LABEL[card.w]} · {card.h === 'auto' ? 'auto' : `${card.h} rows`}</span>
            <button className={`iconbtn sm ${p.open ? 'on' : ''}`} title="Colour and size" aria-expanded={p.open} data-pop-toggle="true" onClick={p.onToggleOpen}><IconPalette size={14} /></button>
            <button className="iconbtn sm" title="Hide from Home" onClick={hide}><IconEyeOff size={14} /></button>
          </>
        ),
        extra: (
          <>
            {resizing && <span className="sizepill">{WIDTH_LABEL[card.w]} × {rows} rows</span>}
            <span className="rz" title="Drag to resize" draggable={false} onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} onPointerCancel={onResizeUp}><IconResize size={14} /></span>
            {p.open && <CardOptions card={card} onPatch={p.onPatch} onHide={hide} onClose={p.onClose} />}
          </>
        ),
        sectionProps: {
          draggable: true,
          onDragStart: (e: DragEvent<HTMLElement>) => {
            if ((e.target as HTMLElement).closest('button, a, .rz, .pop')) { e.preventDefault(); return; }
            e.dataTransfer.setData('text/plain', card.id);
            e.dataTransfer.effectAllowed = 'move';
            p.onDragStart();
          },
          onDragOver: (e: DragEvent<HTMLElement>) => {
            if (p.onDragOverCard(isAfter(e))) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
          },
          onDrop: (e: DragEvent<HTMLElement>) => { e.preventDefault(); p.onDropCard(isAfter(e)); },
          onDragEnd: p.onDragEnd,
        },
        className: [p.dragging ? 'dragging' : '', p.drop === false ? 'drop-before' : p.drop === true ? 'drop-after' : '', resizing ? 'resizing' : ''].filter(Boolean).join(' '),
      }
    : {};

  return renderCard(card.id, p.ctx, { ...chrome, tint: card.tint, fill: card.h !== 'auto', innerRef, style });
}
