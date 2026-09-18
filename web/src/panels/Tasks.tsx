import { useState } from 'react';
import type { LarkRecord, LarkSnapshot, PublicConfig } from '../../../shared/types';
import { IconChevronDown, IconChevronRight } from '../icons';
import { priorityClass, progressPercent, typeClass } from './larkFormat';

interface Props { snapshot: LarkSnapshot | null; config: PublicConfig }

function Others({ pic }: { pic: string }) {
  const names = pic.split(',').map((s) => s.trim()).filter(Boolean);
  return names.length > 1 ? <span className="meta" title={pic}>+{names.length - 1}</span> : null;
}

function TaskRow({ r }: { r: LarkRecord }) {
  const f = r.fields;
  const pct = progressPercent(f.progress ?? '');
  return (
    <a className="row click" href={r.url} target="_blank" rel="noreferrer" role="listitem">
      <span className="title" title={f.title}>{f.title}</span>
      <Others pic={f.pic ?? ''} />
      {f.type && <span className={`tag ${typeClass(f.type)}`}>{f.type}</span>}
      {f.priority && <span className={`tag ${priorityClass(f.priority)}`}>{f.priority}</span>}
      {pct != null && <span className="bar" title={`${pct}%`}><i style={{ width: `${pct}%` }} /></span>}
    </a>
  );
}

export function Tasks({ snapshot, config }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => Object.fromEntries(config.collapsedStatuses.map((s) => [s, true])));
  if (!snapshot) return <div className="note">Waiting for the first Lark poll…</div>;
  if (snapshot.tasks.groups.length === 0) return <div className="note">No tasks in your view.</div>;
  const dot = (status: string) => (status === config.pendingLaunchStatus ? 'amber' : config.collapsedStatuses.includes(status) ? 'green' : 'blue');
  return (
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
            {!isCollapsed && g.records.map((r) => <TaskRow key={r.recordId} r={r} />)}
          </div>
        );
      })}
    </div>
  );
}
