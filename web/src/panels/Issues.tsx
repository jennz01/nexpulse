import { useState } from 'react';
import { parseDays } from '../../../shared/attention';
import { larkDateMs } from '../../../shared/larkDate';
import type { Event, LarkRecord, LarkSnapshot, PublicConfig } from '../../../shared/types';
import { attachmentUrl } from '../api';
import { IconChevronDown, IconChevronRight } from '../icons';
import { unreadItems } from '../state';
import { ageClass, ageLabel, priorityClass, shortDateTime } from './larkFormat';
import { RecordDialog } from './RecordDialog';
import { RecordRow } from './RecordRow';

interface Props { snapshot: LarkSnapshot | null; events: Event[]; onSee: (ids: number[]) => void; config: PublicConfig }

/** Days since the report. "Hours Since" is Lark's formula off the reported date, so it is preferred; the date column is the fallback when the formula is absent. */
const ageDays = (r: LarkRecord): number => {
  const days = parseDays(r.fields.hoursSince ?? '');
  if (days != null) return days;
  const reported = larkDateMs(r.fields.reportedDate);
  return reported == null ? Number.POSITIVE_INFINITY : (Date.now() - reported) / 86_400_000;
};
/** Newest report on top within each status group. */
const byNewest = (a: LarkRecord, b: LarkRecord) => ageDays(a) - ageDays(b);

export function Issues({ snapshot, events, onSee, config }: Props) {
  const [open, setOpen] = useState<LarkRecord | null>(null);
  /** Per-group overrides; a status the user has not touched follows the default below. */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  if (!snapshot) return <div className="note">Waiting for the first Lark poll…</div>;
  const unread = unreadItems(events, 'issues');
  if (snapshot.issues.groups.length === 0) return <div className="note">No issues in this view.</div>;
  const first = config.showIssueStatuses[0];
  // Finished work folds away by default, whatever the view calls it; anything still in flight stays open.
  const isDone = (status: string) => /resolv|close|done|complete|cancel|reject|kiv/i.test(status);
  const tone = (status: string) => (status === first ? 'red' : isDone(status) ? 'grey' : 'amber');
  const show = (r: LarkRecord, ids: number[]) => { if (ids.length) onSee(ids); setOpen(r); };
  return (
    <>
      <div className="rows" role="list">
        {snapshot.issues.groups.map((g) => {
          const isCollapsed = toggled[g.status] ?? isDone(g.status);
          return (
          <div key={g.status}>
            <button className="group" onClick={() => setToggled((c) => ({ ...c, [g.status]: !isCollapsed }))} aria-expanded={!isCollapsed}>
              {isCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
              <i className={`dot ${tone(g.status)}`} />{g.status} <span className="count">{g.records.length}</span>
              {isCollapsed && <span className="right">collapsed</span>}
            </button>
            {!isCollapsed && [...g.records].sort(byNewest).map((r) => {
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
          );
        })}
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
    <RecordDialog id={id} label={`Issue ${id}`} url={r.url} onClose={onClose} table="issues" recordId={r.recordId}
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
      texts={[
        { label: 'Issue description', text: f.description ?? '' },
        { label: 'Resolved / closed remark', text: f.resolvedRemark ?? '' },
      ]}
      files={[
        { label: 'Attachments', attachments: r.attachments },
        { label: 'Resolved / closed attachment', attachments: r.resolvedAttachments },
      ]}
      attachmentHref={(a) => attachmentUrl('issues', r.recordId, a)} />
  );
}
