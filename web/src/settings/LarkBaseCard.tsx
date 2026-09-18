import { useEffect, useState } from 'react';
import type { LarkBaseInfo, LarkTableInfo, LarkViewInfo } from '../../../shared/types';
import { fetchLarkBase, fetchLarkViews, saveLarkBase } from '../api';
import { IconCheck, IconRefresh } from '../icons';
import { Card } from './Preferences';

type Role = 'tasks' | 'issues' | 'feedback';
const ROLES: { key: Role; label: string; hint: string }[] = [
  { key: 'tasks', label: 'Tasks', hint: 'your own view of the R&D Task table' },
  { key: 'issues', label: 'Issues', hint: 'the Issue Tracker table' },
  { key: 'feedback', label: 'Merchant Feedback', hint: 'the Merchant Feedback table' },
];

/** A Lark Base link as the address bar gives it: `https://<domain>/base/<baseToken>?table=…&view=…`. Base tokens have no fixed prefix, so only their shape is checked. */
export function parseBaseUrl(input: string): { domain: string; baseToken: string } | null {
  try {
    const u = new URL(input.trim());
    const token = /\/base\/([A-Za-z0-9]{10,})/.exec(u.pathname)?.[1];
    return u.hostname && token ? { domain: u.hostname, baseToken: token } : null;
  } catch {
    return null;
  }
}

interface Props {
  /** The saved Lark Base and the three table/view pairs (config `lark`). */
  base: LarkBaseInfo | undefined;
  /** After a save, so the host refetches the state and the panels pick up the new Base. */
  onSaved: () => void;
}

/** Settings card: which Lark Base the three Lark panels read, and which table and view each one follows. */
export function LarkBaseCard({ base, onSaved }: Props) {
  const hasBase = !!base && !/XXXX/.test(base.baseToken);
  const [link, setLink] = useState('');
  const [editing, setEditing] = useState(false);
  const [tables, setTables] = useState<LarkTableInfo[] | null>(null);
  const [views, setViews] = useState<Record<string, LarkViewInfo[]>>({});
  const [sel, setSel] = useState<Record<Role, { tableId: string; viewId: string }>>(() => pick(base));
  const [busy, setBusy] = useState<'base' | 'tables' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => { setSel(pick(base)); }, [base]);

  const loadTables = async () => {
    setError(null);
    setTables(null);
    try {
      setTables((await fetchLarkBase()).tables);
    } catch (e) {
      setError((e as Error).message);
      setTables([]);
    }
  };
  useEffect(() => { if (hasBase) void loadTables(); }, [hasBase, base?.baseToken]);

  // Views are per table, so a table change loads that table's views once and keeps them.
  useEffect(() => {
    const wanted = [...new Set(ROLES.map((r) => sel[r.key].tableId).filter((id) => id && !/XXXX/.test(id)))];
    for (const tableId of wanted) {
      if (views[tableId]) continue;
      setViews((prev) => ({ ...prev, [tableId]: [] }));
      fetchLarkViews(tableId)
        .then((r) => setViews((prev) => ({ ...prev, [tableId]: r.views })))
        .catch((e: Error) => setError(e.message));
    }
  }, [sel, views]);

  const useThisBase = async () => {
    const parsed = parseBaseUrl(link);
    if (!parsed) { setError('That is not a Lark Base link. Open the Base in Lark and copy the address from the browser; it has /base/ followed by the Base token.'); return; }
    setBusy('base');
    setError(null);
    setSaved(null);
    try {
      await saveLarkBase({ domain: parsed.domain, baseToken: parsed.baseToken });
      setSaved(`Base set to ${parsed.domain}. Now pick a table and view for each panel.`);
      setEditing(false);
      setLink('');
      setViews({});
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveTables = async () => {
    setBusy('tables');
    setError(null);
    setSaved(null);
    try {
      const tablesInput = Object.fromEntries(ROLES.map((r) => {
        const s = sel[r.key];
        return [r.key, { tableId: s.tableId, viewId: s.viewId, viewName: views[s.tableId]?.find((v) => v.id === s.viewId)?.name ?? '' }];
      }));
      await saveLarkBase({ tables: tablesInput });
      setSaved('Saved · the Lark panels are polling now');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const complete = ROLES.every((r) => /^tbl/.test(sel[r.key].tableId) && /^vew/.test(sel[r.key].viewId));
  const dirty = !base || ROLES.some((r) => sel[r.key].tableId !== base.tables[r.key].tableId || sel[r.key].viewId !== base.tables[r.key].viewId);

  return (
    <Card title="Lark Base" count={base?.configured ? base.domain : 'not set up'}
      right={hasBase ? <>
        <button className="btn" disabled={tables === null} onClick={() => void loadTables()}><IconRefresh size={14} />Reload list</button>
        <button className="btn primary" disabled={!complete || !dirty || busy !== null} onClick={() => void saveTables()}>{busy === 'tables' ? 'Saving…' : 'Save'}</button>
      </> : null}>
      <span className="hint">
        The Tasks, Issues and Merchant Feedback panels read one Lark Base. Point this at the team's Base, then choose the table and view behind each panel; the Tasks view is usually your own filtered view, so each person's dashboard shows their own tasks. Saved to this PC's config and polled at once. The lists come from Lark for the account lark-cli is signed in as.
      </span>

      {(!hasBase || editing) ? (
        <div className="field">
          <label htmlFor="lark-base-link">Base link</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input id="lark-base-link" type="url" placeholder="https://yourcompany.larksuite.com/base/…" value={link} onChange={(e) => setLink(e.target.value)} autoComplete="off" spellCheck={false} style={{ flex: 1, minWidth: 0 }} />
            <button className="btn primary" disabled={!link.trim() || busy !== null} onClick={() => void useThisBase()}>{busy === 'base' ? 'Saving…' : 'Use this Base'}</button>
            {hasBase && <button className="btn" disabled={busy !== null} onClick={() => { setEditing(false); setLink(''); }}>Cancel</button>}
          </div>
          <span className="hint">Open the Base in Lark and copy the address from the browser. Everything after the table and view part is ignored.</span>
        </div>
      ) : (
        <div className="conn-row">
          <span className="conn-name">Base</span>
          <span className="conn-status"><i className={`dot ${base?.configured ? 'green' : 'amber'}`} /><span className="clip">{base?.domain} · {base?.baseToken.slice(0, 10)}…</span></span>
          <span className="conn-actions"><button className="btn" onClick={() => setEditing(true)}>Change</button></span>
        </div>
      )}

      {error && <span className="error">{error}</span>}
      {hasBase && tables === null && !error && <span className="waiting"><i className="dot blue pulse" />Loading tables from Lark…</span>}
      {hasBase && tables && tables.length > 0 && ROLES.map((r) => {
        const s = sel[r.key];
        const vs = views[s.tableId];
        return (
          <div key={r.key} className="field">
            <label htmlFor={`lark-${r.key}-table`}>{r.label} <span className="muted">· {r.hint}</span></label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select id={`lark-${r.key}-table`} value={/^tbl/.test(s.tableId) ? s.tableId : ''} style={{ flex: 1, minWidth: 0 }}
                onChange={(e) => setSel((p) => ({ ...p, [r.key]: { tableId: e.target.value, viewId: '' } }))}>
                <option value="" disabled>Choose a table…</option>
                {tables.map((t) => <option key={t.id} value={t.id}>{t.name}{t.records != null ? ` (${t.records} rows)` : ''}</option>)}
              </select>
              <select aria-label={`${r.label} view`} value={/^vew/.test(s.viewId) ? s.viewId : ''} style={{ flex: 1, minWidth: 0 }} disabled={!/^tbl/.test(s.tableId) || !vs?.length}
                onChange={(e) => setSel((p) => ({ ...p, [r.key]: { ...p[r.key], viewId: e.target.value } }))}>
                <option value="" disabled>{!/^tbl/.test(s.tableId) ? 'Choose a table first' : !vs ? 'Loading views…' : vs.length ? 'Choose a view…' : 'No views'}</option>
                {(vs ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}{v.summary ? ` · ${v.summary}` : ''}</option>)}
              </select>
            </div>
          </div>
        );
      })}
      {saved && <span className="ok"><IconCheck size={12} />{saved}</span>}
    </Card>
  );
}

const EMPTY = { tableId: '', viewId: '' };
const pick = (base: LarkBaseInfo | undefined): Record<Role, { tableId: string; viewId: string }> => ({
  tasks: base ? { tableId: base.tables.tasks.tableId, viewId: base.tables.tasks.viewId } : EMPTY,
  issues: base ? { tableId: base.tables.issues.tableId, viewId: base.tables.issues.viewId } : EMPTY,
  feedback: base ? { tableId: base.tables.feedback.tableId, viewId: base.tables.feedback.viewId } : EMPTY,
});
