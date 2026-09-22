import { useEffect, useState } from 'react';
import type { PanelId } from '../../shared/types';

export type Page = 'home' | 'builds' | 'releases' | 'stores' | 'settings';
export const PAGES: Page[] = ['home', 'builds', 'releases', 'stores', 'settings'];
/** Pages in the sidebar's main navigation; Settings sits at the bottom. */
export const NAV_PAGES: Page[] = ['home', 'builds', 'releases', 'stores'];
export const PAGE_TITLE: Record<Page, string> = { home: 'Home', builds: 'Builds', releases: 'Releases', stores: 'Stores', settings: 'Settings' };

/** "#/builds" -> 'builds'; anything unknown (including an empty hash) -> 'home'. */
export function parseHash(hash: string): Page {
  const name = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  return (PAGES as string[]).includes(name) ? (name as Page) : 'home';
}

export const hashFor = (page: Page): string => (page === 'home' ? '#/' : `#/${page}`);

/** Which page hosts a panel: Builds, Releases and Stores have their own pages, the rest live on Home. */
export function pageForPanel(panel: PanelId): Page {
  return panel === 'builds' || panel === 'releases' || panel === 'stores' ? panel : 'home';
}

/** Hash-based routing: no dependency, bookmarkable, and the server's index.html fallback is never involved. */
export function usePage(): [Page, (page: Page) => void] {
  const [page, setPage] = useState<Page>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setPage(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [page, (next) => { window.location.hash = hashFor(next); setPage(next); }];
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
