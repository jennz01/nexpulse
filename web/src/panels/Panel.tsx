import { useState } from 'react';
import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import type { PanelId, SourceState } from '../../../shared/types';
import { freshness } from '../freshness';
import { IconClose, IconExternal, IconRefresh, IconSearch } from '../icons';
import type { Tint } from '../layout/layout';
import { formatClock } from '../time';

export interface PanelProps {
  id: PanelId;
  title: string;
  count?: ReactNode;
  unread: number;
  /** One state per backing source; the panel shows the worst freshness. */
  state: SourceState | SourceState[];
  intervalSec: number;
  now: number;
  onRefresh?: () => void;
  onMarkAllSeen?: () => void;
  openUrl?: string;
  headerRight?: ReactNode;
  /** A local filter over what the panel already holds: a header toggle opens a search row under the header. */
  search?: { value: string; onChange: (value: string) => void; placeholder?: string };
  children: ReactNode;
  /** Colour preset from the Home layout; `data-tint` lets styles.css pick the header band and body wash. */
  tint?: Tint;
  /** Rendered before the title (customize mode: the drag grip). */
  leading?: ReactNode;
  /** Replaces everything on the right of the header, including `headerRight` (customize mode). */
  tools?: ReactNode;
  /** Fixed height: the inner column fills the card and the body scrolls instead of growing. */
  fill?: boolean;
  /** Rendered after the inner column for absolutely positioned chrome (resize handle, popover). */
  extra?: ReactNode;
  /** The header-plus-body column, whose natural height the Home grid measures for auto-height cards. */
  innerRef?: Ref<HTMLDivElement>;
  className?: string;
  style?: CSSProperties;
  /** Extra attributes on the section (drag-and-drop handlers in customize mode). */
  sectionProps?: HTMLAttributes<HTMLElement>;
}

export function Panel(props: PanelProps) {
  const states = Array.isArray(props.state) ? props.state : [props.state];
  const disabled = states.every((s) => s.disabled) ? states.map((s) => s.disabled).filter(Boolean).join('; ') : null;
  const errored = states.find((s) => s.error);
  const fresh = states.map((s) => freshness(s, props.intervalSec, props.now)).sort((a, b) => rank(b.tone) - rank(a.tone))[0]!;
  const className = ['panel', props.fill ? 'fill' : '', props.className ?? ''].filter(Boolean).join(' ');
  const [searching, setSearching] = useState(false);
  // Closing the row also drops the query, so a hidden filter never leaves the list mysteriously short.
  const closeSearch = () => { setSearching(false); props.search?.onChange(''); };
  return (
    <section className={className} id={props.id} aria-labelledby={`${props.id}-title`} data-tint={props.tint && props.tint !== 'none' ? props.tint : undefined} style={props.style} {...props.sectionProps}>
      <div className="panel-inner" ref={props.innerRef}>
        <div className="panel-h">
          <div className="panel-h-left">
            {props.leading}
            <h2 id={`${props.id}-title`}>{props.title}</h2>
            {props.count != null && <span className="count">{props.count}</span>}
            {props.unread > 0 && (
              <button className="unread" title="Mark all seen" onClick={props.onMarkAllSeen}>{props.unread}</button>
            )}
          </div>
          <div className="panel-h-right">
            {props.tools ?? (
              <>
                {props.headerRight}
                {props.search && (
                  <button className={`iconbtn sm ${searching ? 'on' : ''}`} title="Search this panel" aria-expanded={searching}
                    onClick={() => (searching ? closeSearch() : setSearching(true))}><IconSearch size={14} /></button>
                )}
                <span className={`meta mono ${fresh.tone === 'amber' ? 'amber' : ''}`} style={fresh.tone === 'amber' ? { color: 'var(--amber)' } : undefined}>{fresh.label}</span>
                {props.onRefresh && !disabled && (
                  <button className="iconbtn sm" title="Refresh" onClick={props.onRefresh}><IconRefresh size={14} /></button>
                )}
                {props.openUrl && (
                  <a className="iconbtn sm" href={props.openUrl} target="_blank" rel="noreferrer" title="Open in source"><IconExternal size={14} /></a>
                )}
              </>
            )}
          </div>
        </div>
        {props.search && searching && !props.tools && (
          <div className="panel-search">
            <input className="search" type="text" autoFocus placeholder={props.search.placeholder ?? 'Search…'} value={props.search.value}
              onChange={(e) => props.search?.onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') closeSearch(); }}
              aria-label={`Search ${props.title}`} spellCheck={false} />
            <button className="iconbtn sm" title="Clear and close (Esc)" onClick={closeSearch}><IconClose size={14} /></button>
          </div>
        )}
        {errored && !disabled && (
          <div className={`stale ${errored.fetchedAt == null ? 'red' : ''}`}>
            {errored.fetchedAt == null ? 'No data yet' : `Stale since ${formatClock(errored.fetchedAt)}`} · {errored.error}
          </div>
        )}
        <div className="panel-body">{disabled ? <div className="note">Off: {disabled}</div> : props.children}</div>
      </div>
      {props.extra}
    </section>
  );
}

const rank = (t: string) => ({ red: 3, amber: 2, grey: 1, green: 0 })[t] ?? 0;
