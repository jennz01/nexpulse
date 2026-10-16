import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { TriageSetupInfo } from '../shared/types';

/** Where teammates install the triage skill, and the per-PC file its setup writes. Nothing else about the skill is known here. */
export const SKILL_DIR = join(homedir(), '.claude', 'skills', 'lark-issue-triage');
export const CONFIG_FILE = process.env.LARK_TRIAGE_CONFIG || join(homedir(), '.claude', 'lark-issue-triage.json');

/** Claude Code keeps a folder's sessions under its path with every other character turned into '-': D:\work -> D--work. */
export const sessionsDirFor = (workdir: string): string => join(homedir(), '.claude', 'projects', workdir.replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-'));

const readVersion = (): string | null => {
  try {
    return readFileSync(join(SKILL_DIR, 'VERSION'), 'utf8').trim() || null;
  } catch {
    return null;
  }
};

/** Read from disk on every call: the skill can be installed or set up while the server runs. */
export function readTriageSetup(): TriageSetupInfo {
  const base: TriageSetupInfo = { setup: 'no-skill', reason: null, skillVersion: null, workdir: null, repos: {}, checks: null, checkedAt: null, configVersion: null };
  if (!existsSync(join(SKILL_DIR, 'SKILL.md'))) return { ...base, reason: 'the lark-issue-triage skill is not installed on this PC' };
  const withSkill = { ...base, skillVersion: readVersion() };
  if (!existsSync(CONFIG_FILE)) return { ...withSkill, setup: 'not-configured', reason: 'triage has not been set up on this PC yet' };
  let parsed: unknown;
  try {
    // PowerShell 5.1 writes UTF-8 with a BOM, which JSON.parse rejects.
    parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ...withSkill, setup: 'not-configured', reason: `the triage settings file could not be read (${(e as Error).message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...withSkill, setup: 'not-configured', reason: 'the triage settings file has an unknown format' };
  const raw = parsed as Record<string, unknown>;
  const workdir = typeof raw.workdir === 'string' ? raw.workdir : null;
  const reposOk = !!raw.repos && typeof raw.repos === 'object' && !Array.isArray(raw.repos) && Object.values(raw.repos).every((v) => typeof v === 'string');
  const repos = reposOk ? (raw.repos as Record<string, string>) : {};
  const info: TriageSetupInfo = {
    ...withSkill,
    setup: 'ready',
    workdir,
    repos,
    checks: (raw.checks as TriageSetupInfo['checks']) ?? null,
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : null,
    configVersion: typeof raw.skillVersion === 'string' ? raw.skillVersion : null,
  };
  if (raw.version !== 1 || !workdir || !reposOk) return { ...info, setup: 'not-configured', reason: 'the triage settings file has an unknown format' };
  // The folder goes to wt.exe as -d: a relative path or a ';' (wt's command separator) would change what wt runs.
  if (!isAbsolute(workdir) || workdir.includes(';')) return { ...info, setup: 'not-configured', reason: `working folder ${workdir} must be a full path without ';': run setup again` };
  if (!existsSync(workdir)) return { ...info, setup: 'not-configured', reason: `working folder ${workdir} not found: run setup again` };
  return info;
}
