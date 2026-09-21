import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { IconChevronLeft, IconChevronRight, IconClose, IconDownload, IconExternal, IconFile, IconMaximize, IconPlay, IconZoomIn, IconZoomOut } from '../icons';
import { formatSize } from './larkFormat';
import type { AttachmentKind } from './larkFormat';

/** `size` is 0 when it is not known, as for an image pasted into a comment; the viewer then shows no size. */
export interface LightboxItem { src: string; name: string; size: number; kind: AttachmentKind }

interface Props {
  items: LightboxItem[];
  index: number;
  onIndex: (i: number) => void;
  /** Escape is the host's job, so nested layers close one at a time; the close button and a click beside the media call this. */
  onClose: () => void;
}

const MIN = 1;
const MAX = 8;
const STEP = 1.25;
interface View { scale: number; x: number; y: number }
const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * Full-screen viewer for a record's attachments. Arrows, ←/→ and the thumbnail strip move between items. Images
 * zoom about the cursor with the wheel, +/− and double-click, and pan by dragging; videos use the browser's player;
 * PDFs render in the browser's document viewer; anything else shows a download card.
 */
export function Lightbox({ items, index, onIndex, onClose }: Props) {
  const item = items[index] ?? items[0]!;
  const count = items.length;
  const isImage = item.kind === 'image';
  const [view, setView] = useState<View>(FIT);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; y0: number; vx: number; vy: number } | null>(null);
  const go = (d: number) => { if (count > 1) onIndex((index + d + count) % count); };

  useEffect(() => { setView(FIT); setLoaded(false); setFailed(false); }, [item.src]);

  /** Zooms by `factor` about a point given relative to the stage centre, so that point stays put on screen. */
  const zoomAt = (factor: number, cx = 0, cy = 0) => setView((v) => {
    const scale = Math.min(MAX, Math.max(MIN, v.scale * factor));
    if (scale === v.scale) return v;
    if (scale === MIN) return FIT;
    const k = scale / v.scale;
    return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
  });
  const pointFrom = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { cx: e.clientX - (r.left + r.width / 2), cy: e.clientY - (r.top + r.height / 2) };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A focused video player owns the arrow keys (seek) and space; a PDF frame never sends keys up here.
      if ((e.target as HTMLElement | null)?.closest?.('video')) return;
      if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (isImage && (e.key === '+' || e.key === '=')) zoomAt(STEP);
      else if (isImage && e.key === '-') zoomAt(1 / STEP);
      else if (isImage && e.key === '0') setView(FIT);
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, count, isImage]);

  // Wheel zoom needs a non-passive listener, otherwise the page behind the viewer scrolls too.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !isImage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { cx, cy } = pointFrom(e);
      zoomAt(e.deltaY < 0 ? STEP : 1 / STEP, cx, cy);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isImage]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // The prev/next arrows sit inside the stage: a pan must not start on them, or pointer capture eats their click.
    if (!isImage || view.scale === MIN || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    drag.current = { x0: e.clientX, y0: e.clientY, vx: view.x, vy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + e.clientX - d.x0, y: d.vy + e.clientY - d.y0 }));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!isImage) return;
    if (view.scale > MIN) { setView(FIT); return; }
    const { cx, cy } = pointFrom(e);
    zoomAt(2.5, cx, cy);
  };

  const media = (() => {
    switch (item.kind) {
      case 'image':
        return (
          <img key={item.src} className="lb-img" src={item.src} alt={item.name} draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, opacity: loaded ? 1 : 0 }} />
        );
      case 'video':
        return (
          // eslint-disable-next-line jsx-a11y/media-has-caption -- merchant screen recordings carry no captions
          <video key={item.src} className="lb-video" src={item.src} controls preload="metadata" onLoadedMetadata={() => setLoaded(true)} onError={() => setFailed(true)} />
        );
      case 'pdf':
        return <iframe key={item.src} className="lb-frame" src={item.src} title={item.name} onLoad={() => setLoaded(true)} />;
      default:
        return (
          <span className="lb-file">
            <IconFile size={36} />
            <span className="lb-file-name">{item.name}</span>
            <span className="lb-meta mono">{formatSize(item.size)}</span>
            <a className="btn primary" href={item.src} download={item.name}><IconDownload size={12} />Download</a>
          </span>
        );
    }
  })();

  return (
    // Clicks must not bubble to the host dialog's backdrop, which would close the dialog under the viewer.
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${item.name}, ${index + 1} of ${count}`} onClick={(e) => e.stopPropagation()}>
      <div className="lb-top">
        <span className="lb-name clip" title={item.name}>{item.name}</span>
        <span className="lb-meta mono">{item.size > 0 ? formatSize(item.size) : ''}{count > 1 ? `${item.size > 0 ? ' · ' : ''}${index + 1} / ${count}` : ''}</span>
        {isImage && (
          <span className="lb-zoom">
            <button className="lb-btn" title="Zoom out (−)" onClick={() => zoomAt(1 / STEP)} disabled={view.scale <= MIN}><IconZoomOut size={16} /></button>
            <span className="mono lb-pct">{Math.round(view.scale * 100)}%</span>
            <button className="lb-btn" title="Zoom in (+)" onClick={() => zoomAt(STEP)} disabled={view.scale >= MAX}><IconZoomIn size={16} /></button>
            <button className="lb-btn" title="Fit to screen (0)" onClick={() => setView(FIT)} disabled={view.scale === MIN}><IconMaximize size={16} /></button>
          </span>
        )}
        <a className="lb-btn" href={item.src} target="_blank" rel="noreferrer" title="Open in a new tab"><IconExternal size={16} /></a>
        <a className="lb-btn" href={item.src} download={item.name} title="Download"><IconDownload size={16} /></a>
        <button className="lb-btn" title="Close (Esc)" onClick={onClose}><IconClose size={16} /></button>
      </div>
      <div ref={stageRef} className={`lb-stage ${isImage && view.scale > MIN ? 'zoomed' : ''} ${dragging ? 'dragging' : ''}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={onDoubleClick}
        onClick={(e) => { if (e.target === e.currentTarget && view.scale === MIN) onClose(); }}>
        {!loaded && !failed && item.kind !== 'file' && <span className="lb-status">Loading…</span>}
        {failed && (
          <span className="lb-status">
            {item.kind === 'video' ? 'The browser cannot play this video.' : 'Could not load this file.'} <a href={item.src} target="_blank" rel="noreferrer">Open it directly</a> or <a href={item.src} download={item.name}>download it</a>.
          </span>
        )}
        {!failed && media}
        {count > 1 && (
          <>
            <button className="lb-nav prev" title="Previous (←)" onClick={(e) => { e.stopPropagation(); go(-1); }}><IconChevronLeft size={22} /></button>
            <button className="lb-nav next" title="Next (→)" onClick={(e) => { e.stopPropagation(); go(1); }}><IconChevronRight size={22} /></button>
          </>
        )}
      </div>
      {count > 1 && (
        <div className="lb-thumbs">
          {items.map((it, i) => (
            <button key={it.src} className={`lb-thumb ${i === index ? 'on' : ''} ${it.kind === 'image' ? '' : 'icon'}`} title={it.name} onClick={() => onIndex(i)}>
              {it.kind === 'image' ? <img src={it.src} alt="" loading="lazy" /> : it.kind === 'video' ? <IconPlay size={16} /> : <span className="lb-thumb-ext">{extOf(it.name)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const extOf = (name: string): string => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase() ?? 'FILE';
