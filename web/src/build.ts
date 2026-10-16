import type { BuildInfo } from '../../shared/types';

declare const __NEXPULSE_BUILD__: BuildInfo | null;

/** This page's own build, stamped in by vite.config.ts; null under `vite` dev serving and in tests. */
export const PAGE_BUILD: BuildInfo | null = typeof __NEXPULSE_BUILD__ === 'undefined' ? null : __NEXPULSE_BUILD__;

/** "v0.29 · d196766", with a + when it was built from uncommitted changes. */
export const buildLabel = (b: BuildInfo): string => `${b.version} · ${b.sha}${b.dirty ? '+' : ''}`;
