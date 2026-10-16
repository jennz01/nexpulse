import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LarkSnapshot, TriageStatus } from '../shared/types';
import type { Runner } from './sources/types';
import type { TriageSessionRow } from './store';

/** The folder every triage session starts in: the parent of the repos the skill reads, so `claude --resume` finds them there. */
export const TRIAGE_DIR = 'D:\\work';
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
const NOT_SUBSCRIPTION = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
/** Claude Code keeps a folder's sessions under its path with every other character turned into '-': D:\work -> D--work. */
const SESSIONS_DIR = join(homedir(), '.claude', 'projects', TRIAGE_DIR.replace(/[^A-Za-z0-9]/g, '-'));
const hasSessionFile = (sessionId: string): boolean => existsSync(join(SESSIONS_DIR, `${sessionId}.jsonl`));

export class TriageError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502) { super(message); }
}

export interface TriageSessions {
  save(row: TriageSessionRow): void;
  all(): TriageSessionRow[];
}

/**
 * Opens the lark-issue-triage skill for one issue in an interactive `claude` tab in Windows Terminal, on the
 * subscription login, or resumes the issue's last session. Each new session gets an id chosen here and remembered, so
 * it can be resumed and recognised later. Open sessions are found by their command line rather than remembered, so the
 * count survives a dashboard restart and drops as soon as a tab is closed.
 */
export class TriageLauncher {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private run: Runner,
    private issues: () => LarkSnapshot['issues'] | null,
    private sessions: TriageSessions,
    private sessionExists: (sessionId: string) => boolean = hasSessionFile,
    private now: () => number = Date.now,
  ) {}

  async status(): Promise<TriageStatus> {
    return { open: await this.openIds(), max: MAX_TRIAGE, last: this.lastSessions() };
  }

  /** Serialised, so two quick clicks cannot both see a free slot. */
  start(recordId: string): Promise<TriageStatus> {
    return this.locked(() => this.launch(recordId, false));
  }

  /** Reopens the issue's most recent session with its whole conversation. */
  resume(recordId: string): Promise<TriageStatus> {
    return this.locked(() => this.launch(recordId, true));
  }

  private locked(fn: () => Promise<TriageStatus>): Promise<TriageStatus> {
    const next = this.lock.then(fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** Latest session per issue, kept only when Claude wrote its file (a launch that failed early has nothing to resume). */
  private latest(): Map<string, TriageSessionRow> {
    const out = new Map<string, TriageSessionRow>();
    for (const row of this.sessions.all()) out.set(row.recordId, row); // oldest first, so the last write wins
    for (const [id, row] of out) if (!this.sessionExists(row.sessionId)) out.delete(id);
    return out;
  }

  private lastSessions(): Record<string, number> {
    return Object.fromEntries([...this.latest()].map(([id, row]) => [id, row.startedAt]));
  }

  private async launch(recordId: string, resume: boolean): Promise<TriageStatus> {
    if (!RECORD_ID.test(recordId)) throw new TriageError('bad record reference', 400);
    const record = this.issues()?.groups.flatMap((g) => g.records).find((r) => r.recordId === recordId);
    if (!record) throw new TriageError('not an issue in the current Lark view', 404);
    const previous = resume ? this.latest().get(recordId) : undefined;
    if (resume && !previous) throw new TriageError('no earlier triage session to resume for this issue', 404);
    const open = await this.openIds();
    if (open.includes(recordId)) throw new TriageError('a triage session for this issue is already open', 409);
    if (open.length >= MAX_TRIAGE) throw new TriageError(`${open.length} of ${MAX_TRIAGE} triage sessions open: close one to start another`, 409);

    // The ticket id only labels the tab, and wt.exe treats ; as a command separator, so it is cut down to safe characters.
    const label = (record.fields.ticketId || recordId).replace(/[^#A-Za-z0-9-]/g, '');
    let claude: string;
    if (previous) {
      claude = `& claude --resume ${previous.sessionId}`;
    } else {
      // Recorded before the launch so the confirm loop below can already tell this session apart.
      const sessionId = randomUUID();
      this.sessions.save({ sessionId, recordId, startedAt: this.now() });
      claude = `& claude --session-id ${sessionId} '/lark-issue-triage ${recordId}'`;
    }
    // An encoded command keeps quoting and wt.exe's own ; parsing out of the way; recordId and the uuid are checked or made here.
    const script = [`Remove-Item ${NOT_SUBSCRIPTION.map((v) => `Env:${v}`).join(', ')} -ErrorAction SilentlyContinue`, claude].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const res = await this.run('wt', [
      '-w', '0', 'nt', '--title', `Triage ${label}${previous ? ' (resumed)' : ''}`, '--suppressApplicationTitle', '-d', TRIAGE_DIR,
      'powershell', '-NoProfile', '-EncodedCommand', encoded,
    ], { timeoutMs: 15_000 });
    if (res.code !== 0) throw new TriageError(`Windows Terminal did not start (${res.stderr.trim() || `exit ${res.code}`})`, 502);
    // Still under the lock, so a second click waits for this one to be confirmed before it counts the open sessions.
    const until = this.now() + CONFIRM_MS;
    while (this.now() < until) {
      await Bun.sleep(CONFIRM_POLL_MS);
      const now = await this.openIds();
      if (now.includes(recordId)) return { open: now, max: MAX_TRIAGE, last: this.lastSessions() };
    }
    throw new TriageError(`Windows Terminal opened, but no Claude session for ${label} started within ${CONFIRM_MS / 1000} s`, 502);
  }

  /** Record ids with a triage session open, read from the live claude.exe processes. */
  private async openIds(): Promise<string[]> {
    const res = await this.run('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ForEach-Object { $_.CommandLine }`,
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
