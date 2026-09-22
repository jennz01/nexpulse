import { useEffect, useReducer, useRef, useState } from 'react';
import { computeAttention } from '../../shared/attention';
import { SOURCE_IDS } from '../../shared/types';
import type { AuthProvider, PanelId, SourceId } from '../../shared/types';
import { fetchState, markSeen, openEvents, refreshSource, switchGithubAccount } from './api';
import { AuthDialog } from './auth/AuthDialog';
import { authProblems, useAuthStatus } from './auth/useAuthStatus';
import { freshness } from './freshness';
import { IconAlert, IconCheck, IconRefresh, IconReset, IconSliders } from './icons';
import { DEFAULT_LAYOUT, isDefaultLayout, isOnHome } from './layout/layout';
import { useLayout } from './layout/useLayout';
import { notifyHighEvents, toastable, updateTitle } from './notify';
import { BuildsPage } from './pages/BuildsPage';
import type { PageContext } from './pages/context';
import { HomePage } from './pages/HomePage';
import { ReleasesPage } from './pages/ReleasesPage';
import { SettingsPage } from './pages/SettingsPage';
import { StoresPage } from './pages/StoresPage';
import { PAGE_TITLE, pageForPanel, useMediaQuery, usePage } from './router';
import type { Page } from './router';
import { useSettings } from './settings/useSettings';
import { Sidebar } from './Sidebar';
import { initialState, panelForEvent, reducer, unreadByPanel } from './state';
import { formatDay } from './time';

const SOURCE_LABEL: Record<SourceId, string> = { github: 'GitHub', codemagic: 'Codemagic', lark: 'Lark', appstore: 'App Store', playstore: 'Play' };

export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function scrollToPanel(id: PanelId): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const now = useNow();
  const wasOffline = useRef(false);
  const [settings, patchSettings] = useSettings();
  const seenEventIds = useRef(new Set<number>());
  const hasLoadedOnce = useRef(false);
  const [page, setPage] = usePage();
  const pageRef = useRef(page);
  pageRef.current = page;
  const pendingPanel = useRef<{ panel: PanelId; page: Page } | null>(null);
  const [layout, setLayout] = useLayout();
  const [customizing, setCustomizing] = useState(false);
  const narrow = useMediaQuery('(max-width: 1199px)');
  const collapsed = narrow || settings.sidebar === 'collapsed';

  const load = () => fetchState().then((p) => dispatch({ type: 'loaded', payload: p })).catch((e: Error) => dispatch({ type: 'error', message: e.message }));

  useEffect(() => {
    void load();
    return openEvents(
      (m) => dispatch({ type: 'sse', payload: m, now: Date.now() }),
      (s) => {
        dispatch({ type: 'connection', status: s });
        if (s === 'live' && wasOffline.current) void load(); // reconnect: catch up on anything missed (spec §8)
        wasOffline.current = s === 'offline';
      },
    );
  }, []);

  const seeIds = (ids: number[]) => { if (ids.length) { dispatch({ type: 'seen', ids }); void markSeen({ ids }); } };
  const seeSource = (source: SourceId) => { dispatch({ type: 'seenSource', source }); void markSeen({ source }); };
  const intervals = state.config?.intervals ?? { github: 60, codemagic: 120, lark: 120, appstore: 600, playstore: 600 };
  const showUnread = settings.alertMode !== 'off';
  const unread = unreadByPanel(showUnread ? state.events : []);
  const chips = state.config ? computeAttention(state.states, state.config, now) : [];

  /** Chips and toasts land on a panel: Home if the layout shows it there, else its own page; switch first if needed, then scroll it into view. */
  const navigate = (panel: PanelId) => {
    const target: Page = isOnHome(layout, panel) ? 'home' : pageForPanel(panel);
    if (target === pageRef.current) { scrollToPanel(panel); return; }
    pendingPanel.current = { panel, page: target };
    setPage(target);
  };
  useEffect(() => {
    const pending = pendingPanel.current;
    if (pending && pending.page === page) { pendingPanel.current = null; scrollToPanel(pending.panel); }
  }, [page]);

  useEffect(() => { updateTitle(state.events.length, settings.alertMode); }, [state.events.length, settings.alertMode]);

  // Toasts fire once per event, only for events that arrived over SSE after load.
  useEffect(() => {
    if (!state.loaded) return;
    const firstLoad = !hasLoadedOnce.current;
    hasLoadedOnce.current = true;
    const fresh = toastable(state.events, seenEventIds.current, firstLoad);
    if (fresh.length) notifyHighEvents(fresh, settings.alertMode, (e) => {
      const panel = panelForEvent(e);
      if (panel) navigate(panel);
      seeIds([e.id]);
    });
  }, [state.events, state.loaded, settings.alertMode]);

  const [auth, refreshAuth] = useAuthStatus(state.states);
  const [authDialog, setAuthDialog] = useState<AuthProvider | null>(null);
  const problems = authProblems(auth, state.states, now);
  const switchAccount = () => void switchGithubAccount().then(() => refreshAuth(true)).catch(() => refreshAuth(true));

  const ctx: PageContext = { state, now, intervals, unread, showUnread, chips, settings, patchSettings, layout, setLayout, customizing, setCustomizing, seeIds, seeSource, navigate, reload: () => void load(), auth, refreshAuth, openLogin: setAuthDialog };
  const cz = customizing && page === 'home';

  return (
    <div className="shell">
      <Sidebar page={page} onNavigate={(p) => { setCustomizing(false); setPage(p); window.scrollTo({ top: 0 }); }} unread={unread} chips={chips} collapsed={collapsed} canToggle={!narrow}
        onToggle={() => patchSettings({ sidebar: collapsed ? 'expanded' : 'collapsed' })} />
      <div className="content">
        <header className="header">
          <div className="header-left">
            <h1 className="brand">{PAGE_TITLE[page]}</h1>
            {cz ? (
              <>
                <span className="tag accent">CUSTOMIZING</span>
                <span className="muted" style={{ fontSize: '0.8125rem' }}>Drag a header to move · drag a corner to resize · paint button for colour and size</span>
              </>
            ) : (
              <>
                <span className="mono muted" style={{ fontSize: '0.8125rem' }}>{formatDay(now)}</span>
                {state.connection !== 'live' && <span className="tag warn">{state.connection === 'offline' ? 'reconnecting…' : 'connecting…'}</span>}
              </>
            )}
          </div>
          {!cz && <div className="header-mid">
            {SOURCE_IDS.map((id) => {
              const f = freshness(state.states[id], intervals[id], now);
              const s = state.states[id];
              return (
                <span key={id} className="fresh" title={s.error ?? s.disabled ?? (s.fetchedAt ? `last poll ${new Date(s.fetchedAt).toLocaleTimeString()}` : 'no data yet')}>
                  <i className={`dot ${f.tone}`} />{SOURCE_LABEL[id]} <span className="mono faint">{f.label}</span>
                </span>
              );
            })}
          </div>}
          <div className="header-right">
            {cz ? (
              <>
                <button className="btn" title="Back to the original two-column layout" disabled={isDefaultLayout(layout)} onClick={() => setLayout(DEFAULT_LAYOUT)}><IconReset size={14} />Reset layout</button>
                <button className="btn primary" onClick={() => setCustomizing(false)}><IconCheck size={14} />Done</button>
              </>
            ) : (
              <>
                {page === 'home' && <button className="iconbtn" title="Customize layout" onClick={() => setCustomizing(true)}><IconSliders /></button>}
                <button className="iconbtn" title="Refresh all" onClick={() => SOURCE_IDS.forEach((id) => { if (!state.states[id].disabled) void refreshSource(id); })}><IconRefresh /></button>
              </>
            )}
          </div>
        </header>

        {problems.map((p) => (
          <div key={p.provider} className={`banner ${p.severity}`} role="alert">
            <IconAlert size={16} />
            <span><b>{p.title}</b> · {p.detail}</span>
            {p.action === 'switch'
              ? <button className="btn" onClick={switchAccount}>Switch to {auth?.github.expected}</button>
              : <button className="btn" onClick={() => setAuthDialog(p.provider)}>{p.action === 'setup' ? 'Set up' : 'Re-authorize'}</button>}
          </div>
        ))}
        {state.error && <div className="stale red" role="alert">Could not load state: {state.error}</div>}

        {page === 'home' && <HomePage {...ctx} />}
        {page === 'builds' && <BuildsPage {...ctx} />}
        {page === 'releases' && <ReleasesPage {...ctx} />}
        {page === 'stores' && <StoresPage {...ctx} />}
        {page === 'settings' && <SettingsPage {...ctx} />}
        {authDialog && <AuthDialog provider={authDialog} onClose={() => setAuthDialog(null)} onDone={() => { void refreshAuth(true); void load(); }} />}
      </div>
    </div>
  );
}
