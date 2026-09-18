import type { ReactNode } from 'react';
import { IconPaperclip, IconStore, IconUser } from '../icons';
import { flatText } from './larkFormat';

interface Props {
  id: string;
  /** Tags after the id on the first line (age, priority, category). */
  tags?: ReactNode;
  /** Right-aligned meta on the first line (reported time). */
  right?: ReactNode;
  text: string;
  store?: string;
  reporter?: string;
  attachments?: number;
  isNew: boolean;
  onOpen: () => void;
}

/** A Lark record as a card row: identity line, the text clamped to two lines, then who it came from. */
export function RecordRow({ id, tags, right, text, store, reporter, attachments, isNew, onOpen }: Props) {
  const hasMeta = !!(store || reporter || attachments);
  return (
    <button type="button" role="listitem" className={`irow ${isNew ? 'new' : ''}`} onClick={onOpen}>
      <span className="irow-top">
        <i className={isNew ? 'newdot' : 'nodot'} />
        <span className="mono irow-id">{id}</span>
        {tags}
        {right != null && <span className="meta irow-right">{right}</span>}
      </span>
      <span className="irow-desc">{flatText(text) || '—'}</span>
      {hasMeta && (
        <span className="irow-meta">
          {store && <span className="who" title={store}><IconStore size={13} /><span className="clip">{store}</span></span>}
          {reporter && <span className="who" title={reporter}><IconUser size={13} /><span className="clip">{reporter}</span></span>}
          {attachments ? <span className="who faint" title={`${attachments} attachment${attachments === 1 ? '' : 's'}`}><IconPaperclip size={13} />{attachments}</span> : null}
        </span>
      )}
    </button>
  );
}
