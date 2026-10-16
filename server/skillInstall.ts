import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { unzipSync } from 'fflate';

export class SkillZipError extends Error {}

const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;
/** fflate keeps inflating past an entry's claimed size, so a hostile zip can spin for hours; the worker is stopped at this. */
const INSPECT_TIMEOUT_MS = 15_000;
const SKILL_NAME = /^name:\s*["']?lark-issue-triage["']?\s*$/m;
/** Windows device names, in any case and with any extension (CON, nul.txt, COM1, LPT¹ …). */
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[<>"|?*\u0000-\u001f]/;

interface CentralEntry { name: string; crc: number; size: number; offset: number }

/**
 * The zip's central directory, read directly: fflate trusts it without checking that entries are distinct or that
 * their bytes match their CRC, so both are checked here before and after unzipping.
 */
function centralDirectory(bytes: Uint8Array): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new SkillZipError('not a readable zip (no end of central directory)');
  const count = view.getUint16(eocd + 10, true);
  if (count > MAX_ENTRIES) throw new SkillZipError(`zip has more than ${MAX_ENTRIES} entries`);
  let p = view.getUint32(eocd + 16, true);
  const out: CentralEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw new SkillZipError('not a readable zip (broken central directory)');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    out.push({
      crc: view.getUint32(p + 16, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Zip entry name -> safe relative path, or null for a directory entry. Throws on anything that could leave the target
 * folder or misbehave on Windows: absolute or drive paths, `..`, empty segments, `:` (NTFS data streams), device names,
 * reserved characters, and segments ending in a dot or space (Windows silently strips them, so two names can collide).
 */
function safeName(raw: string): string | null {
  const name = raw.replace(/\\/g, '/');
  if (name.endsWith('/')) return null;
  const parts = name.split('/');
  if (name.startsWith('/') || name.includes(':') || parts.some((part) => part === '..' || part === '' || DEVICE.test(part) || BAD_CHARS.test(part) || /[. ]$/.test(part))) {
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
 * Checks every entry before anything is written: count and total size are capped, entries may not share bytes, paths
 * may not climb out or trip Windows naming rules, every file must match its CRC, and the zip must hold the
 * lark-issue-triage SKILL.md at its top or under one top folder (any name). Compiled Python and local caches are refused:
 * Python would run a shipped .pyc without reading the source beside it, and .cache belongs to the PC it was built on.
 * CPU-bound on a hostile zip, so the server runs it in a worker with a time limit (inspectInWorker).
 */
export function inspectSkillZip(bytes: Uint8Array): { files: Map<string, Uint8Array>; version: string | null } {
  const central = centralDirectory(bytes);
  const offsets = new Set<number>();
  for (const e of central) {
    if (offsets.has(e.offset)) throw new SkillZipError('zip entries overlap (a zip built to expand without limit)');
    offsets.add(e.offset);
  }
  const crcByName = new Map(central.map((e) => [e.name, e.crc]));
  let total = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_UNCOMPRESSED) throw new SkillZipError('zip expands to more than 50 MB');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof SkillZipError) throw e;
    throw new SkillZipError(`not a readable zip (${(e as Error).message})`);
  }
  const entries = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  for (const [name, data] of Object.entries(raw)) {
    const crc = crcByName.get(name);
    if (crc === undefined || (Bun.hash.crc32(data) >>> 0) !== crc) throw new SkillZipError(`zip is damaged: ${name} does not match its checksum`);
    const safe = safeName(name);
    if (!safe) continue;
    const key = safe.toLowerCase();
    if (seen.has(key)) throw new SkillZipError(`zip has two entries that are the same file on Windows: ${safe}`);
    seen.add(key);
    entries.set(safe, data);
  }
  let prefix = '';
  if (!entries.has('SKILL.md')) {
    const tops = new Set([...entries.keys()].map((n) => n.split('/')[0]));
    const top = tops.size === 1 ? [...tops][0]! : null;
    if (!top || !entries.has(`${top}/SKILL.md`)) throw new SkillZipError('zip does not contain the lark-issue-triage skill (no SKILL.md at its top or in one top folder)');
    prefix = `${top}/`;
  }
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of entries) {
    if (!name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    const parts = rel.toLowerCase().split('/');
    if (parts.includes('__pycache__') || rel.toLowerCase().endsWith('.pyc') || parts[0] === '.cache') {
      throw new SkillZipError(`zip contains ${rel}: compiled Python and local caches are never part of the skill`);
    }
    files.set(rel, data);
  }
  const head = new TextDecoder().decode(files.get('SKILL.md')!.slice(0, 2000));
  if (!SKILL_NAME.test(head)) throw new SkillZipError('the SKILL.md in this zip is not the lark-issue-triage skill');
  const v = files.get('VERSION');
  return { files, version: v ? new TextDecoder().decode(v).trim() || null : null };
}

/** Runs inspectSkillZip off the main thread, so a zip that takes too long can be stopped without freezing the dashboard. */
export function inspectInWorker(bytes: Uint8Array, timeoutMs = INSPECT_TIMEOUT_MS): Promise<{ files: Map<string, Uint8Array>; version: string | null }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./skillZipWorker.ts', import.meta.url).href);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new SkillZipError(`the zip took more than ${timeoutMs / 1000} s to unpack, so it was refused (damaged or built to expand without limit)`));
    }, timeoutMs);
    worker.onmessage = (ev: MessageEvent<{ ok: true; files: [string, Uint8Array][]; version: string | null } | { ok: false; error: string; zip: boolean }>) => {
      clearTimeout(timer);
      worker.terminate();
      const m = ev.data;
      if (m.ok) resolve({ files: new Map(m.files), version: m.version });
      else reject(m.zip ? new SkillZipError(m.error) : new Error(m.error));
    };
    worker.onerror = (ev) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(`zip check failed: ${ev.message}`));
    };
    worker.postMessage(bytes);
  });
}

/** A rename right after writing can fail while antivirus still holds a new file; a few short retries ride that out. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= 5) throw e;
      Bun.sleepSync(200 * (attempt + 1));
    }
  }
}

export interface InstallOutcome { installed: string | null; previous: string | null; needsConfirm?: boolean; sha256: string }

/**
 * Unpacks into a staging folder beside (not inside) the skills folder and swaps it in, so Claude never sees a
 * half-written copy. The per-PC settings file lives outside and is never touched; the skill's own .cache (built on this
 * PC, refused in zips) is carried over. A previous run that died between the two renames is repaired first.
 */
export async function installSkill(bytes: Uint8Array, opts: { skillDir: string; confirmOlder: boolean }): Promise<InstallOutcome> {
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  const staging = join(dirname(dirname(opts.skillDir)), '.skill-staging');
  const fresh = join(staging, 'lark-issue-triage.new');
  const old = join(staging, 'lark-issue-triage.old');
  if (!existsSync(opts.skillDir) && existsSync(old)) renameWithRetry(old, opts.skillDir);

  const { files, version } = await inspectInWorker(bytes);
  const previous = existsSync(join(opts.skillDir, 'VERSION')) ? readFileSync(join(opts.skillDir, 'VERSION'), 'utf8').trim() || null : null;
  // A zip without VERSION predates versioning, so it counts as older than anything installed.
  const older = existsSync(opts.skillDir) && (!version || (previous !== null && compareVersions(version, previous) < 0));
  if (older && !opts.confirmOlder) return { installed: null, previous, needsConfirm: true, sha256 };

  mkdirSync(staging, { recursive: true });
  rmSync(fresh, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  let swapped = false;
  try {
    for (const [name, data] of files) {
      const target = join(fresh, ...name.split('/'));
      if (!target.startsWith(fresh + sep)) throw new SkillZipError(`unsafe path in zip: ${name}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    }
    const cache = join(opts.skillDir, '.cache');
    if (existsSync(cache)) cpSync(cache, join(fresh, '.cache'), { recursive: true });
    if (existsSync(opts.skillDir)) renameWithRetry(opts.skillDir, old);
    try {
      renameWithRetry(fresh, opts.skillDir);
      swapped = true;
    } catch (e) {
      if (existsSync(old) && !existsSync(opts.skillDir)) renameWithRetry(old, opts.skillDir);
      throw e;
    }
  } finally {
    // Best effort: the install itself already succeeded or failed above; leftovers are cleared at the next install.
    try { rmSync(fresh, { recursive: true, force: true }); } catch { /* ignore */ }
    if (swapped) try { rmSync(old, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { installed: version, previous, sha256 };
}
