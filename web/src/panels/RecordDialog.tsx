import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { LarkAttachment } from '../../../shared/types';
import { IconClose, IconExternal, IconFile, IconPlay } from '../icons';
import { attachmentKind, formatSize } from './larkFormat';
import { Lightbox } from './Lightbox';
import type { LightboxItem } from './Lightbox';
import { RecordComments } from './RecordComments';

/** `value` is the text and decides whether the row appears at all; `node` renders in its place when the value needs markup. */
export interface DialogField { label: string; value?: string | null; node?: ReactNode }
/** A long-form block under its own heading, for a description or a closing remark. */
export interface DialogText { label: string; text: string }
/** One attachment column. Each keeps its own section and its own viewer set, the way Lark keeps the columns apart. */
export interface DialogFiles { label: string; attachments?: LarkAttachment[] }

interface Props {
  id: string;
  tags?: ReactNode;
  /** Label/value pairs; empty values are skipped. */
  fields: DialogField[];
  /** The first block always shows, with an em dash when it is empty; the rest appear only when they have text. */
  texts: DialogText[];
  files?: DialogFiles[];
  attachmentHref?: (a: LarkAttachment) => string;
  /** A ticket id reads as code; a task's own name does not. */
  idMono?: boolean;
  /** Which record this is, so its Lark comments can be read. */
  table: 'tasks' | 'issues' | 'feedback';
  recordId: string;
  /** The record in Lark. */
  url: string;
  label: string;
  onClose: () => void;
}

/** What the viewer is currently showing: one attachment column, or the images from the record's comments. */
interface Viewer { items: LightboxItem[]; index: number }

const extOf = (name: string): string => /\.([a-z0-9]{1,6})$/i.exec(name)?.[1]?.toUpperCase() ?? 'FILE';

/**
 * Full view of a Lark record: every mapped field, its long-form text, each attachment column, and the record's
 * comment threads. Attachments and comment images all open in the one viewer (images zoom, videos play, PDFs
 * render, other files offer a download), so Escape closes the viewer first, then the dialog.
 */
export function RecordDialog({ id, tags, fields, texts, files, attachmentHref, idMono = true, table, recordId, url, label, onClose }: Props) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (viewer) setViewer(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, viewer]);
  const shown = fields.filter((f) => f.value && f.value.trim());
  const blocks = texts.filter((t, i) => i === 0 || t.text.trim());
  const groups = (attachmentHref ? files ?? [] : [])
    .map((g) => ({
      label: g.label,
      items: (g.attachments ?? []).map((a) => ({ token: a.token, src: attachmentHref!(a), name: a.name, size: a.size, kind: attachmentKind(a.name) })),
    }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dlg wide record" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="dlg-h">
          <div className="dlg-title"><span className={idMono ? 'mono' : 'dlg-name'}>{id}</span>{tags}</div>
          <button className="iconbtn sm" title="Close" onClick={onClose}><IconClose size={14} /></button>
        </div>
        <div className="dlg-body">
          {shown.length > 0 && (
            <div className="kv kv2">
              {shown.map((f) => <Fragment key={f.label}><span className="muted">{f.label}</span><span>{f.node ?? f.value}</span></Fragment>)}
            </div>
          )}
          {blocks.map((t) => (
            <div className="field" key={t.label}>
              <span className="caps">{t.label}</span>
              <div className="record-text">{t.text.trim() || '—'}</div>
            </div>
          ))}
          {groups.map((g, gi) => (
            <div className="field" key={g.label}>
              <span className="caps">{g.label} · {g.items.length}</span>
              <div className="atts">
                {g.items.map((it, i) => (
                  <button key={it.token} type="button" className="att" title={`${it.name} · click to view`} onClick={() => setViewer({ items: g.items, index: i })}>
                    {it.kind === 'image'
                      ? <img className="att-img" src={it.src} alt={it.name} loading="lazy" />
                      : <span className={`att-img ${it.kind}`}>{it.kind === 'video' ? <IconPlay size={22} /> : <IconFile size={22} />}<span>{extOf(it.name)}</span></span>}
                    <span className="att-name"><span className="clip">{it.name}</span><span className="meta">{formatSize(it.size)}</span></span>
                  </button>
                ))}
              </div>
              {gi === groups.length - 1 && (
                <span className="hint">Click to view: images zoom, videos play, PDFs open in the document viewer, other files download. The first open fetches them from Lark.</span>
              )}
            </div>
          ))}
          <RecordComments table={table} recordId={recordId} onView={(shots, index) => setViewer({ items: shots, index })} />
        </div>
        <div className="dlg-f">
          <button className="btn" onClick={onClose}>Close</button>
          <a className="btn primary" href={url} target="_blank" rel="noreferrer"><IconExternal size={12} />Open in Lark</a>
        </div>
      </div>
      {viewer && viewer.items.length > 0 && (
        <Lightbox items={viewer.items} index={Math.min(viewer.index, viewer.items.length - 1)}
          onIndex={(i) => setViewer((v) => (v ? { ...v, index: i } : v))} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}
