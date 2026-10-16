import { useEffect, useRef, useState } from 'react';
import type { TriageCheck, TriageSetupInfo } from '../../../shared/types';
import { checkTriageSetup, fetchTriageSetup, installTriageSkill, runTriageSetup } from '../api';
import { IconRefresh, IconSettings } from '../icons';
import { formatDay } from '../time';
import { Card } from './Preferences';

const TOOLS: { key: string; label: string }[] = [
  { key: 'python', label: 'Python' }, { key: 'pypdf', label: 'pypdf' }, { key: 'ffmpeg', label: 'ffmpeg' }, { key: 'lark', label: 'lark-cli' }, { key: 'sentry', label: 'sentry-cli' },
];

const mark = (c: TriageCheck | undefined) => (c ? (c.ok ? '✓' : '✗') : '–');

/** Settings card: install or update the lark-issue-triage skill from a zip, run its setup session, and show what the last setup found. */
export function TriageSetupCard() {
  const [info, setInfo] = useState<TriageSetupInfo | null>(null);
  const [busy, setBusy] = useState<'install' | 'setup' | 'check' | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [fresh, setFresh] = useState<Record<string, TriageCheck> | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const load = () => fetchTriageSetup().then(setInfo, (e: Error) => setNote({ tone: 'error', text: e.message }));
  useEffect(() => { void load(); }, []);

  const install = async (file: File, confirmOlder = false): Promise<void> => {
    setBusy('install');
    setNote(null);
    try {
      const r = await installTriageSkill(file, confirmOlder);
      if (r.needsConfirm) {
        if (window.confirm(`This zip is older than the installed v${r.previous}. Install it anyway?`)) return await install(file, true);
        setNote({ tone: 'error', text: `Kept v${r.previous}.` });
      } else {
        setNote({ tone: 'ok', text: `Installed v${r.installed ?? '?'}${r.openSessions ? ` · ${r.openSessions} open triage session(s) keep the old instructions until restarted` : ''}` });
      }
      await load();
    } catch (e) {
      setNote({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const setup = async () => {
    setBusy('setup');
    setNote(null);
    try {
      await runTriageSetup();
      setNote({ tone: 'ok', text: 'Setup opened in Windows Terminal. Come back here when Claude says it is done.' });
    } catch (e) {
      setNote({ tone: 'error', text: (e as Error).message });
    } finally {
      setTimeout(() => setBusy(null), 4000);
    }
  };
  const check = async () => {
    setBusy('check');
    setNote(null);
    try {
      setFresh((await checkTriageSetup()).tools);
    } catch (e) {
      setNote({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const noSkill = !info || info.setup === 'no-skill';
  const saved = (info?.checks ?? {}) as Record<string, TriageCheck | Record<string, TriageCheck>>;
  const tools = fresh ?? (saved as Record<string, TriageCheck>);
  const repoChecks = (saved.repos ?? {}) as Record<string, TriageCheck>;
  const repos = Object.entries(info?.repos ?? {});
  return (
    <Card title="Issue triage" right={<button className="btn" disabled={noSkill || busy !== null} onClick={() => void check()}><IconRefresh size={14} />{busy === 'check' ? 'Checking…' : 'Check again'}</button>}>
      <div className="kv">
        <span className="muted">Skill</span>
        <span className="triage-row">
          {!info ? '…' : info.setup === 'no-skill' ? 'not installed' : `v${info.skillVersion ?? '?'} installed`}
          <button className="btn" disabled={busy !== null} onClick={() => picker.current?.click()}>{busy === 'install' ? 'Installing…' : noSkill ? 'Install from .zip…' : 'Update from .zip…'}</button>
          <input ref={picker} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void install(f); }} />
        </span>
        <span className="muted">Setup</span>
        <span className="triage-row">
          {info?.setup === 'ready' ? `ready · working folder ${info.workdir}` : info?.reason ?? '…'}
          <button className="btn" disabled={noSkill || busy !== null} onClick={() => void setup()}><IconSettings size={14} />{busy === 'setup' ? 'Opening…' : info?.setup === 'ready' ? 'Run setup again' : 'Set up triage'}</button>
        </span>
        <span className="muted">Repos</span>
        <span className="triage-chips">
          {repos.length === 0 ? '—' : repos.map(([key, path]) => (
            <span key={key} title={`${path}${repoChecks[key]?.detail ? ` · ${repoChecks[key]!.detail}` : ''}`}>{key} {mark(repoChecks[key])}</span>
          ))}
        </span>
        <span className="muted">Tools</span>
        <span className="triage-chips">
          {TOOLS.map((t) => <span key={t.key} title={tools[t.key]?.detail ?? ''}>{t.label} {mark(tools[t.key])}</span>)}
          {fresh
            ? <span className="hint">checked just now (not saved; run setup to save)</span>
            : info?.checkedAt && <span className="hint">checked {formatDay(Date.parse(info.checkedAt))}</span>}
        </span>
      </div>
      {note && <span className={note.tone === 'ok' ? 'ok' : 'error'}>{note.text}</span>}
      <span className="hint">Get the skill zip from your team lead. Updating keeps your settings; open triage sessions keep the old instructions until restarted.</span>
    </Card>
  );
}
