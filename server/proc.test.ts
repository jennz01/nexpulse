import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand, run } from './proc';

describe('run', () => {
  test('captures stdout and the exit code', async () => {
    const r = await run('bun', ['-e', 'console.log("hi"); process.exit(3)']);
    expect(r.stdout.trim()).toBe('hi');
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  test('pipes stdin to the child', async () => {
    const r = await run('bun', ['-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(s.toUpperCase()))'], { stdin: 'abc' });
    expect(r.stdout).toBe('ABC');
  });

  test('kills the child when the timeout elapses', async () => {
    const r = await run('bun', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });

  test.skipIf(process.platform !== 'win32')(
    'resolves promptly when a timeout kills a cmd.exe-routed .cmd/.bat shim',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'proc-test-'));
      const shimPath = join(dir, 'shim.cmd');
      writeFileSync(shimPath, '@echo off\r\nbun -e "setTimeout(() => {}, 10000)"\r\n');
      try {
        const start = Date.now();
        const r = await run('cmd.exe', ['/d', '/c', shimPath], { timeoutMs: 500 });
        const elapsed = Date.now() - start;
        expect(r.timedOut).toBe(true);
        expect(elapsed).toBeLessThan(3000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('resolveCommand', () => {
  test('non-windows: returns the bare command', () => {
    expect(resolveCommand('lark-cli', 'linux', () => '/usr/bin/lark-cli')).toEqual(['lark-cli']);
  });

  test('windows: an .exe is called directly', () => {
    expect(resolveCommand('gh', 'win32', () => 'C:\\Program Files\\GitHub CLI\\gh.exe')).toEqual(['C:\\Program Files\\GitHub CLI\\gh.exe']);
  });

  test('windows: a .cmd shim goes through cmd.exe', () => {
    const which = (c: string) => (c === 'lark-cli.cmd' ? 'C:\\npm\\lark-cli.cmd' : c === 'lark-cli' ? 'C:\\npm\\lark-cli' : null);
    expect(resolveCommand('lark-cli', 'win32', which)).toEqual(['cmd.exe', '/d', '/c', 'C:\\npm\\lark-cli.cmd']);
  });

  test('windows: unknown command falls through unchanged', () => {
    expect(resolveCommand('nope', 'win32', () => null)).toEqual(['nope']);
  });
});
