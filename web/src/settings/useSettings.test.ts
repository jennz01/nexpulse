import { expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, applyAppearance, loadSettings, resolveTheme, saveSettings } from './useSettings';

const memStorage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

test('loadSettings falls back to defaults on garbage or missing storage', () => {
  expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  const s = memStorage();
  s.setItem('dashboard.settings', '{"alertMode":"loud","theme":"dark","fontSize":3}');
  expect(loadSettings(s)).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
});

test('saveSettings round-trips', () => {
  const s = memStorage();
  saveSettings(s, { ...DEFAULT_SETTINGS, density: 'compact' });
  expect(loadSettings(s).density).toBe('compact');
});

test('resolveTheme', () => {
  expect(resolveTheme('auto', true)).toBe('dark');
  expect(resolveTheme('auto', false)).toBe('light');
  expect(resolveTheme('light', true)).toBe('light');
});

test('applyAppearance stamps the root element', () => {
  const root = document.createElement('html');
  applyAppearance(root, { alertMode: 'off', theme: 'auto', fontSize: 'large', density: 'compact', sidebar: 'expanded' }, true);
  expect(root.dataset.theme).toBe('dark');
  expect(root.dataset.density).toBe('compact');
  expect(root.style.fontSize).toBe('18px');
});
