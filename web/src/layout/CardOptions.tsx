import { useEffect, useRef } from 'react';
import { IconClose, IconEyeOff } from '../icons';
import { HEIGHT_PRESETS, PANEL_TITLE, ROW_PX, TINTS, TINT_LABEL, WIDTHS, WIDTH_LABEL } from './layout';
import type { CardLayout, CardPatch } from './layout';

interface Props {
  card: CardLayout;
  onPatch: (patch: CardPatch) => void;
  onHide: () => void;
  onClose: () => void;
}

/** The per-card popover in customize mode: width, height, tint and hide. Closes on an outside click or Escape. */
export function CardOptions({ card, onPatch, onHide, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest('[data-pop-toggle]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <div className="pop" ref={ref} role="dialog" aria-label={`${PANEL_TITLE[card.id]} card options`}>
      <div className="pop-h">
        <span>{PANEL_TITLE[card.id]}</span>
        <button className="iconbtn sm" title="Close" onClick={onClose}><IconClose size={14} /></button>
      </div>
      <div className="field">
        <span className="lbl">Width</span>
        <div className="seg" role="radiogroup" aria-label="Width">
          {WIDTHS.map((w) => (
            <button key={w} role="radio" aria-checked={w === card.w} className={w === card.w ? 'on' : ''} onClick={() => onPatch({ w })}>{WIDTH_LABEL[w]}</button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="lbl">Height</span>
        <div className="seg" role="radiogroup" aria-label="Height">
          <button role="radio" aria-checked={card.h === 'auto'} className={card.h === 'auto' ? 'on' : ''} onClick={() => onPatch({ h: 'auto' })}>Auto</button>
          {HEIGHT_PRESETS.map((h) => (
            <button key={h} role="radio" aria-checked={card.h === h} className={card.h === h ? 'on' : ''} onClick={() => onPatch({ h })}>{h}</button>
          ))}
        </div>
        <span className="hint">Rows of {ROW_PX} px. A fixed height scrolls inside the card; Auto follows the content. The corner handle snaps to any row count.</span>
      </div>
      <div className="field">
        <span className="lbl">Colour</span>
        <div className="swatches">
          {TINTS.map((t) => (
            <button key={t} className={`sw ${t === 'none' ? 'none' : ''} ${t === card.tint ? 'on' : ''}`} title={TINT_LABEL[t]} aria-label={TINT_LABEL[t]} aria-pressed={t === card.tint}
              style={t === 'none' ? undefined : { background: `var(--tint-${t}-d)` }} onClick={() => onPatch({ tint: t })} />
          ))}
        </div>
      </div>
      <button className="btn" style={{ justifyContent: 'center' }} onClick={onHide}><IconEyeOff size={14} />Hide from Home</button>
    </div>
  );
}
