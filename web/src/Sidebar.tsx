import type { ReactNode } from 'react';
import type { AttentionChip, Event, PanelId, Tone } from '../../shared/types';
import { IconBuilds, IconChevronLeft, IconChevronRight, IconHome, IconLogo, IconSettings, IconStores } from './icons';
import type { Page } from './router';
import { NAV_PAGES, PAGE_TITLE, pageForPanel } from './router';

const PAGE_ICON: Record<Page, ReactNode> = {
  home: <IconHome size={18} />, builds: <IconBuilds size={18} />, stores: <IconStores size={18} />, settings: <IconSettings size={18} />,
};
const TONE_RANK: Record<Tone, number> = { red: 3, amber: 2, blue: 1, grey: 0 };

/** Worst tone among the chips whose target panel lives on `page`; null when nothing there needs attention. */
export function pageTone(chips: AttentionChip[], page: Page): Tone | null {
  let worst: Tone | null = null;
  for (const c of chips) {
    if (pageForPanel(c.target) !== page) continue;
    if (worst == null || TONE_RANK[c.tone] > TONE_RANK[worst]) worst = c.tone;
  }
  return worst;
}

export function pageUnread(unread: Record<PanelId, Event[]>, page: Page): number {
  return (Object.keys(unread) as PanelId[]).filter((p) => pageForPanel(p) === page).reduce((n, p) => n + unread[p].length, 0);
}

interface Props {
  page: Page;
  onNavigate: (page: Page) => void;
  unread: Record<PanelId, Event[]>;
  chips: AttentionChip[];
  collapsed: boolean;
  /** False when the viewport forces the icon rail; the toggle is hidden then. */
  canToggle: boolean;
  onToggle: () => void;
}

export function Sidebar({ page, onNavigate, unread, chips, collapsed, canToggle, onToggle }: Props) {
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Navigation">
      <div className="sb-brand"><IconLogo /><span className="brand label">NexPulse</span></div>
      <nav className="nav">
        {NAV_PAGES.map((p) => {
          const n = pageUnread(unread, p);
          const tone = pageTone(chips, p);
          return (
            <button key={p} className={`navitem ${p === page ? 'on' : ''}`} aria-current={p === page ? 'page' : undefined} title={collapsed ? PAGE_TITLE[p] : undefined} onClick={() => onNavigate(p)}>
              <span className="ico">
                {PAGE_ICON[p]}
                {(tone != null || n > 0) && <i className={`mark ${tone ?? 'accent'}`} />}
              </span>
              <span className="label">{PAGE_TITLE[p]}</span>
              {n > 0 && <span className="unread label" title={`${n} unread`}>{n}</span>}
            </button>
          );
        })}
      </nav>
      <nav className="nav bottom">
        <button className={`navitem ${page === 'settings' ? 'on' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} title={collapsed ? 'Settings' : undefined} onClick={() => onNavigate('settings')}>
          <span className="ico">{PAGE_ICON.settings}</span><span className="label">Settings</span>
        </button>
        {canToggle && (
          <button className="navitem" title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={onToggle}>
            <span className="ico">{collapsed ? <IconChevronRight size={18} /> : <IconChevronLeft size={18} />}</span><span className="label">Collapse</span>
          </button>
        )}
      </nav>
    </aside>
  );
}
