import { useState } from 'react';
import type { LarkRecord, LarkSnapshot, PublicConfig } from '../../../shared/types';
import { attachmentUrl } from '../api';
import { IconChevronDown, IconChevronRight } from '../icons';
import { dropMidnight, priorityClass, progressPercent, typeClass } from './larkFormat';
import { RecordDialog } from './RecordDialog';

interface Props { snapshot: LarkSnapshot | null; config: PublicConfig }

function Others({ pic }: { pic: string }) {
  const names = pic.split(',').map((s) => s.trim()).filter(Boolean);
  return names.length > 1 ? <span className="meta" title={pic}>+{names.length - 1}</span> : null;
}

function TaskRow({ r, onOpen }: { r: LarkRecord; onOpen: () => void }) {
  const f = r.fields;
  const pct = progressPercent(f.progress ?? '');
  return (
    <button type="button" className="row click" role="listitem" onClick={onOpen}>
      <span className="title" title={f.title}>{f.title}</span>
      <Others pic={f.pic ?? ''} />
      {f.type && <span className={`tag ${typeClass(f.type)}`}>{f.type}</span>}
      {f.priority && <span className={`tag ${priorityClass(f.priority)}`}>{f.priority}</span>}
      {pct != null && <span className="bar" title={`${pct}%`}><i style={{ width: `${pct}%` }} /></span>}
    </button>
  );
}

export function Tasks({ snapshot, config }: Props) {
  const [open, setOpen] = useState<LarkRecord | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => Object.fromEntries(config.collapsedStatuses.map((s) => [s, true])));
  if (!snapshot) return <div className="note">Waiting for the first Lark poll…</div>;
  if (snapshot.tasks.groups.length === 0) return <div className="note">No tasks in your view.</div>;
  const dot = (status: string) => (status === config.pendingLaunchStatus ? 'amber' : config.collapsedStatuses.includes(status) ? 'green' : 'blue');
  return (
    <>
      <div className="rows" role="list">
        {snapshot.tasks.groups.map((g) => {
          const isCollapsed = !!collapsed[g.status];
          return (
            <div key={g.status}>
              <button className="group" onClick={() => setCollapsed((c) => ({ ...c, [g.status]: !isCollapsed }))} aria-expanded={!isCollapsed}>
                {isCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                <i className={`dot ${dot(g.status)}`} />{g.status} <span className="count">{g.records.length}</span>
                {isCollapsed && <span className="right">collapsed</span>}
              </button>
              {!isCollapsed && g.records.map((r) => <TaskRow key={r.recordId} r={r} onOpen={() => setOpen(r)} />)}
            </div>
          );
        })}
      </div>
      {open && <TaskDialog record={open} config={config} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Green once the status is one of the collapsed (finished) ones, amber while it waits to launch, blue in flight. */
const statusTag = (status: string, config: PublicConfig): string =>
  status === config.pendingLaunchStatus ? 'warn' : config.collapsedStatuses.includes(status) ? 'ok' : 'normal';

function TaskDialog({ record: r, config, onClose }: { record: LarkRecord; config: PublicConfig; onClose: () => void }) {
  const f = r.fields;
  const pct = progressPercent(f.progress ?? '');
  // Only a handful of tasks carry an RID, so the task's own name is its identity here; the RID is a field like any other.
  const name = f.title || r.recordId;
  return (
    <RecordDialog id={name} idMono={false} label={`Task ${name}`} url={r.url} onClose={onClose} table="tasks" recordId={r.recordId}
      tags={<>
        {f.status && <span className={`tag ${statusTag(f.status, config)}`}>{f.status}</span>}
        {f.type && <span className={`tag ${typeClass(f.type)}`}>{f.type}</span>}
        {f.priority && <span className={`tag ${priorityClass(f.priority)}`}>{f.priority}</span>}
      </>}
      fields={[
        { label: 'RID', value: f.rid },
        { label: 'PIC', value: f.pic },
        { label: 'Category', value: f.category },
        { label: 'Dev start', value: dropMidnight(f.devStart) },
        { label: 'Dev end', value: dropMidnight(f.devEnd) },
        { label: 'On hold', value: f.onHold },
        { label: 'Deployment', value: f.deployment },
        { label: 'ERP version', value: f.erpVersion },
        { label: 'Server', value: f.server },
        {
          label: 'Progress',
          value: pct == null ? undefined : `${pct}%`,
          node: pct == null ? undefined : <span className="pgr"><span className="bar"><i style={{ width: `${pct}%` }} /></span>{pct}%</span>,
        },
      ]}
      texts={[{ label: 'Description', text: f.description ?? '' }]}
      files={[{ label: 'Attachments', attachments: r.attachments }]}
      attachmentHref={(a) => attachmentUrl('tasks', r.recordId, a)} />
  );
}
