import type { Subprocess } from 'bun';

export interface RunResult {
  stdout: string;
  stderr: string;
  /** exit code; -1 if the process died without one (killed) */
  code: number;
  timedOut: boolean;
}
export interface RunOptions {
  timeoutMs?: number;
  stdin?: string;
  cwd?: string;
}

/**
 * npm-installed CLIs on Windows (lark-cli) are `.cmd` shims that only cmd.exe can execute.
 * Native executables (gh.exe, bun.exe) are spawned directly. Elsewhere the name is used as-is.
 */
export function resolveCommand(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  which: (c: string) => string | null = (c) => Bun.which(c),
): string[] {
  if (platform !== 'win32') return [cmd];
  const direct = which(cmd);
  if (direct && /\.exe$/i.test(direct)) return [direct];
  const shim = direct && /\.(cmd|bat)$/i.test(direct) ? direct : which(`${cmd}.cmd`);
  if (shim) return ['cmd.exe', '/d', '/c', shim];
  return [direct ?? cmd];
}

/**
 * Kills the whole process tree rooted at `proc`. On Windows, `proc.kill()` only terminates
 * the immediate child; when that child is a cmd.exe launched to run a .cmd/.bat shim, the
 * shim's own grandchild keeps running and keeps the inherited stdout/stderr pipes open,
 * which would otherwise hang `run()` forever. `taskkill /T` kills the whole tree; `proc.kill()`
 * is kept as a fallback in case taskkill is unavailable or fails.
 */
export function killTree(proc: Subprocess): void {
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill', '/PID', String(proc.pid), '/T', '/F']);
  }
  proc.kill();
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const argv = [...resolveCommand(cmd), ...args];
  // stdin is always piped so `proc.stdin` is a FileSink for TypeScript; an empty pipe is closed at once.
  const proc = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd: opts.cwd, env: process.env });
  if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
  proc.stdin.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const collect: Promise<RunResult> = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({
      stdout,
      stderr,
      code: typeof code === 'number' ? code : -1,
      timedOut: false,
    }));
    const timeout: Promise<RunResult> = new Promise((resolve) => {
      timer = setTimeout(() => {
        killTree(proc);
        resolve({ stdout: '', stderr: '', code: -1, timedOut: true });
      }, opts.timeoutMs ?? 60_000);
    });
    return await Promise.race([collect, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The `{ ok: false, error: { type, subtype, message, hint } }` envelope lark-cli (and sometimes gh) prints, pretty-printed, to stderr; null when the text holds none. */
export function cliEnvelope(text: string): { type?: string; subtype?: string; message?: string; hint?: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const json = JSON.parse(text.slice(start, end + 1)) as { error?: unknown; message?: unknown; msg?: unknown };
    const err = (json.error && typeof json.error === 'object' ? json.error : {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    const message = str(err.message) ?? str(json.message) ?? str(json.msg);
    if (!message && !str(err.type)) return null;
    return { type: str(err.type), subtype: str(err.subtype), message, hint: str(err.hint) };
  } catch {
    return null;
  }
}

/** One human line out of a CLI's output: the envelope's message when there is one, else the first line that is not a lone brace. */
export function cliMessage(text: string, fallback: string): string {
  const env = cliEnvelope(text);
  if (env?.message) return env.message;
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && l !== '{' && l !== '}');
  return line ?? fallback;
}

/** lark-cli before its one-time `lark-cli config init` on this PC: every command fails with a not_configured envelope. */
export function isNotConfigured(text: string): boolean {
  const env = cliEnvelope(text);
  if (env) return env.subtype === 'not_configured' || (env.type === 'config' && /not configured/i.test(env.message ?? ''));
  return /not configured/i.test(text) && /config init/i.test(text);
}
