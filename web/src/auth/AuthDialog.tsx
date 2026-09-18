import { useEffect, useRef, useState } from 'react';
import type { AuthProvider, LoginState } from '../../../shared/types';
import { cancelLogin, getLogin, startLogin } from '../api';
import { IconCheck, IconClose, IconCopy, IconExternal } from '../icons';

const LABEL: Record<AuthProvider, string> = { github: 'GitHub', lark: 'Lark' };
const TOOL: Record<AuthProvider, string> = { github: 'gh auth login', lark: 'lark-cli auth login' };
/** The one-time lark-cli app configuration a PC needs before any Lark sign-in; shown when the server reports `unconfigured`. */
const LARK_SETUP = 'lark-cli config init --brand lark';

interface Props {
  provider: AuthProvider;
  onClose: () => void;
  /** Fired once when the CLI reports success, so the host can refresh status and data. */
  onDone: () => void;
}

/** Drives a server-side device-code sign-in: starts it, shows the code and link, and polls until the CLI finishes. */
export function AuthDialog({ provider, onClose, onDone }: Props) {
  const [state, setState] = useState<LoginState>({ phase: 'starting' });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    let alive = true;
    done.current = false;
    setError(null);
    setCopied(false);
    setState({ phase: 'starting' });
    startLogin(provider).then((s) => { if (alive) setState(s); }).catch((e: Error) => { if (alive) setError(e.message); });
    const timer = setInterval(() => {
      getLogin(provider).then((s) => {
        if (!alive) return;
        setState(s);
        if (s.phase === 'done' && !done.current) { done.current = true; onDone(); }
      }).catch(() => { /* transient; next tick retries */ });
    }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [provider, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const failed = state.phase === 'failed' || !!error;
  const finished = state.phase === 'done' || failed;
  const copy = () => { if (state.code) void navigator.clipboard?.writeText(state.code).then(() => setCopied(true)); };
  const copySetup = () => { void navigator.clipboard?.writeText(LARK_SETUP).then(() => setCopied(true)); };
  const cancel = () => { void cancelLogin(provider); onClose(); };
  const host = (() => { try { return state.url ? new URL(state.url).host : ''; } catch { return state.url ?? ''; } })();
  const n = (i: number) => (state.code ? i : i - 1);

  return (
    <div className="backdrop" onClick={finished ? onClose : undefined}>
      <div className="dlg" role="dialog" aria-modal="true" aria-label={`Authorize ${LABEL[provider]}`} onClick={(e) => e.stopPropagation()}>
        <div className="dlg-h">
          <span>{state.phase === 'done' ? `${LABEL[provider]} connected` : state.unconfigured ? `Set up ${LABEL[provider]}` : `Authorize ${LABEL[provider]}`}</span>
          <button className="iconbtn sm" title="Close" onClick={finished ? onClose : cancel}><IconClose size={14} /></button>
        </div>
        <div className="dlg-body">
          {state.phase === 'starting' && !error && <span className="waiting"><i className="dot blue pulse" />Starting {TOOL[provider]}…</span>}
          {state.phase === 'waiting' && (
            <div className="steps">
              {state.code && (
                <div className="step">
                  <span className="step-n">1 · Copy this one-time code</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="otp mono">{state.code}</span>
                    <button className="btn" onClick={copy}><IconCopy size={14} />{copied ? 'Copied' : 'Copy'}</button>
                  </div>
                </div>
              )}
              <div className="step">
                <span className="step-n">{n(2)} · Open the verification page{state.code ? ' and enter the code' : ''}</span>
                {state.url && <a className="btn primary" href={state.url} target="_blank" rel="noreferrer" style={{ alignSelf: 'flex-start' }}><IconExternal size={12} />Open {host}</a>}
              </div>
              <div className="step">
                <span className="step-n">{n(3)} · Approve the sign-in in the browser</span>
                <span className="waiting"><i className="dot blue pulse" />Waiting for {TOOL[provider]} to finish. This window updates by itself.</span>
              </div>
            </div>
          )}
          {state.phase === 'done' && <span className="ok"><IconCheck size={14} />Signed in. The panels refresh in a moment.</span>}
          {failed && state.unconfigured && (
            <div className="steps">
              <span>lark-cli has no Lark app configured on this PC yet. That is a one-time step in a terminal; the dashboard cannot do it for you.</span>
              <div className="step">
                <span className="step-n">1 · Open PowerShell or Git Bash and run</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <code className="mono" style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface2)' }}>{LARK_SETUP}</code>
                  <button className="btn" onClick={copySetup}><IconCopy size={14} />{copied ? 'Copied' : 'Copy'}</button>
                </div>
              </div>
              <div className="step">
                <span className="step-n">2 · Answer its prompts</span>
                <span>To share the team's app, choose the existing-app option and paste the App ID and App Secret the dashboard owner gives you. To use your own app instead, run it with <code className="mono">--new</code> and finish in the browser link it prints. Feishu tenants use <code className="mono">--brand feishu</code>.</span>
              </div>
              <div className="step">
                <span className="step-n">3 · Come back and click Try again</span>
                <span>The usual code-and-link sign-in follows.</span>
              </div>
            </div>
          )}
          {failed && !state.unconfigured && <div className="error">{error ?? state.message ?? 'Sign-in failed.'}</div>}
        </div>
        <div className="dlg-f">
          {failed && <button className="btn" onClick={() => setAttempt((a) => a + 1)}>Try again</button>}
          {finished ? <button className="btn primary" onClick={onClose}>Close</button> : <button className="btn" onClick={cancel}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}
