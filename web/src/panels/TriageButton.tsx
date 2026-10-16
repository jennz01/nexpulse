import { useEffect, useState } from 'react';
import type { TriageStatus } from '../../../shared/types';
import { fetchTriage, resumeTriage, startTriage } from '../api';
import { IconCheck, IconRefresh, IconTerminal } from '../icons';
import { formatDay } from '../time';

/** After a click the buttons stay locked this long, so a double click cannot open two tabs while the first is starting. */
const LOCK_MS = 4000;

/**
 * Opens the lark-issue-triage skill for this issue in a local Claude tab, or resumes the issue's last triage session.
 * The count of open sessions is read when the dialog opens and after each click; there is no polling, since the tabs
 * live outside the dashboard.
 */
export function TriageButton({ recordId }: { recordId: string }) {
  const [status, setStatus] = useState<TriageStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchTriage().then((s) => { if (live) setStatus(s); }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [recordId]);

  const open = status?.open.includes(recordId) ?? false;
  const full = status ? status.open.length >= status.max : false;
  const last = status?.last[recordId];
  const locked = busy || open || full || !status;
  const act = async (call: (id: string) => Promise<TriageStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await call(recordId));
    } catch (e) {
      setError((e as Error).message);
      fetchTriage().then(setStatus, () => undefined);
    }
    setTimeout(() => setBusy(false), LOCK_MS);
  };

  const count = status ? `${status.open.length} of ${status.max} open${full && !open ? ': close one to start another' : ''}` : 'Checking sessions…';
  return (
    <div className="dlg-f-start">
      {open ? (
        <button className="btn" disabled><IconCheck size={12} />Triage open</button>
      ) : last != null ? (
        <>
          <button className="btn" disabled={locked} onClick={() => act(resumeTriage)}
            title="Reopen this issue's last triage session in Windows Terminal, with its whole conversation">
            <IconRefresh size={12} />{busy ? 'Opening…' : 'Resume triage'}
          </button>
          <button className="btn" disabled={locked} onClick={() => act(startTriage)} title="Start a fresh triage session for this issue">New triage</button>
        </>
      ) : (
        <button className="btn" disabled={locked} onClick={() => act(startTriage)}
          title="Open a Claude Code tab in Windows Terminal that runs /lark-issue-triage on this issue">
          <IconTerminal size={12} />{busy ? 'Opening…' : 'Triage in Claude'}
        </button>
      )}
      {error
        ? <span className="error">{error}</span>
        : <span className="hint">{last != null && !open ? `last ${formatDay(last)} · ` : ''}{count}</span>}
    </div>
  );
}
