import { existsSync, mkdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { LarkConfig, LarkTableKey } from './config';
import { run } from './proc';
import type { Runner } from './sources/types';

/**
 * Base attachments have no public URL: only lark-cli, with the user's session, can download them. Files are
 * cached under data/attachments by file token (tokens never change), so a record opened twice costs one
 * download. lark-cli accepts an --output only inside its working directory, so it runs with cwd = the cache dir.
 */
export class LarkAttachments {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly cfg: LarkConfig, private readonly dir: string, private readonly runner: Runner = run) {
    mkdirSync(dir, { recursive: true });
  }

  /** Local path of the cached file, downloading it first when needed. Concurrent requests share one download. */
  fetch(table: LarkTableKey, recordId: string, token: string, name: string): Promise<string> {
    const file = `${token}${safeExt(name)}`;
    const path = resolve(this.dir, file);
    const running = this.inflight.get(file);
    if (running) return running;
    if (existsSync(path)) return Promise.resolve(path);
    const job = this.download(table, recordId, token, file).then(() => path).finally(() => this.inflight.delete(file));
    this.inflight.set(file, job);
    return job;
  }

  /** The attachment as an HTTP response; its content type comes from the file name the Base recorded. */
  async response(table: LarkTableKey, recordId: string, token: string, name: string, range?: string | null): Promise<Response> {
    const path = await this.fetch(table, recordId, token, name);
    return fileResponse(path, Bun.file(`x${safeExt(name)}`).type.split(';')[0] ?? '', name, range);
  }

  private async download(table: LarkTableKey, recordId: string, token: string, file: string): Promise<void> {
    const t = this.cfg.tables[table];
    const res = await this.runner('lark-cli', [
      'base', '+record-download-attachment',
      '--base-token', this.cfg.baseToken, '--table-id', t.tableId, '--record-id', recordId, '--file-token', token,
      '--output', `./${file}`, '--overwrite', '--as', 'user', '--format', 'json',
    ], { cwd: this.dir, timeoutMs: 120_000 });
    if (res.timedOut) throw new Error('lark-cli timed out downloading the attachment');
    if (res.code !== 0) throw new Error(`lark-cli exited ${res.code}: ${(res.stderr || res.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
    if (!existsSync(resolve(this.dir, file))) throw new Error('lark-cli reported success but the file is missing');
  }
}

/**
 * Images pasted into a record comment are Drive media, not Base attachments: a different endpoint, and the token
 * arrives with no file name and no declared type. They are cached by token all the same, since media tokens never
 * change either.
 */
export class LarkCommentImages {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly dir: string, private readonly runner: Runner = run) {
    mkdirSync(dir, { recursive: true });
  }

  /** Local path of the cached image, downloading it first when needed. Concurrent requests share one download. */
  fetch(token: string): Promise<string> {
    const file = `comment-${token}`;
    const path = resolve(this.dir, file);
    const running = this.inflight.get(file);
    if (running) return running;
    if (existsSync(path)) return Promise.resolve(path);
    const job = this.download(token, file).then(() => path).finally(() => this.inflight.delete(file));
    this.inflight.set(file, job);
    return job;
  }

  /**
   * The image as an HTTP response. Nothing here is taken on trust: the content type is read from the file's own
   * magic bytes, so a token that turns out not to be an image downloads as an opaque binary instead of rendering.
   */
  async response(token: string): Promise<Response> {
    const path = await this.fetch(token);
    const head = new Uint8Array(await Bun.file(path).slice(0, 16).arrayBuffer());
    const type = sniffImage(head);
    return fileResponse(path, type ?? '', `${token}${type ? IMAGE_EXT[type] : '.bin'}`, null);
  }

  private async download(token: string, file: string): Promise<void> {
    const res = await this.runner('lark-cli', [
      'api', 'GET', `/open-apis/drive/v1/medias/${token}/download`,
      '--as', 'user', '--format', 'json', '-o', `./${file}`,
    ], { cwd: this.dir, timeoutMs: 120_000 });
    if (res.timedOut) throw new Error('lark-cli timed out downloading the comment image');
    if (res.code !== 0) throw new Error(`lark-cli exited ${res.code}: ${(res.stderr || res.stdout).trim().split(/\r?\n/)[0] ?? ''}`);
    if (!existsSync(resolve(this.dir, file))) throw new Error('lark-cli reported success but the file is missing');
  }
}

/** The image types magic-byte sniffing recognises, and the extension each one gives the served file name. */
const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/avif': '.avif',
};

/** The content type of an image read from its first 16 bytes, or null when those bytes are not an image this serves. */
export function sniffImage(head: Uint8Array): string | null {
  const bytes = (i: number, ...want: number[]): boolean => want.every((v, k) => head[i + k] === v);
  const ascii = (i: number, s: string): boolean => [...s].every((ch, k) => head[i + k] === ch.charCodeAt(0));
  if (bytes(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (bytes(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM')) return 'image/bmp';
  if (ascii(4, 'ftyp') && (ascii(8, 'avif') || ascii(8, 'avis'))) return 'image/avif';
  return null;
}

/**
 * A cached file as an HTTP response. These are other people's uploads served on the dashboard's own origin, so
 * only image, video and PDF types render inline; anything else (HTML, SVG, XML, scripts, unknown) is forced to
 * download as an opaque binary so it can never execute against the API. Inline files honour a single byte range
 * (`Range: bytes=a-b`), which the browser's video player needs to seek.
 */
export function fileResponse(path: string, type: string, name: string, range?: string | null): Response {
  const inline = INLINE_TYPES.has(type);
  const filename = name.replace(/[^\w.\- ()]+/g, '_');
  const headers: Record<string, string> = {
    'content-type': inline ? type : 'application/octet-stream',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=86400',
  };
  if (!inline) headers['content-security-policy'] = "sandbox; default-src 'none'";
  const file = Bun.file(path);
  const size = file.size;
  const m = inline && range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && size > 0) {
    headers['accept-ranges'] = 'bytes';
    let start = m[1] ? Number(m[1]) : Number.NaN;
    let end = m[2] ? Number(m[2]) : size - 1;
    if (Number.isNaN(start)) { start = Math.max(0, size - Number(m[2])); end = size - 1; } // suffix form "-N": the last N bytes
    end = Math.min(end, size - 1);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
  }
if (inline) headers['accept-ranges'] = 'bytes';
return new Response(file, { headers });
}

/** Content types the browser may render in the tab; everything else downloads. SVG and HTML are deliberately absent. */
export const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v',
  'application/pdf',
]);

/** ".png" from "image.png"; only a short alphanumeric extension survives, so the cache file name stays safe. */
export function safeExt(name: string): string {
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}
