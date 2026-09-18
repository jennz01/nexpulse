import { useState } from 'react';
import { byNewestDate } from '../../../shared/larkDate';
import type { Event, LarkRecord, LarkSnapshot, PublicConfig } from '../../../shared/types';
import { attachmentUrl } from '../api';
import { unreadItems } from '../state';
import { TONE_TAG, categoryClass, feedbackStatusTone, groupFeedback, shortCategory, shortDate } from './larkFormat';
import { RecordDialog } from './RecordDialog';
import { RecordRow } from './RecordRow';

interface Props { snapshot: LarkSnapshot | null; events: Event[]; onSee: (ids: number[]) => void; config: PublicConfig }

export function Feedback({ snapshot, events, onSee, config }: Props) {
  const [open, setOpen] = useState<LarkRecord | null>(null);
  if (!snapshot) return <div className="note">Waiting for the first Lark poll…</div>;
  const unread = unreadItems(events, 'feedback');
  if (snapshot.feedback.records.length === 0) return <div className="note">No feedback in your view.</div>;
  const groups = groupFeedback(snapshot.feedback.records, config.feedbackGroupOrder);
  const show = (r: LarkRecord, ids: number[]) => { if (ids.length) onSee(ids); setOpen(r); };
  return (
    <>
      <div className="rows" role="list">
        {groups.map((g) => (
          <div key={g.status || '(none)'}>
            <div className="group"><i className={`dot ${feedbackStatusTone(g.status)}`} />{g.status || 'No R&D status'} <span className="count">{g.records.length}</span></div>
            {[...g.records].sort((a, b) => byNewestDate(a.fields.reportedDate, b.fields.reportedDate)).map((r) => {
              const f = r.fields;
              const ids = unread.get(r.recordId) ?? [];
              return (
                <RecordRow key={r.recordId} id={f.rid || shortDate(f.reportedDate ?? '')} isNew={ids.length > 0} onOpen={() => show(r, ids)}
                  tags={f.category ? <span className={`tag ${categoryClass(f.category)}`} title={f.category}>{shortCategory(f.category)}</span> : undefined}
                  right={f.rid ? shortDate(f.reportedDate ?? '') : undefined}
                  text={f.text ?? ''} store={f.store} reporter={f.reportedBy} attachments={r.attachments?.length} />
              );
            })}
          </div>
        ))}
      </div>
      {open && <FeedbackDialog record={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function FeedbackDialog({ record: r, onClose }: { record: LarkRecord; onClose: () => void }) {
  const f = r.fields;
  const id = f.rid || shortDate(f.reportedDate ?? '') || r.recordId;
  return (
    <RecordDialog id={id} label={`Feedback ${id}`} url={r.url} onClose={onClose}
      tags={<>
        {f.category && <span className={`tag ${categoryClass(f.category)}`} title={f.category}>{shortCategory(f.category)}</span>}
        {f.status && <span className={`tag ${TONE_TAG[feedbackStatusTone(f.status)]}`}>{f.status}</span>}
      </>}
      fields={[
        { label: 'Reported', value: f.reportedDate },
        { label: 'Reported by', value: f.reportedBy },
        { label: 'ERP store / email', value: f.store },
        { label: 'Category', value: f.category },
        { label: 'R&D status', value: f.status },
        { label: 'PIC', value: f.pic },
        { label: 'R&D task', value: f.taskLink },
      ]}
      textLabel="Feedback / suggestion" text={f.text ?? ''}
      attachments={r.attachments} attachmentHref={(a) => attachmentUrl('feedback', r.recordId, a)} />
  );
}
