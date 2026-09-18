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
function killTree(proc: Subprocess): void {
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
