import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { unzipSync } from 'fflate';

export class SkillZipError extends Error {}

const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;
const SKILL_NAME = /^name:\s*["']?lark-issue-triage["']?\s*$/m;

/**
 * Zip entry name -> safe relative path, or null for a directory entry. Throws on anything that could leave the target
 * folder: absolute or drive paths, `..`, empty segments, and `:` (on NTFS `a.txt:x` writes a hidden data stream).
 */
function safeName(raw: string): string | null {
  const name = raw.replace(/\\/g, '/');
  if (name.endsWith('/')) return null;
  if (name.startsWith('/') || name.includes(':') || name.split('/').some((part) => part === '..' || part === '')) {
    throw new SkillZipError(`unsafe path in zip: ${raw}`);
  }
  return name;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * Checks every entry before anything is written: sizes and count are capped while unzipping, paths may not climb out,
 * and the zip must hold the lark-issue-triage SKILL.md at its top or under one top folder (any name).
 * Entries come out as plain file bytes, so a symlink stored in the zip can only ever become an ordinary file.
 */
export function inspectSkillZip(bytes: Uint8Array): { files: Map<string, Uint8Array>; version: string | null } {
  let count = 0;
  let total = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, {
      filter: (f) => {
        count += 1;
        total += f.originalSize;
        if (count > MAX_ENTRIES) throw new SkillZipError(`zip has more than ${MAX_ENTRIES} entries`);
        if (total > MAX_UNCOMPRESSED) throw new SkillZipError('zip expands to more than 50 MB');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof SkillZipError) throw e;
    throw new SkillZipError(`not a readable zip (${(e as Error).message})`);
  }
  const entries = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(raw)) {
    const safe = safeName(name);
    if (safe) entries.set(safe, data);
  }
  let prefix = '';
  if (!entries.has('SKILL.md')) {
    const tops = new Set([...entries.keys()].map((n) => n.split('/')[0]));
    const top = tops.size === 1 ? [...tops][0]! : null;
    if (!top || !entries.has(`${top}/SKILL.md`)) throw new SkillZipError('zip does not contain the lark-issue-triage skill (no SKILL.md at its top or in one top folder)');
    prefix = `${top}/`;
  }
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of entries) if (name.startsWith(prefix)) files.set(name.slice(prefix.length), data);
  const head = new TextDecoder().decode(files.get('SKILL.md')!.slice(0, 2000));
  if (!SKILL_NAME.test(head)) throw new SkillZipError('the SKILL.md in this zip is not the lark-issue-triage skill');
  const v = files.get('VERSION');
  return { files, version: v ? new TextDecoder().decode(v).trim() || null : null };
}

/** Unpacks next to the skill folder and swaps it in; the per-PC settings file lives outside and is never touched. */
export function installSkill(bytes: Uint8Array, opts: { skillDir: string; confirmOlder: boolean }): { installed: string | null; previous: string | null; needsConfirm?: boolean } {
  const { files, version } = inspectSkillZip(bytes);
  const previous = existsSync(join(opts.skillDir, 'VERSION')) ? readFileSync(join(opts.skillDir, 'VERSION'), 'utf8').trim() || null : null;
  if (previous && version && compareVersions(version, previous) < 0 && !opts.confirmOlder) return { installed: null, previous, needsConfirm: true };
  const parent = dirname(opts.skillDir);
  const fresh = join(parent, '.lark-issue-triage.new');
  const old = join(parent, '.lark-issue-triage.old');
  rmSync(fresh, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  for (const [name, data] of files) {
    const target = join(fresh, ...name.split('/'));
    if (!target.startsWith(fresh + sep)) throw new SkillZipError(`unsafe path in zip: ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  // The skill's .cache (resolved Lark share links) is built up on this PC and never shipped; keep it across updates.
  const cache = join(opts.skillDir, '.cache');
  if (existsSync(cache) && !existsSync(join(fresh, '.cache'))) cpSync(cache, join(fresh, '.cache'), { recursive: true });
  if (existsSync(opts.skillDir)) renameSync(opts.skillDir, old);
  try {
    renameSync(fresh, opts.skillDir);
  } catch (e) {
    if (existsSync(old)) renameSync(old, opts.skillDir);
    throw e;
  }
  rmSync(old, { recursive: true, force: true });
  return { installed: version, previous };
}
