import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { LarkAttachment } from '../../../shared/types';
import { IconClose, IconExternal, IconFile, IconPlay } from '../icons';
import { attachmentKind, formatSize } from './larkFormat';
import { Lightbox } from './Lightbox';

export interface DialogField { label: string; value?: string | null }

interface Props {
  id: string;
  tags?: ReactNode;
  /** Label/value pairs; empty values are skipped. */
  fields: DialogField[];
  textLabel: string;
  text: string;
  attachments?: LarkAttachment[];
  attachmentHref?: (a: LarkAttachment) => string;
  /** The record in Lark. */
  url: string;
  label: string;
  onClose: () => void;
}

const extOf = (name: string): string => /\.([a-z0-9]{1,6})$/i.exec(name)?.[1]?.toUpperCase() ?? 'FILE';

/**
 * Full view of a Lark record: every mapped field, the whole text with its line breaks, and the attachments.
 * Every attachment opens in the viewer (images zoom, videos play, PDFs render, other files offer a download);
 * Escape closes the viewer first, then the dialog.
 */
export function RecordDialog({ id, tags, fields, textLabel, text, attachments, attachmentHref, url, label, onClose }: Props) {
  const [viewer, setViewer] = useState<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (viewer != null) setViewer(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, viewer]);
  const shown = fields.filter((f) => f.value && f.value.trim());
  const items = attachmentHref ? (attachments ?? []).map((a) => ({ src: attachmentHref(a), name: a.name, size: a.size, kind: attachmentKind(a.name) })) : [];
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dlg wide record" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="dlg-h">
          <div className="dlg-title"><span className="mono">{id}</span>{tags}</div>
          <button className="iconbtn sm" title="Close" onClick={onClose}><IconClose size={14} /></button>
        </div>
        <div className="dlg-body">
          {shown.length > 0 && (
            <div className="kv kv2">
              {shown.map((f) => <Fragment key={f.label}><span className="muted">{f.label}</span><span>{f.value}</span></Fragment>)}
            </div>
          )}
          <div className="field">
            <span className="caps">{textLabel}</span>
            <div className="record-text">{text.trim() || '—'}</div>
          </div>
          {items.length > 0 && (
            <div className="field">
              <span className="caps">Attachments · {items.length}</span>
              <div className="atts">
                {items.map((it, i) => (
                  <button key={attachments![i]!.token} type="button" className="att" title={`${it.name} · click to view`} onClick={() => setViewer(i)}>
                    {it.kind === 'image'
                      ? <img className="att-img" src={it.src} alt={it.name} loading="lazy" />
                      : <span className={`att-img ${it.kind}`}>{it.kind === 'video' ? <IconPlay size={22} /> : <IconFile size={22} />}<span>{extOf(it.name)}</span></span>}
                    <span className="att-name"><span className="clip">{it.name}</span><span className="meta">{formatSize(it.size)}</span></span>
                  </button>
                ))}
              </div>
              <span className="hint">Click to view: images zoom, videos play, PDFs open in the document viewer, other files download. The first open fetches them from Lark.</span>
            </div>
          )}
        </div>
        <div className="dlg-f">
          <button className="btn" onClick={onClose}>Close</button>
          <a className="btn primary" href={url} target="_blank" rel="noreferrer"><IconExternal size={12} />Open in Lark</a>
        </div>
      </div>
      {viewer != null && items.length > 0 && (
        <Lightbox items={items} index={Math.min(viewer, items.length - 1)} onIndex={setViewer} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}
