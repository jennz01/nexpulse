import { useState } from 'react';
import { buildLabel, releaseApps, runProgress } from '../../../shared/releases';
import type { ReleaseRun } from '../../../shared/releases';
import { isBuildRunning } from '../../../shared/status';
import type { Build, CodemagicSnapshot, Event } from '../../../shared/types';
import { artifactUrl } from '../api';
import { IconChevronDown, IconChevronRight, IconDownload, IconExternal } from '../icons';
import { unreadItems } from '../state';
import { formatDuration, relativeTime } from '../time';
import { splitArtifacts, statusClass } from './Builds';
import { openItem } from './open';

interface Props {
  snapshot: CodemagicSnapshot | null;
  events: Event[];
  onSee: (ids: number[]) => void;
  now: number;
}

/** relativeTime plus the "ago" that reads right: "2 min ago", but "just now" rather than "just now ago". */
export function ago(when: string | null, now: number): string {
  const rel = relativeTime(when, now);
  return rel === 'just now' || rel === 'never' || rel === '' ? rel : `${rel} ago`;
}

/** A queued build has no clock of its own yet, so it reports how long it has been waiting instead. */
export function buildWhen(b: Build, now: number): string {
  if (b.status === 'queued') {
    const waited = relativeTime(b.createdAt ?? null, now);
    return waited === 'just now' ? 'just queued' : `waiting ${waited}`;
  }
  if (isBuildRunning(b.status)) return b.startedAt ? `started ${ago(b.startedAt, now)}` : 'starting';
  const at = b.finishedAt ?? b.startedAt;
  return at ? ago(at, now) : '';
}

/** "20 queued · 2 building · 2 done", leaving out whatever is zero. */
export function countsLine(run: ReleaseRun): string {
  const { queued, running, settled, failed } = run.counts;
  return [
    queued > 0 && `${queued} queued`,
    running > 0 && `${running} building`,
    settled - failed > 0 && `${settled - failed} done`,
    failed > 0 && `${failed} failed`,
  ].filter(Boolean).join(' · ');
}

function ReleaseRow({ run, b, ids, onSee, now }: { run: ReleaseRun; b: Build; ids: number[]; onSee: Props['onSee']; now: number }) {
  const [more, setMore] = useState(false);
  const cls = statusClass(b.status);
  const { primary, rest } = splitArtifacts(b.artifacts);
  const label = buildLabel(b);
  return (
    <div className={`rrow click ${ids.length ? 'new' : ''}`} role="listitem" onClick={() => openItem(b.url, ids, onSee)}>
      <i className={ids.length ? 'newdot' : 'nodot'} />
      {b.iconUrl
        ? <img className="brandicon" src={b.iconUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
        : <i className="brandicon empty" />}
      <span className="cell">
        <span className="clip" style={{ fontWeight: 500 }} title={label}>{label}</span>
        <span className="meta mono clip" title={b.bundleId ?? undefined}>{b.bundleId ?? ''}</span>
      </span>
      <span className={`tag ${cls}`}>{cls === 'run' && <i className="dot blue pulse" />}{b.status.toUpperCase()}</span>
      <span className="meta mono">{b.storeId ?? ''}</span>
      <span className="meta">{buildWhen(b, now)}</span>
      <span className="meta mono">{formatDuration(b.durationSec)}</span>
      <span className="arts">
        {b.artifacts.length === 0 ? <span className="meta faint">—</span> : (
          <>
            {[...primary, ...(more ? rest : [])].map((i) => {
              const a = b.artifacts[i]!;
              return (
                <a key={i} className="meta" href={artifactUrl(b.id, i)} onClick={(e) => e.stopPropagation()} title={`Download ${a.name}`}>
                  <IconDownload size={12} />{a.name}{a.size != null && ` · ${Math.round(a.size / 1_048_576)} MB`}
                </a>
              );
            })}
            {rest.length > 0 && (
              <button className="meta more" onClick={(e) => { e.stopPropagation(); setMore(!more); }}>{more ? 'fewer' : `+${rest.length} more`}</button>
            )}
          </>
        )}
      </span>
      <a className="iconbtn sm" href={b.url} target="_blank" rel="noreferrer" title={`Open ${label} in Codemagic`} onClick={(e) => e.stopPropagation()}><IconExternal size={14} /></a>
    </div>
  );
}

function Run({ run, open, onToggle, unread, onSee, now }: { run: ReleaseRun; open: boolean; onToggle: () => void; unread: Map<string, number[]>; onSee: Props['onSee']; now: number }) {
  const { total, settled, failed } = run.counts;
  const pct = Math.round(runProgress(run.counts) * 100);
  return (
    <div className={`relrun ${open ? 'open' : ''}`}>
      <button className="relrun-h" onClick={onToggle} aria-expanded={open}>
        <span className="relrun-chev">{open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}</span>
        <span className="relrun-title">
          <span className="clip" title={run.title}>{run.title}</span>
          <span className="meta">
            <span className="mono">{run.shortId}</span> · <span className="mono">{run.branch}</span>
            {run.createdAt && ` · ${ago(run.createdAt, now)}`}
            {run.partial && <span className="faint"> · may be missing older builds</span>}
          </span>
        </span>
        <span className="relrun-prog">
          <span className={`rbar ${failed > 0 ? 'hasfail' : ''}`} role="progressbar" aria-valuenow={settled} aria-valuemin={0} aria-valuemax={total} aria-label={`${settled} of ${total} settled`}>
            <i style={{ width: `${pct}%` }} />
          </span>
          <span className="meta mono">{settled}/{run.partial ? `${total}+` : total}</span>
        </span>
        <span className="meta run-counts">{countsLine(run)}</span>
      </button>
      {open && (
        <div className="rows" role="list">
          {run.builds.map((b) => <ReleaseRow key={b.id} run={run} b={b} ids={unread.get(b.id) ?? []} onSee={onSee} now={now} />)}
        </div>
      )}
    </div>
  );
}

export function Releases({ snapshot, events, onSee, now }: Props) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  if (!snapshot) return <div className="note">Waiting for the first Codemagic poll…</div>;
  const apps = releaseApps(snapshot);
  if (apps.length === 0) {
    return <div className="note">No bulk releases yet. A release shows up here once one commit fans out into builds for more than one store app.</div>;
  }
  const unread = unreadItems(events, 'builds');

  return (
    <div className="releases">
      {apps.map(({ app, runs }) => {
        const live = runs.reduce((n, r) => n + r.counts.queued + r.counts.running, 0);
        return (
          <div key={app.id}>
            <div className="group">
              {app.name.toUpperCase()}
              <span className="right">{live > 0 ? `${live} in flight` : `${runs.length} release${runs.length === 1 ? '' : 's'}`}</span>
            </div>
            {runs.map((run, i) => (
              <Run key={run.id} run={run} open={toggled[run.id] ?? (i === 0 || run.active)}
                onToggle={() => setToggled((t) => ({ ...t, [run.id]: !(t[run.id] ?? (i === 0 || run.active)) }))}
                unread={unread} onSee={onSee} now={now} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
