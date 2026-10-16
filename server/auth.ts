import type { Subprocess } from 'bun';
import type { AuthProvider, AuthStatus, LoginState, ProviderStatus } from '../shared/types';
import { isUnsetGithubAccount } from './config';
import { cliMessage, isNotConfigured, killTree, resolveCommand, run } from './proc';
import type { Runner } from './sources/types';

export interface AuthOptions {
  /** The gh login the GitHub source expects (config `github.account`); unset on a fresh install until the first sign-in fills it. */
  githubAccount: string;
  /** Called when the config has no GitHub account yet and gh turns out to be signed in: the host saves `login` as `github.account`. */
  onAdoptGithubAccount?: (login: string) => void | Promise<void>;
  log?: (line: string) => void;
  /** Called after a sign-in completes, so the host can re-enable and refresh the matching source. */
  onLogin?: (provider: AuthProvider) => void | Promise<void>;
  runner?: Runner;
}

const STATUS_TTL_MS = 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? '';
const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
const AUTH_ERROR = /auth login|not logged|authentication|token|HTTP 401|unauthori[sz]ed|expired/i;

/**
 * What NexPulse and the lark-issue-triage skill read through lark-cli, plus offline_access so Lark issues a refresh token
 * and the session renews itself instead of lapsing after about 2 hours. Asking for everything (`--domain all`) made Lark
 * answer with a long "not granted" list for scopes the app never enabled. Lark sign-ins add up, so scopes granted for
 * other tools stay.
 */
export const LARK_SCOPES = [
  'base:app:read', 'base:table:read', 'base:view:read', 'base:field:read', 'base:record:read',
  'docs:document.comment:read', 'docs:document.media:download',
  'contact:user.base:readonly', 'contact:user.basic_profile:readonly', 'auth:user.id:read',
  'offline_access',
];

/** lark-cli's final word on a sign-in: whether it completed, and which requested scopes Lark left out. */
export function larkLoginResult(output: string): { complete: boolean; missing: string[] } {
  const candidates = [output.trim(), ...output.split(/\r?\n/).map((line) => line.trim())].filter((s) => s.startsWith('{'));
  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate) as Record<string, unknown>;
      const data = (json.data && typeof json.data === 'object' ? json.data : json) as Record<string, unknown>;
      if (data.event === 'authorization_complete') {
        return { complete: true, missing: Array.isArray(data.missing) ? data.missing.filter((s): s is string => typeof s === 'string') : [] };
      }
    } catch { /* not the result object */ }
  }
  return { complete: false, missing: [] };
}

/** One plain sentence about scopes NexPulse relies on that Lark did not grant; null when none of them is missing. */
export function larkScopeWarning(missing: string[]): string | null {
  const needed = missing.filter((s) => LARK_SCOPES.includes(s));
  if (needed.length === 0) return null;
  const parts: string[] = [];
  if (needed.includes('offline_access')) parts.push('Lark will not renew this sign-in, so it lapses in about 2 hours (offline_access is not enabled on this PC\'s Lark app)');
  const others = needed.filter((s) => s !== 'offline_access');
  if (others.length) parts.push(`the dashboard reads with these scopes, which were not granted: ${others.join(', ')}`);
  return `Signed in, but ${parts.join('; and ')}. Enable ${needed.length > 1 ? 'them' : 'it'} in the Lark Developer Console (your app › Permissions & Scopes), publish a new app version, then authorize again.`;
}

interface Flow { state: LoginState; proc: Subprocess | null; timer: ReturnType<typeof setTimeout> | null }
const idle = (): Flow => ({ state: { phase: 'idle' }, proc: null, timer: null });
/** lark-cli has never been set up on this PC (`lark-cli config init`): the dialog shows the one-time steps instead of a code. */
class NotConfiguredError extends Error {}

/**
 * Owns the two CLI sessions the sources depend on. `status()` asks gh and lark-cli who is signed in (cached for a
 * minute). A sign-in is a device-code flow the server drives: gh prints its one-time code and waits until the user
 * finishes in the browser; lark-cli hands out a code with --no-wait and a second call polls until it is approved.
 * One flow per provider at a time; the browser reads its progress from `login()`. While the config has no GitHub account,
 * the first login gh reports is adopted and handed to `onAdoptGithubAccount` to save.
 */
export class AuthManager {
  private cache: { at: number; value: AuthStatus } | null = null;
  private readonly flows: Record<AuthProvider, Flow> = { github: idle(), lark: idle() };
  private larkScope: string | null = null;
  private readonly runner: Runner;

  constructor(private readonly opts: AuthOptions) {
    this.runner = opts.runner ?? run;
  }

  async status(fresh = false): Promise<AuthStatus> {
    if (!fresh && this.cache && Date.now() - this.cache.at < STATUS_TTL_MS) return this.cache.value;
    const [github, lark] = await Promise.all([this.githubStatus(), this.larkStatus()]);
    const value: AuthStatus = { github, lark, checkedAt: Date.now() };
    this.cache = { at: value.checkedAt, value };
    return value;
  }

  invalidate(): void { this.cache = null; }

  login(provider: AuthProvider): LoginState { return this.flows[provider].state; }

  async startLogin(provider: AuthProvider): Promise<LoginState> {
    const flow = this.flows[provider];
    if (flow.state.phase === 'starting' || flow.state.phase === 'waiting') return flow.state;
    flow.state = { phase: 'starting', startedAt: Date.now() };
    try {
      if (provider === 'github') await this.startGithub(flow);
      else await this.startLark(flow);
    } catch (e) {
      this.clear(flow);
      flow.state = { ...flow.state, phase: 'failed', message: (e as Error).message, ...(e instanceof NotConfiguredError ? { unconfigured: true } : {}) };
    }
    return flow.state;
  }

  cancelLogin(provider: AuthProvider): LoginState {
    const flow = this.flows[provider];
    this.clear(flow);
    flow.state = { phase: 'idle' };
    return flow.state;
  }

  /** `gh auth switch` to the configured account, then re-check and re-enable the GitHub source. */
  async switchGithub(): Promise<AuthStatus> {
    const res = await this.runner('gh', ['auth', 'switch', '--user', this.opts.githubAccount], { timeoutMs: 20_000 });
    if (res.code !== 0) throw new Error(firstLine(res.stderr || res.stdout) || `gh auth switch exited ${res.code}`);
    this.invalidate();
    await this.opts.onLogin?.('github');
    return this.status(true);
  }

  // ---- status ----

  private async githubStatus(): Promise<ProviderStatus> {
    const expected = this.opts.githubAccount;
    const res = await this.runner('gh', ['api', 'user', '-q', '.login'], { timeoutMs: 20_000 });
    if (res.timedOut) return { state: 'unknown', account: null, expected, detail: 'gh did not answer within 20 s' };
    if (res.code !== 0) {
      const text = cliMessage(res.stderr || res.stdout, `gh exited ${res.code}`);
      return { state: AUTH_ERROR.test(text) ? 'expired' : 'unknown', account: null, expected, detail: text };
    }
    const login = res.stdout.trim();
    if (isUnsetGithubAccount(expected)) {
      // First sign-in on this PC: the config has no account yet, so the one gh reports becomes it.
      this.opts.githubAccount = login;
      try { await this.opts.onAdoptGithubAccount?.(login); } catch (e) { this.opts.log?.(`github: signed in as ${login} but could not save it to the config: ${(e as Error).message}`); }
      return { state: 'ok', account: login, expected: login, detail: null };
    }
    if (login !== expected) return { state: 'wrong-account', account: login, expected, detail: `gh is signed in as ${login}; the dashboard tracks ${expected}` };
    return { state: 'ok', account: login, expected, detail: null };
  }

  private async larkStatus(): Promise<ProviderStatus> {
    const res = await this.runner('lark-cli', ['auth', 'status', '--verify'], { timeoutMs: 30_000 });
    if (res.timedOut) return { state: 'unknown', account: null, detail: 'lark-cli did not answer within 30 s' };
    let json: { identities?: { user?: Record<string, unknown> } } | null = null;
    try { json = JSON.parse(res.stdout); } catch { json = null; }
    const user = json?.identities?.user;
    if (!user) {
      const raw = `${res.stderr}\n${res.stdout}`;
      if (isNotConfigured(raw)) return { state: 'unconfigured', account: null, detail: 'lark-cli has no Lark app configured on this PC yet (one-time `lark-cli config init`)' };
      const text = cliMessage(raw, `lark-cli exited ${res.code}`);
      return { state: res.code === 0 ? 'missing' : AUTH_ERROR.test(text) ? 'expired' : 'unknown', account: null, detail: text };
    }
    if (typeof user.scope === 'string' && user.scope) this.larkScope = user.scope;
    const ok = user.verified === true || user.tokenStatus === 'valid' || user.status === 'ready';
    return {
      state: ok ? 'ok' : 'expired',
      account: typeof user.userName === 'string' ? user.userName : null,
      sessionUntil: typeof user.refreshExpiresAt === 'string' ? user.refreshExpiresAt : null,
      detail: ok ? null : (typeof user.message === 'string' ? user.message : 'Lark session expired'),
    };
  }

  // ---- sign-in flows ----

  private async startGithub(flow: Flow): Promise<void> {
    const proc = this.spawn(['gh', 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key']);
    flow.proc = proc;
    let text = '';
    this.pump(proc, (chunk) => {
      text += chunk;
      if (flow.state.phase !== 'starting') return;
      const code = /one-time code:\s*([A-Z0-9-]{6,})/i.exec(text)?.[1];
      if (code) flow.state = { ...flow.state, phase: 'waiting', code, url: /https:\/\/github\.com\/login\/device\S*/.exec(text)?.[0] ?? 'https://github.com/login/device' };
    });
    this.arm('github', flow);
    void proc.exited.then((code) => this.onExit('github', flow, proc, code, () => text));
  }

  private async startLark(flow: Flow): Promise<void> {
    if (!this.larkScope) await this.larkStatus(); // learn the current token's scopes so a re-login keeps them
    // What the dashboard needs plus what the session already has, comma-separated (no spaces: lark-cli runs through a
    // cmd.exe shim on Windows). Never `--domain all`: Lark would list every scope the app lacks as "not granted".
    const scopes = new Set([...LARK_SCOPES, ...(this.larkScope ?? '').split(/\s+/).filter(Boolean)]);
    const scopeArgs = ['--scope', [...scopes].join(',')];
    const res = await this.runner('lark-cli', ['auth', 'login', '--no-wait', '--json', ...scopeArgs], { timeoutMs: 60_000 });
    if (res.timedOut) throw new Error('lark-cli did not start the sign-in within 60 s');
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(res.stdout); } catch { json = null; }
    if (!json || json.ok === false) {
      const raw = `${res.stderr}\n${res.stdout}`;
      if (isNotConfigured(raw)) throw new NotConfiguredError('lark-cli has no Lark app configured on this PC yet. Run `lark-cli config init --brand lark` once in a terminal, then try again.');
      throw new Error(cliMessage(raw, `lark-cli exited ${res.code}`));
    }
    const data = (json.data && typeof json.data === 'object' ? json.data : json) as Record<string, unknown>;
    const deviceCode = str(data.device_code) ?? str(data.deviceCode);
    const url = str(data.verification_url) ?? str(data.verificationUrl) ?? str(data.verification_uri);
    if (!deviceCode) throw new Error(`lark-cli returned no device code (${JSON.stringify(data).slice(0, 160)})`);
    let code = str(data.user_code) ?? str(data.userCode);
    if (!code && url) { try { code = new URL(url).searchParams.get('user_code') ?? undefined; } catch { /* keep undefined */ } }
    flow.state = { ...flow.state, phase: 'waiting', code, url };
    const proc = this.spawn(['lark-cli', 'auth', 'login', '--device-code', deviceCode, '--json']);
    flow.proc = proc;
    let text = '';
    this.pump(proc, (chunk) => { text += chunk; });
    this.arm('lark', flow);
    void proc.exited.then((code) => this.onExit('lark', flow, proc, code, () => text));
  }

  private async onExit(provider: AuthProvider, flow: Flow, proc: Subprocess, code: number, output: () => string): Promise<void> {
    if (flow.proc !== proc) return; // cancelled or superseded
    this.clear(flow);
    const text = output();
    // lark-cli exits non-zero when any requested scope was refused, even though the sign-in itself completed.
    const lark = provider === 'lark' ? larkLoginResult(text) : null;
    const failed = !lark?.complete && (code !== 0 || /"ok"\s*:\s*false/.test(text));
    if (failed) {
      flow.state = { ...flow.state, phase: 'failed', message: lastLine(text.replace(/\{[\s\S]*\}/, (m) => { try { return String((JSON.parse(m) as { error?: { message?: string } }).error?.message ?? m); } catch { return m; } })) || `${provider === 'github' ? 'gh' : 'lark-cli'} exited ${code}` };
      this.opts.log?.(`${provider}: sign-in failed: ${flow.state.message}`);
      return;
    }
    this.invalidate();
    const warning = lark ? larkScopeWarning(lark.missing) : null;
    flow.state = { ...flow.state, phase: 'done', ...(warning ? { warning } : {}) };
    this.opts.log?.(`${provider}: sign-in completed${warning ? ` (${warning})` : ''}`);
    try { await this.opts.onLogin?.(provider); } catch (e) { this.opts.log?.(`${provider}: post-login refresh failed: ${(e as Error).message}`); }
  }

  private spawn(argv: string[]): Subprocess {
    const proc = Bun.spawn([...resolveCommand(argv[0]!), ...argv.slice(1)], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: process.env });
    proc.stdin.end(); // gh would otherwise wait for an Enter that never comes
    return proc;
  }

  /** Streams stdout and stderr into `onChunk` as they arrive; the sign-in code shows up long before the process exits. */
  private pump(proc: Subprocess, onChunk: (chunk: string) => void): void {
    const read = async (stream: unknown) => {
      if (!stream || typeof (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') return;
      const dec = new TextDecoder();
      for await (const chunk of stream as AsyncIterable<Uint8Array>) onChunk(dec.decode(chunk, { stream: true }));
    };
    void read(proc.stdout);
    void read(proc.stderr);
  }

  private arm(provider: AuthProvider, flow: Flow): void {
    flow.timer = setTimeout(() => {
      if (!flow.proc) return;
      this.clear(flow);
      flow.state = { ...flow.state, phase: 'failed', message: 'Timed out after 15 minutes waiting for the browser step' };
      this.opts.log?.(`${provider}: sign-in timed out`);
    }, LOGIN_TIMEOUT_MS);
  }

  private clear(flow: Flow): void {
    if (flow.timer) clearTimeout(flow.timer);
    flow.timer = null;
    if (flow.proc) killTree(flow.proc);
    flow.proc = null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
