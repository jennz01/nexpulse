import { resolve } from 'node:path';
import type { AppStoreSnapshot, CodemagicSnapshot, GithubSnapshot, LarkSnapshot, PlaySnapshot, SourceId } from '../shared/types';
import { loadConfig } from './config';
import { buildSources } from './sources/index';
import { describeError } from './sources/types';

export function summarize(id: SourceId, snapshot: unknown): string {
  switch (id) {
    case 'github': {
      const s = snapshot as GithubSnapshot;
      return `${s.incoming.length} incoming, ${s.mine.length} mine`;
    }
    case 'codemagic': {
      const s = snapshot as CodemagicSnapshot;
      return `${s.apps.length} apps, ${s.apps.reduce((n, a) => n + a.builds.length, 0)} builds`;
    }
    case 'lark': {
      const s = snapshot as LarkSnapshot;
      const issues = Object.values(s.issues.counts).reduce((a, b) => a + b, 0);
      // Every record without a status means fields.status names a column the table does not have (it comes back empty, not as an error).
      const allEmpty = (groups: { status: string }[] | undefined) => groups?.length === 1 && groups[0]!.status === '';
      const noStatus = [allEmpty(s.tasks.groups) ? 'tasks' : null, allEmpty(s.issues.groups) ? 'issues' : null].filter(Boolean);
      const warn = noStatus.length ? `; WARNING: no ${noStatus.join(' or ')} have a status, so lark.tables.<table>.fields.status does not match a column name` : '';
      return `${s.tasks.total} tasks, ${issues} issues, ${s.feedback.records.length} feedback${warn}`;
    }
    case 'appstore':
      return `${(snapshot as AppStoreSnapshot).apps.length} apps`;
    case 'playstore':
      return `${(snapshot as PlaySnapshot).apps.length} apps`;
  }
}

export function formatTable(rows: string[][]): string {
  const widths = rows.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ')).join('\n');
}

async function main(): Promise<number> {
  const loaded = loadConfig(resolve(import.meta.dir, '..'));
  const { sources } = await buildSources(loaded, { log: () => {}, getSnapshot: () => null });
  const rows: string[][] = [];
  let failed = false;
  for (const reg of sources) {
    const id = reg.source.id;
    if (reg.disabled) {
      rows.push([id, 'DISABLED', reg.disabled]);
      continue;
    }
    const t0 = Date.now();
    try {
      const snap: unknown = await reg.source.fetch(reg.ctx, null, true);
      rows.push([id, 'OK', `${Date.now() - t0} ms · ${summarize(id, snap)}`]);
    } catch (err) {
      failed = true;
      rows.push([id, 'ERROR', describeError(err)]);
    }
  }
  console.log(formatTable(rows));
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
