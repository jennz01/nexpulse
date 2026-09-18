import { useEffect, useState } from 'react';

export type AlertMode = 'toast' | 'badge' | 'off';
export type Theme = 'light' | 'dark' | 'auto';
export type FontSize = 'small' | 'medium' | 'large';
export type Density = 'comfortable' | 'compact';
export type Sidebar = 'expanded' | 'collapsed';
export interface Settings { alertMode: AlertMode; theme: Theme; fontSize: FontSize; density: Density; sidebar: Sidebar }

export const DEFAULT_SETTINGS: Settings = { alertMode: 'badge', theme: 'auto', fontSize: 'medium', density: 'comfortable', sidebar: 'expanded' };
export const FONT_PX: Record<FontSize, number> = { small: 14, medium: 16, large: 18 };
const KEY = 'dashboard.settings';
const ALLOWED: { [K in keyof Settings]: readonly Settings[K][] } = {
  alertMode: ['toast', 'badge', 'off'], theme: ['light', 'dark', 'auto'], fontSize: ['small', 'medium', 'large'], density: ['comfortable', 'compact'],
  sidebar: ['expanded', 'collapsed'],
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadSettings(storage: StorageLike | null): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!storage) return out;
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    for (const key of Object.keys(ALLOWED) as (keyof Settings)[]) {
      const v = raw[key];
      if (typeof v === 'string' && (ALLOWED[key] as readonly string[]).includes(v)) (out as unknown as Record<string, string>)[key] = v;
    }
  } catch {
    /* corrupt storage: defaults */
  }
  return out;
}

export function saveSettings(storage: StorageLike | null, s: Settings): void {
  try { storage?.setItem(KEY, JSON.stringify(s)); } catch { /* private mode etc. */ }
}

export const resolveTheme = (theme: Theme, prefersDark: boolean): 'light' | 'dark' => (theme === 'auto' ? (prefersDark ? 'dark' : 'light') : theme);

export function applyAppearance(root: HTMLElement, s: Settings, prefersDark: boolean): void {
  root.dataset.theme = resolveTheme(s.theme, prefersDark);
  root.dataset.density = s.density;
  root.style.fontSize = `${FONT_PX[s.fontSize]}px`;
}

export function safeStorage(): StorageLike | null {
  try { return window.localStorage; } catch { return null; }
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(() => loadSettings(safeStorage()));
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyAppearance(document.documentElement, settings, mq.matches);
    apply();
    saveSettings(safeStorage(), settings);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);
  return [settings, (patch) => setSettings((s) => ({ ...s, ...patch }))];
}
