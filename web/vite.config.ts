import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { BuildInfo } from '../shared/types';

const root = fileURLToPath(new URL('.', import.meta.url));

/** The version comes from git so it never needs bumping: every commit the auto-updater pulls is a new number. */
function buildInfo(): BuildInfo {
  const git = (...args: string[]): string => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const version = `v0.${git('rev-list', '--count', 'HEAD') || '0'}`;
  const sha = git('rev-parse', '--short', 'HEAD') || 'unknown';
  const dirty = git('status', '--porcelain') !== '';
  const builtAt = Date.now();
  return { version, sha, dirty, builtAt, id: `${version}-${sha}${dirty ? '+' : ''}-${builtAt}` };
}

export default defineConfig(({ command }) => {
  // `vite` dev serving has no build of its own to compare, so the page gets null and shows "dev".
  const build = command === 'build' ? buildInfo() : null;
  return {
    root,
    define: { __NEXPULSE_BUILD__: JSON.stringify(build) },
    plugins: [
      react(),
      // The same stamp next to index.html, so the server can tell open pages which build is current.
      { name: 'nexpulse-version', generateBundle() { if (build) this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(build) }); } },
    ],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: 'http://127.0.0.1:6600', changeOrigin: true } },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
