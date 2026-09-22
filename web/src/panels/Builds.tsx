import { useState } from 'react';
import { appsOutsideReleases } from '../../../shared/releases';
import { isBuildFailed, isBuildRunning } from '../../../shared/status';
import type { Build, BuildArtifact, CodemagicApp, CodemagicSnapshot, Event } from '../../../shared/types';
import { artifactUrl } from '../api';
import { IconDownload, IconExternal } from '../icons';
import { unreadItems } from '../state';
import { formatDuration, relativeTime } from '../time';
import { openItem } from './open';

interface Props {
  snapshot: CodemagicSnapshot | null;
  events: Event[];
  onSee: (ids: number[]) => void;
  now: number;
  /** Page layout: every returned build per app as a table. Default is the compact list (latest per workflow, expandable). */
  full?: boolean;
}

/**
 * One row per workflow for the compact list. Bulk-release builds have no workflow id at all, so they fall back to
 * their run: a 24-brand release collapses to the single row it reads as, rather than 24 identical ones.
 */
export function latestPerWorkflow(app: CodemagicApp): Build[] {
  const seen = new Set<string>();
  return app.builds.filter((b) => {
    const key = b.workflowId ?? b.runId ?? b.id;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

export function statusClass(status: string): 'run' | 'fail' | 'ok' | 'warn' | 'plain' {
  if (isBuildRunning(status)) return 'run';
  if (isBuildFailed(status)) return 'fail';
  if (status === 'finished') return 'ok';
  if (status === 'warning') return 'warn';
  return 'plain';
}

const INSTALLABLE_TYPE = /^(apk|aab|ipa)$/i;
const INSTALLABLE_NAME = /\.(apk|aab|ipa)$/i;

/**
 * Installables (apk, aab, ipa) show inline; everything else a Flutter build emits (aar modules, mapping files,
 * dSYMs) folds behind "+N more". Positions are kept because the download proxy addresses artifacts by index.
 */
export function splitArtifacts(list: BuildArtifact[]): { primary: number[]; rest: number[] } {
  const primary: number[] = [];
  const rest: number[] = [];
  list.forEach((a, i) => (INSTALLABLE_TYPE.test(a.type) || INSTALLABLE_NAME.test(a.name) ? primary : rest).push(i));
  return { primary, rest };
}

/** Readable "by": the commit author, else whoever started it unless that is only an opaque Codemagic user id. */
export function buildBy(b: Build): string | null {
  if (b.author) return b.author;
  return b.startedBy && !/^[0-9a-f]{24}$/i.test(b.startedBy) ? b.startedBy : null;
}

/**
 * "ROCKMART · v1.0.68 (80) · [HOTFIX] …" for the second line of the workflow cell; null when nothing is known.
 * The brand leads: every build of a bulk release shares one workflow name and one commit message, so the store
 * app is the only thing telling them apart.
 */
export function buildSubtitle(b: Build): string | null {
  const version = b.version ? `v${b.version}${b.buildNumber != null ? ` (${b.buildNumber})` : ''}` : null;
  return [b.brand, version, b.commitMessage].filter(Boolean).join(' · ') || null;
}

interface RowProps { app: CodemagicApp; b: Build; ids: number[]; onSee: Props['onSee']; now: number; full: boolean }

function BuildRow({ app, b, ids, onSee, now, full }: RowProps) {
  const [more, setMore] = useState(false);
  const cls = statusClass(b.status);
  const when = b.startedAt ? (isBuildRunning(b.status) ? `started ${relativeTime(b.startedAt, now)} ago` : `${relativeTime(b.finishedAt ?? b.startedAt, now)} ago`) : '';
  const status = <span className={`tag ${cls}`}>{cls === 'run' && <i className="dot blue pulse" />}{b.status.toUpperCase()}</span>;
  const { primary, rest } = splitArtifacts(b.artifacts);
  const by = buildBy(b);
  const subtitle = buildSubtitle(b);
  const link = (i: number) => {
    const a = b.artifacts[i]!;
    return (
      <a key={i} className="meta" href={artifactUrl(b.id, i)} onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)' }} title={`Download ${a.name}`}>
        <IconDownload size={12} />{a.name}{a.size != null && ` · ${Math.round(a.size / 1_048_576)} MB`}
      </a>
    );
  };
  const artifacts = (
    <>
      {[...primary, ...(more ? rest : [])].map(link)}
      {rest.length > 0 && (
        <button className="meta more" onClick={(e) => { e.stopPropagation(); setMore(!more); }}>{more ? 'fewer' : `+${rest.length} more`}</button>
      )}
    </>
  );
  const open = <a className="iconbtn sm" href={b.url} target="_blank" rel="noreferrer" title={`Open in Codemagic (${app.name})`} onClick={(e) => e.stopPropagation()}><IconExternal size={14} /></a>;
  const onClick = () => openItem(b.url, ids, onSee);

  if (full) {
    return (
      <div className={`brow click ${ids.length ? 'new' : ''}`} role="listitem" onClick={onClick}>
        <i className={ids.length ? 'newdot' : 'nodot'} />
        {status}
        <span className="cell">
          <span className="clip" style={{ fontWeight: 500 }} title={b.workflowName}>{b.workflowName}</span>
          {subtitle && <span className="meta clip" title={subtitle}>{subtitle}</span>}
        </span>
        <span className="meta mono clip" title={b.branch}>{b.branch}</span>
        <span className="meta">{when}</span>
        <span className="meta mono">{formatDuration(b.durationSec)}</span>
        <span className="meta clip" title={by ?? undefined}>{by ?? ''}</span>
        <span className="arts">{b.artifacts.length ? artifacts : <span className="meta faint">none</span>}</span>
        {open}
      </div>
    );
  }
  return (
    <div className={`row click ${ids.length ? 'new' : ''}`} role="listitem" onClick={onClick}>
      <i className={ids.length ? 'newdot' : 'nodot'} />
      {status}
      <span className="title"><span style={{ fontWeight: 500 }}>{b.workflowName}</span> <span className="meta mono">{b.branch}</span></span>
      {artifacts}
      <span className="meta">
        {when}
        {b.durationSec != null && ` · ${formatDuration(b.durationSec)}`}
        {by && ` · ${by}`}
      </span>
      {open}
    </div>
  );
}

export function Builds({ snapshot, events, onSee, now, full = false }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!snapshot) return <div className="note">Waiting for the first Codemagic poll…</div>;
  if (snapshot.apps.length === 0) return <div className="note">No Codemagic apps visible to this token.</div>;
  const unread = unreadItems(events, 'builds');

  const apps = appsOutsideReleases(snapshot).map(({ app, builds }) => {
    const all = full || expanded[app.id];
    const shown = all ? builds : latestPerWorkflow({ ...app, builds });
    return (
      <div key={app.id}>
        <div className="group">
          {app.name.toUpperCase()}
          {full ? (
            <span className="right">{builds.length} build{builds.length === 1 ? '' : 's'}</span>
          ) : builds.length > shown.length || all ? (
            <button className="right" onClick={() => setExpanded((e) => ({ ...e, [app.id]: !all }))}>{all ? 'show latest per workflow' : `show all ${builds.length}`}</button>
          ) : null}
        </div>
        {shown.length === 0 && <div className="note">No builds yet.</div>}
        {shown.map((b) => <BuildRow key={b.id} app={app} b={b} ids={unread.get(b.id) ?? []} onSee={onSee} now={now} full={full} />)}
      </div>
    );
  });

  if (!full) return <div className="rows" role="list">{apps}</div>;
  return (
    <div className="tablewrap">
      <div className="rows" role="list">
        <div className="brow head" aria-hidden="true">
          <i /><span className="sub head">STATUS</span><span className="sub head">WORKFLOW</span><span className="sub head">BRANCH</span><span className="sub head">STARTED</span><span className="sub head">DURATION</span><span className="sub head">BY</span><span className="sub head">ARTIFACTS</span><i />
        </div>
        {apps}
      </div>
    </div>
  );
}
