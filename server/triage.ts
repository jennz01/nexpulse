import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LarkSnapshot, TriageSetupInfo, TriageStatus } from '../shared/types';
import type { Runner } from './sources/types';
import type { TriageSessionRow } from './store';
import { sessionsDirFor } from './triageSetup';

/** Open triage tabs allowed at once. A session stays open after the report, so this counts tabs, not work in progress. */
export const MAX_TRIAGE = 3;
/**
 * wt.exe exiting cleanly does not mean the tab ran: a cold start with "restore last session" on reopened an old tab and
 * dropped the new one. A launch only counts once its own claude.exe shows in the process list, within this long.
 */
const CONFIRM_MS = 25_000;
const CONFIRM_POLL_MS = 1_500;
const RECORD_ID = /^rec[A-Za-z0-9]{4,40}$/;
/** What marks a triage in claude.exe's command line: the skill call for a new one, the session id the dashboard gave it for a resumed one. */
const SKILL_MARK = /\/lark-issue-triage (rec[A-Za-z0-9]+)/g;
const SESSION_MARK = /--(?:session-id|resume)[ =]"?([0-9a-f-]{36})/gi;
/** Variables that would bill an API key or another provider instead of the Claude subscription; cleared inside the tab. */
const NOT_SUBSCRIPTION = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const NO_TERMINAL = 'Windows Terminal not found: install it from the Microsoft Store';

export class TriageError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502) { super(message); }
}

export interface TriageSessions {
  save(row: TriageSessionRow): void;
  all(): TriageSessionRow[];
}

/**
 * Opens the lark-issue-triage skill for one issue in an interactive `claude` tab in Windows Terminal, on the
 * subscription login, or resumes the issue's last session. Where sessions start comes from the skill's own per-PC
 * settings, read fresh on every call. Each new session gets an id chosen here and remembered with its folder, so it can
 * be resumed and recognised later. Open sessions are found by their command line rather than remembered, so the count
 * survives a dashboard restart and drops as soon as a tab is closed.
 */
export class TriageLauncher {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private run: Runner,
    private issues: () => LarkSnapshot['issues'] | null,
    private sessions: TriageSessions,
    private setup: () => TriageSetupInfo,
    private now: () => number = Date.now,
  ) {}

  async status(): Promise<TriageStatus> {
    const s = this.setup();
    const open = s.setup === 'ready' ? await this.openIds() : [];
    return { open, max: MAX_TRIAGE, last: s.setup === 'ready' ? this.lastSessions(s.workdir) : {}, setup: s.setup, reason: s.reason };
  }

  /** Serialised, so two quick clicks cannot both see a free slot. */
  start(recordId: string): Promise<TriageStatus> {
    return this.locked(() => this.launch(recordId, false));
  }

  /** Reopens the issue's most recent session with its whole conversation. */
  resume(recordId: string): Promise<TriageStatus> {
    return this.locked(() => this.launch(recordId, true));
  }

  /** Opens the skill's setup conversation in the home folder; not counted toward the cap, no record involved. */
  async openSetup(): Promise<void> {
    const s = this.setup();
    if (s.setup === 'no-skill') throw new TriageError('Install the lark-issue-triage skill first (Settings › Issue triage)', 409);
    await this.openTab('Triage setup', homedir(), `& claude '/lark-issue-triage setup'`);
  }

  private locked(fn: () => Promise<TriageStatus>): Promise<TriageStatus> {
    const next = this.lock.then(fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** Rows saved before the folder was recorded fall back to the current working folder. */
  private sessionExists(row: TriageSessionRow, fallback: string | null): boolean {
    const dir = row.workdir ?? fallback;
    return !!dir && existsSync(join(sessionsDirFor(dir), `${row.sessionId}.jsonl`));
  }

  /** Newest session per issue that Claude actually wrote; a launch that failed early never hides an older, resumable one. */
  private latest(workdir: string | null): Map<string, TriageSessionRow> {
    const out = new Map<string, TriageSessionRow>();
    for (const row of this.sessions.all()) if (this.sessionExists(row, workdir)) out.set(row.recordId, row); // oldest first, so the newest wins
    return out;
  }

  private lastSessions(workdir: string | null): Record<string, number> {
    return Object.fromEntries([...this.latest(workdir)].map(([id, row]) => [id, row.startedAt]));
  }

  private async launch(recordId: string, resume: boolean): Promise<TriageStatus> {
    const s = this.setup();
    if (s.setup !== 'ready' || !s.workdir) throw new TriageError(`Triage isn't ready on this PC: ${s.reason}`, 409);
    if (!RECORD_ID.test(recordId)) throw new TriageError('bad record reference', 400);
    const record = this.issues()?.groups.flatMap((g) => g.records).find((r) => r.recordId === recordId);
    if (!record) throw new TriageError('not an issue in the current Lark view', 404);
    const previous = resume ? this.latest(s.workdir).get(recordId) : undefined;
    if (resume && !previous) throw new TriageError('no earlier triage session to resume for this issue', 404);
    const open = await this.openIds();
    if (open.includes(recordId)) throw new TriageError('a triage session for this issue is already open', 409);
    if (open.length >= MAX_TRIAGE) throw new TriageError(`${open.length} of ${MAX_TRIAGE} triage sessions open: close one to start another`, 409);

    // The ticket id only labels the tab, and wt.exe treats ; as a command separator, so it is cut down to safe characters.
    const label = (record.fields.ticketId || recordId).replace(/[^#A-Za-z0-9-]/g, '');
    if (previous) {
      const dir = previous.workdir ?? s.workdir;
      if (!existsSync(dir)) throw new TriageError(`working folder ${dir} of the earlier session no longer exists: start a new triage instead`, 409);
      await this.openTab(`Triage ${label} (resumed)`, dir, `& claude --resume ${previous.sessionId}`);
    } else {
      // Recorded before the launch so the confirm loop below can already tell this session apart.
      const sessionId = randomUUID();
      this.sessions.save({ sessionId, recordId, startedAt: this.now(), workdir: s.workdir });
      await this.openTab(`Triage ${label}`, s.workdir, `& claude --session-id ${sessionId} '/lark-issue-triage ${recordId}'`);
    }
    // Still under the lock, so a second click waits for this one to be confirmed before it counts the open sessions.
    const until = this.now() + CONFIRM_MS;
    while (this.now() < until) {
      await Bun.sleep(CONFIRM_POLL_MS);
      const now = await this.openIds();
      if (now.includes(recordId)) return { open: now, max: MAX_TRIAGE, last: this.lastSessions(s.workdir), setup: s.setup, reason: s.reason };
    }
    throw new TriageError(`Windows Terminal opened, but no Claude session for ${label} started within ${CONFIRM_MS / 1000} s`, 502);
  }

  /** An encoded command keeps quoting and wt.exe's own ; parsing out of the way; every value in it is checked or made here. */
  private async openTab(title: string, dir: string, claudeLine: string): Promise<void> {
    const script = [`Remove-Item ${NOT_SUBSCRIPTION.map((v) => `Env:${v}`).join(', ')} -ErrorAction SilentlyContinue`, claudeLine].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    // Launched, not looked up first: wt.exe is an App Execution Alias that Bun.which cannot see, though Windows starts it fine.
    const res = await this.run('wt', [
      '-w', '0', 'nt', '--title', title, '--suppressApplicationTitle', '-d', dir,
      'powershell', '-NoProfile', '-EncodedCommand', encoded,
    ], { timeoutMs: 15_000 }).catch((e: unknown) => {
      if ((e as { code?: string }).code === 'ENOENT') throw new TriageError(NO_TERMINAL, 502);
      throw e;
    });
    if (res.code !== 0) throw new TriageError(`Windows Terminal did not start (${res.stderr.trim() || `exit ${res.code}`})`, 502);
  }

  /** Record ids with a triage session open, read from the live claude.exe processes. */
  private async openIds(): Promise<string[]> {
    const res = await this.run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      // npm installs of Claude Code run as node.exe; the markers below only match triage sessions either way.
      `Get-CimInstance Win32_Process -Filter "Name='claude.exe' OR Name='node.exe'" | ForEach-Object { $_.CommandLine }`,
    // PowerShell's own start-up is most of the 2 s this usually takes; with triage sessions running and RAM short it passed 15 s.
    ], { timeoutMs: 45_000 });
    if (res.code !== 0) throw new TriageError(`could not list Claude sessions (${res.stderr.trim() || `exit ${res.code}`})`, 502);
    const bySession = new Map(this.sessions.all().map((r) => [r.sessionId.toLowerCase(), r.recordId]));
    const ids = new Set([...res.stdout.matchAll(SKILL_MARK)].map((m) => m[1]!));
    for (const m of res.stdout.matchAll(SESSION_MARK)) {
      const id = bySession.get(m[1]!.toLowerCase());
      if (id) ids.add(id);
    }
    return [...ids];
  }
}
