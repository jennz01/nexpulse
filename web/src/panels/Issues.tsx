import { useState } from 'react';
import { parseDays } from '../../../shared/attention';
import type { Event, LarkRecord, LarkSnapshot, PublicConfig } from '../../../shared/types';
import { attachmentUrl } from '../api';
import { unreadItems } from '../state';
import { ageClass, ageLabel, priorityClass, shortDateTime } from './larkFormat';
import { RecordDialog } from './RecordDialog';
import { RecordRow } from './RecordRow';

interface Props { snapshot: LarkSnapshot | null; events: Event[]; onSee: (ids: number[]) => void; config: PublicConfig }

const byOldest = (a: LarkRecord, b: LarkRecord) => (parseDays(b.fields.hoursSince ?? '') ?? 0) - (parseDays(a.fields.hoursSince ?? '') ?? 0);

export function Issues({ snapshot, events, onSee, config }: Props) {
  const [open, setOpen] = useState<LarkRecord | null>(null);
  if (!snapshot) return <div className="note">Waiting for the first Lark poll…</div>;
  const unread = unreadItems(events, 'issues');
  if (snapshot.issues.groups.length === 0) return <div className="note">Nothing open. Every issue is resolved or closed.</div>;
  const first = config.showIssueStatuses[0];
  const show = (r: LarkRecord, ids: number[]) => { if (ids.length) onSee(ids); setOpen(r); };
  return (
    <>
      <div className="rows" role="list">
        {snapshot.issues.groups.map((g) => (
          <div key={g.status}>
            <div className="group"><i className={`dot ${g.status === first ? 'red' : 'amber'}`} />{g.status} <span className="count">{g.records.length}</span></div>
            {[...g.records].sort(byOldest).map((r) => {
              const f = r.fields;
              const ids = unread.get(r.recordId) ?? [];
              const age = f.hoursSince ?? '';
              return (
                <RecordRow key={r.recordId} id={f.ticketId || r.recordId} isNew={ids.length > 0} onOpen={() => show(r, ids)}
                  tags={<>
                    {age && <span className={`tag ${ageClass(age)}`} title={age}>{ageLabel(age)}</span>}
                    {f.priority && <span className={`tag ${priorityClass(f.priority)}`}>{f.priority}</span>}
                  </>}
                  right={f.reportedDate ? shortDateTime(f.reportedDate) : undefined}
                  text={f.description ?? ''} store={f.store} reporter={f.reportedBy} attachments={r.attachments?.length} />
              );
            })}
          </div>
        ))}
      </div>
      {open && <IssueDialog record={open} first={first} onClose={() => setOpen(null)} />}
    </>
  );
}

function IssueDialog({ record: r, first, onClose }: { record: LarkRecord; first: string | undefined; onClose: () => void }) {
  const f = r.fields;
  const age = f.hoursSince ?? '';
  const id = f.ticketId || r.recordId;
  return (
    <RecordDialog id={id} label={`Issue ${id}`} url={r.url} onClose={onClose}
      tags={<>
        {f.status && <span className={`tag ${f.status === first ? 'fail' : 'warn'}`}>{f.status}</span>}
        {f.priority && <span className={`tag ${priorityClass(f.priority)}`}>{f.priority}</span>}
        {age && <span className={`tag ${ageClass(age)}`} title={age}>{ageLabel(age)}</span>}
      </>}
      fields={[
        { label: 'Reported', value: f.reportedDate && age ? `${f.reportedDate} · ${age}` : f.reportedDate },
        { label: 'Reported by', value: f.reportedBy },
        { label: 'ERP store / email', value: f.store },
        { label: 'Tagged PIC', value: f.taggedPic },
        { label: 'Module PIC', value: f.modulePic },
      ]}
      textLabel="Issue description" text={f.description ?? ''}
      attachments={r.attachments} attachmentHref={(a) => attachmentUrl('issues', r.recordId, a)} />
  );
}
