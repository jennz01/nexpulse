import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthProvider, AuthStatus, CodemagicTokenStatus, ProviderStatus } from '../../../shared/types';
import { fetchCodemagicToken, removeCodemagicToken, saveCodemagicToken, switchGithubAccount, testCodemagicToken } from '../api';
import { IconRefresh } from '../icons';
import { Card } from '../settings/Preferences';
import { formatClock } from '../time';
import { formatWhen } from './useAuthStatus';

interface Props {
  status: AuthStatus | null;
  onRefresh: (fresh?: boolean) => Promise<void>;
  openLogin: (provider: AuthProvider) => void;
  /** After the Codemagic token changes, so the host refetches the state and the Builds panel wakes up. */
  onCodemagicChanged: () => void;
}

type Tone = 'green' | 'amber' | 'red' | 'grey';
const tone = (s: ProviderStatus | undefined): Tone => (!s || s.state === 'unknown' ? 'grey' : s.state === 'ok' ? 'green' : s.state === 'wrong-account' ? 'amber' : 'red');

function describe(s: ProviderStatus | undefined, provider: AuthProvider): string {
  if (!s) return 'Checking…';
  switch (s.state) {
    case 'ok': return `Connected as ${s.account ?? '?'}${provider === 'lark' && s.sessionUntil ? ` · session until ${formatWhen(Date.parse(s.sessionUntil))}` : ''}`;
    case 'wrong-account': return `Signed in as ${s.account} · the dashboard tracks ${s.expected}`;
    case 'expired': return `Session expired${s.detail ? ` · ${s.detail}` : ''}`;
    case 'missing': return 'Not signed in';
    default: return `Could not check${s.detail ? ` · ${s.detail}` : ''}`;
  }
}

/** Settings card: the gh and lark-cli sessions with Authorize / Re-authorize, and the Codemagic API token. */
export function ConnectionsCard({ status, onRefresh, openLogin, onCodemagicChanged }: Props) {
  const [switching, setSwitching] = useState(false);
  const [checking, setChecking] = useState(false);
  const gh = status?.github;
  const lk = status?.lark;
  const switchAccount = async () => { setSwitching(true); try { await switchGithubAccount(); await onRefresh(true); } finally { setSwitching(false); } };
  const check = async () => { setChecking(true); try { await onRefresh(true); } finally { setChecking(false); } };
  return (
    <Card title="Connections" right={<button className="btn" disabled={checking} onClick={() => void check()}><IconRefresh size={14} />{checking ? 'Checking…' : 'Check now'}</button>}>
      <div className="conn">
        <Row name="GitHub" tone={tone(gh)} text={describe(gh, 'github')}
          actions={<>
            {gh?.state === 'wrong-account' && <button className="btn" disabled={switching} onClick={() => void switchAccount()}>{switching ? 'Switching…' : `Switch to ${gh.expected}`}</button>}
            <button className={`btn ${gh && gh.state !== 'ok' && gh.state !== 'wrong-account' ? 'primary' : ''}`} onClick={() => openLogin('github')}>{gh?.state === 'ok' || gh?.state === 'wrong-account' ? 'Re-authorize' : 'Authorize'}</button>
          </>} />
        <Row name="Lark" tone={tone(lk)} text={describe(lk, 'lark')}
          actions={<button className={`btn ${lk && lk.state !== 'ok' ? 'primary' : ''}`} onClick={() => openLogin('lark')}>{lk?.state === 'ok' ? 'Re-authorize' : 'Authorize'}</button>} />
        <CodemagicRow onChanged={onCodemagicChanged} />
      </div>
      <span className="hint">
        {status ? `Last checked ${formatClock(status.checkedAt)}. ` : ''}
        GitHub and Lark are the gh and lark-cli sign-ins on this PC; a sign-in started here opens the same browser step the CLI would. They are re-checked every five minutes and whenever a poll fails with an authorization error. Codemagic uses an API token kept in config/secrets/.env.
      </span>
    </Card>
  );
}

function Row({ name, tone: t, text, actions }: { name: string; tone: Tone; text: string; actions: ReactNode }) {
  return (
    <div className="conn-row">
      <span className="conn-name">{name}</span>
      <span className="conn-status"><i className={`dot ${t}`} /><span className="clip" title={text}>{text}</span></span>
      <span className="conn-actions">{actions}</span>
    </div>
  );
}

function CodemagicRow({ onChanged }: { onChanged: () => void }) {
  const [st, setSt] = useState<CodemagicTokenStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | 'remove' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { fetchCodemagicToken().then(setSt).catch(() => setSt(null)); }, []);

  const text = !st ? 'Checking…'
    : !st.enabled ? 'Switched off in config (codemagic.enabled = false)'
    : !st.configured ? 'No API token yet'
    : st.error ? `Token ${st.masked} · ${st.error}`
    : `Connected · token ${st.masked}${st.apps != null ? ` · ${st.apps} apps` : ''}`;
  const t: Tone = !st || !st.enabled ? 'grey' : !st.configured || st.error ? 'red' : 'green';

  const test = async () => {
    setBusy('test'); setResult(null);
    try { const r = await testCodemagicToken(token); setResult({ ok: true, text: `Token works · ${r.apps} apps visible` }); } catch (e) { setResult({ ok: false, text: (e as Error).message }); } finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save'); setResult(null);
    try { setSt(await saveCodemagicToken(token)); setEditing(false); setToken(''); onChanged(); } catch (e) { setResult({ ok: false, text: (e as Error).message }); } finally { setBusy(null); }
  };
  const remove = async () => {
    setBusy('remove'); setResult(null);
    try { setSt(await removeCodemagicToken()); onChanged(); } catch (e) { setResult({ ok: false, text: (e as Error).message }); } finally { setBusy(null); }
  };

  if (editing) {
    return (
      <div className="conn-row editing">
        <span className="conn-name">Codemagic</span>
        <div className="field" style={{ gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="password" autoFocus placeholder="Codemagic API token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} style={{ flex: 1, minWidth: 0 }} />
            <button className="btn" disabled={!token.trim() || !!busy} onClick={() => void test()}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
            <button className="btn primary" disabled={!token.trim() || !!busy} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            <button className="btn" disabled={!!busy} onClick={() => { setEditing(false); setToken(''); setResult(null); }}>Cancel</button>
          </div>
          {result && <span className={result.ok ? 'ok' : 'error'}>{result.text}</span>}
          <span className="hint">Codemagic → Teams → Personal Account → Integrations → Codemagic API → copy the token. Saving tests it first, writes it to config/secrets/.env and starts polling at once.</span>
        </div>
      </div>
    );
  }
  return (
    <div className="conn-row">
      <span className="conn-name">Codemagic</span>
      <span className="conn-status"><i className={`dot ${t}`} /><span className="clip" title={text}>{text}</span></span>
      <span className="conn-actions">
        {result && !result.ok && <span className="error">{result.text}</span>}
        {st?.configured && <button className="btn" disabled={!!busy} onClick={() => void remove()}>{busy === 'remove' ? 'Removing…' : 'Remove'}</button>}
        <button className={`btn ${st && st.enabled && !st.configured ? 'primary' : ''}`} disabled={!st || !st.enabled} onClick={() => { setEditing(true); setResult(null); }}>{st?.configured ? 'Change token' : 'Set token'}</button>
      </span>
    </div>
  );
}
