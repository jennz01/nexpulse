import { useEffect, useState } from 'react';
import type { LarkComment } from '../../../shared/types';
import { commentImageUrl, fetchRecordComments } from '../api';
import { formatDay, relativeTime } from '../time';
import type { LightboxItem } from './Lightbox';

interface Props {
  table: 'tasks' | 'issues' | 'feedback';
  recordId: string;
  /** Opens the dialog's own viewer, so Escape still closes one layer at a time. */
  onView: (items: LightboxItem[], index: number) => void;
}

interface State { loading: boolean; error: string | null; comments: LarkComment[]; indexing: boolean }
const LOADING: State = { loading: true, error: null, comments: [], indexing: false };

/**
 * The record's comment threads in Lark, read when the dialog opens rather than polled, so they are current at the
 * moment they are shown. Read-only: replying stays in Lark, behind "Open in Lark".
 */
export function RecordComments({ table, recordId, onView }: Props) {
  const [state, setState] = useState<State>(LOADING);
  useEffect(() => {
    let live = true;
    setState(LOADING);
    fetchRecordComments(table, recordId).then(
      (r) => { if (live) setState({ loading: false, error: null, comments: r.comments, indexing: r.indexing }); },
      (e: Error) => { if (live) setState({ loading: false, error: e.message, comments: [], indexing: false }); },
    );
    return () => { live = false; };
  }, [table, recordId]);

  // Every image across the record's comments, in reading order, so the viewer pages through them as one set.
  const items: LightboxItem[] = [];
  const threads = state.comments.map((c) => ({
    id: c.id,
    replies: c.replies.map((r) => ({
      ...r,
      shots: r.images.map((token) => {
        const index = items.length;
        items.push({ src: commentImageUrl(token), name: `Comment image ${index + 1}`, size: 0, kind: 'image' });
        return { token, index };
      }),
    })),
  }));
  const total = threads.reduce((n, t) => n + t.replies.length, 0);
  const now = Date.now();

  return (
    <div className="field">
      <span className="caps">Comments{total > 0 ? ` · ${total}` : ''}</span>
      {state.loading ? (
        <span className="hint">Reading comments from Lark…</span>
      ) : state.error ? (
        <span className="hint">Could not load comments: {state.error}</span>
      ) : total === 0 ? (
        <span className="hint">{state.indexing ? 'Still indexing this Base’s comments — try again in a moment.' : 'No comments on this record.'}</span>
      ) : (
        <div className="cmts">
          {threads.map((t) => (
            <div key={t.id} className="cmt-thread">
              {t.replies.map((r) => (
                <div key={r.id} className="cmt">
                  <div className="cmt-h">
                    <span className="cmt-who">{r.author}</span>
                    {r.createdAt > 0 && <span className="meta" title={formatDay(r.createdAt)}>{relativeTime(r.createdAt, now)}</span>}
                  </div>
                  {r.text && <div className="cmt-text">{r.text}</div>}
                  {r.shots.length > 0 && (
                    <div className="cmt-shots">
                      {r.shots.map((s) => (
                        <button key={s.token} type="button" className="cmt-shot" title="Click to view" onClick={() => onView(items, s.index)}>
                          <img src={commentImageUrl(s.token)} alt="" loading="lazy" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
