import { useEffect, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import type { StoreAccountInput, StoreAccountView, StorePlayAppInput, StoreTestResult } from '../../../shared/types';
import { listStoreAccounts, removeStoreAccount, saveStoreAccount, testStoreAccount } from '../api';
import { IconClose } from '../icons';
import type { DashboardState } from '../state';
import { Card } from './Preferences';

type Tone = 'green' | 'amber' | 'red' | 'grey';

const Status = ({ tone, children }: { tone: Tone; children: ReactNode }) => (
  <span className={`status ${tone}`}><i className={`dot ${tone}`} />{children}</span>
);

interface SourceBits { disabled: string | null; error: string | null; polled: boolean }

/** One line per store: configured? file present? source off / erroring / waiting / OK with a count. */
export function storeStatus(src: SourceBits, configured: boolean, filePresent: boolean, count: number): { tone: Tone; text: string } {
  if (!configured) return { tone: 'grey', text: 'not set up' };
  if (!filePresent) return { tone: 'red', text: 'key file missing' };
  if (src.disabled) return { tone: 'grey', text: `off: ${src.disabled}` };
  if (src.error) return { tone: 'red', text: src.error };
  if (!src.polled) return { tone: 'grey', text: 'waiting for the first poll…' };
  return count > 0 ? { tone: 'green', text: `OK · ${count} app${count === 1 ? '' : 's'}` } : { tone: 'amber', text: 'OK, but no apps visible to this key' };
}

function AccountRow({ a, state, onEdit, onRemove }: { a: StoreAccountView; state: DashboardState; onEdit: () => void; onRemove: () => void }) {
  const asc = state.states.appstore;
  const play = state.states.playstore;
  const ascCount = asc.snapshot?.apps.filter((x) => x.account === a.name).length ?? 0;
  const playCount = play.snapshot?.apps.filter((x) => x.account === a.name).length ?? 0;
  const s1 = storeStatus({ disabled: asc.disabled, error: asc.error, polled: !!asc.snapshot }, !!a.appstore, a.appstore?.keyPresent ?? true, ascCount);
  const s2 = storeStatus({ disabled: play.disabled, error: play.error, polled: !!play.snapshot }, !!a.play, a.play?.filePresent ?? true, playCount);
  return (
    <div className="acct">
      <div className="acct-h">
        {a.name}
        <span className="right"><button className="btn" onClick={onEdit}>Edit</button><button className="btn" onClick={onRemove}>Remove</button></span>
      </div>
      <div className="acct-row">
        <span className="muted">App Store</span>
        <span className="clip">
          {a.appstore ? <>key <span className="mono">{a.appstore.keyId}</span> · issuer <span className="mono">{a.appstore.issuerId.slice(0, 8)}…</span></> : <span className="faint">—</span>}
        </span>
        <Status tone={s1.tone}>{s1.text}</Status>
      </div>
      <div className="acct-row">
        <span className="muted">Google Play</span>
        <span className="clip">
          {a.play ? <>{a.play.clientEmail ?? a.play.serviceAccountFile} · {a.play.apps.length} app{a.play.apps.length === 1 ? '' : 's'} configured</> : <span className="faint">—</span>}
        </span>
        <Status tone={s2.tone}>{s2.text}</Status>
      </div>
    </div>
  );
}

function TestResult({ r }: { r: StoreTestResult }) {
  const list = (names: string[]) => (names.length ? ` (${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''})` : '');
  return (
    <div className="testres">
      {r.appstore && <span className={r.appstore.ok ? 'ok' : 'error'}>App Store: {r.appstore.ok ? `OK · ${r.appstore.apps.length} apps${list(r.appstore.apps)}` : r.appstore.error}</span>}
      {r.play && <span className={r.play.ok ? 'ok' : 'error'}>Google Play: {r.play.error ?? (r.play.ok ? 'OK' : 'some apps failed')}</span>}
      {r.play?.apps.map((a) => (
        <span key={a.packageName} className={a.ok ? 'ok' : 'error'} style={{ paddingLeft: 16 }}>{a.packageName}: {a.ok ? `${a.releases} release${a.releases === 1 ? '' : 's'}` : a.error}</span>
      ))}
    </div>
  );
}

interface DialogProps { initial: StoreAccountInput; ascNames: string[]; onClose: () => void; onSaved: (list: StoreAccountView[]) => void }

const emptyApp = (): StorePlayAppInput => ({ packageName: '', name: '' });

function AccountDialog({ initial, ascNames, onClose, onSaved }: DialogProps) {
  const editing = !!initial.originalName;
  const [name, setName] = useState(initial.name);
  const [asc, setAsc] = useState(initial.appstore);
  const [play, setPlay] = useState(initial.play);
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [saFile, setSaFile] = useState<string | null>(null);
  const [result, setResult] = useState<StoreTestResult | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const input = (): StoreAccountInput => ({ name: name.trim(), originalName: initial.originalName, appstore: asc, play });
  const readText = (e: ChangeEvent<HTMLInputElement>, cb: (text: string, fileName: string) => void) => {
    const f = e.target.files?.[0];
    if (f) void f.text().then((t) => cb(t, f.name));
  };
  const run = (kind: 'test' | 'save') => {
    setBusy(kind);
    setError(null);
    const p = kind === 'test' ? testStoreAccount(input()).then(setResult) : saveStoreAccount(input()).then(onSaved);
    p.catch((e: Error) => setError(e.message)).finally(() => setBusy(null));
  };
  const setApp = (i: number, patch: Partial<StorePlayAppInput>) => setPlay((p) => p && { ...p, apps: p.apps.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  return (
    <div className="backdrop">
      <div className="dlg wide" role="dialog" aria-label={editing ? 'Edit account' : 'Add account'}>
        <div className="dlg-h">
          {editing ? `Edit ${initial.originalName}` : 'Add developer account'}
          <button className="iconbtn" onClick={onClose} title="Close"><IconClose /></button>
        </div>
        <div className="dlg-body">
          <div className="field">
            <span className="lbl">Account name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SiteGiant" />
            <span className="hint">Shown as the section title on the Stores page.</span>
          </div>

          <div className="fset">
            <div className="fset-h">
              App Store Connect
              <label className="chk"><input type="checkbox" checked={!!asc} onChange={(e) => setAsc(e.target.checked ? { issuerId: '', keyId: '' } : null)} />{asc ? 'on' : 'off'}</label>
            </div>
            {asc && (
              <>
                <div className="fields-row">
                  <div className="field"><span className="lbl">Issuer ID</span><input type="text" value={asc.issuerId} onChange={(e) => setAsc({ ...asc, issuerId: e.target.value })} placeholder="69a6de70-…" /></div>
                  <div className="field"><span className="lbl">Key ID</span><input type="text" value={asc.keyId} onChange={(e) => setAsc({ ...asc, keyId: e.target.value })} placeholder="ABC123DEFG" /></div>
                </div>
                <div className="filerow">
                  <label className="btn">
                    Choose .p8 file
                    <input type="file" accept=".p8,.pem" onChange={(e) => readText(e, (text, fileName) => {
                      const m = /AuthKey_([A-Za-z0-9]+)\.p8$/i.exec(fileName);
                      setAsc((a) => a && { ...a, keyPem: text, keyId: a.keyId || (m?.[1] ?? '') });
                      setKeyFile(fileName);
                    })} />
                  </label>
                  <span className="muted">{keyFile ?? (editing && initial.appstore ? 'keeping the current key' : 'no file chosen')}</span>
                </div>
                <span className="hint">App Store Connect → Users and Access → Integrations → Team Keys. The Developer role is enough; the .p8 can be downloaded only once.</span>
              </>
            )}
          </div>

          <div className="fset">
            <div className="fset-h">
              Google Play
              <label className="chk"><input type="checkbox" checked={!!play} onChange={(e) => setPlay(e.target.checked ? { developerId: '', apps: [emptyApp()] } : null)} />{play ? 'on' : 'off'}</label>
            </div>
            {play && (
              <>
                <div className="filerow">
                  <label className="btn">
                    Choose service account JSON
                    <input type="file" accept=".json" onChange={(e) => readText(e, (text, fileName) => { setPlay((p) => p && { ...p, serviceAccountJson: text }); setSaFile(fileName); })} />
                  </label>
                  <span className="muted">{saFile ?? (editing && initial.play ? 'keeping the current file' : 'no file chosen')}</span>
                </div>
                <div className="field">
                  <span className="lbl">Developer ID</span>
                  <input type="text" value={play.developerId} onChange={(e) => setPlay({ ...play, developerId: e.target.value })} placeholder="the long number in the Play Console URL" />
                </div>
                <div className="field">
                  <span className="lbl">Apps</span>
                  {play.apps.map((app, i) => (
                    <div className="approw" key={i}>
                      <input type="text" value={app.packageName} onChange={(e) => setApp(i, { packageName: e.target.value })} placeholder="com.company.app" />
                      <input type="text" list="asc-app-names" value={app.name} onChange={(e) => setApp(i, { name: e.target.value })} placeholder="Name as in App Store Connect" />
                      <input type="text" value={app.consoleUrl ?? ''} onChange={(e) => setApp(i, { consoleUrl: e.target.value || undefined })} placeholder="Play Console URL (optional)" />
                      <button className="iconbtn sm" title="Remove app" onClick={() => setPlay({ ...play, apps: play.apps.filter((_, j) => j !== i) })}><IconClose size={14} /></button>
                    </div>
                  ))}
                  <datalist id="asc-app-names">{ascNames.map((n) => <option key={n} value={n} />)}</datalist>
                  <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setPlay({ ...play, apps: [...play.apps, emptyApp()] })}>+ Add app</button>
                  <span className="hint">Google's API cannot list your apps, so name each package. The display name must match App Store Connect so both stores share a row; suggestions come from the App Store accounts already connected.</span>
                </div>
                <span className="hint">Google Cloud → IAM → Service Accounts → Keys → JSON. Enable the Google Play Android Developer API in that project, then invite the service account in Play Console with "View app information".</span>
              </>
            )}
          </div>

        </div>
        {(result || error) && (
          <div className="dlg-status">
            {result && <TestResult r={result} />}
            {error && <div className="error">{error}</div>}
          </div>
        )}
        <div className="dlg-f">
          <button className="btn" disabled={busy != null} onClick={() => run('test')}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy != null} onClick={() => run('save')}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

interface Props { state: DashboardState; reload: () => void }

export function StoreAccounts({ state, reload }: Props) {
  const [accounts, setAccounts] = useState<StoreAccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StoreAccountInput | null>(null);

  useEffect(() => {
    listStoreAccounts().then(setAccounts).catch((e: Error) => setError(e.message));
  }, []);

  const ascNames = [...new Set((state.states.appstore.snapshot?.apps ?? []).map((a) => a.name))].sort();

  const onRemove = async (a: StoreAccountView) => {
    const files = [a.appstore?.keyFile, a.play?.serviceAccountFile].filter(Boolean).join(' and ');
    const note = files ? ` Its key file${files.includes(' and ') ? 's' : ''} (${files}) will be deleted unless another account uses them.` : '';
    if (!window.confirm(`Remove "${a.name}" from the dashboard?${note}`)) return;
    try {
      setAccounts(await removeStoreAccount(a.name));
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const startAdd = () => setEditing({ name: '', appstore: { issuerId: '', keyId: '' }, play: null });
  const startEdit = (a: StoreAccountView) => setEditing({
    name: a.name,
    originalName: a.name,
    appstore: a.appstore ? { issuerId: a.appstore.issuerId, keyId: a.appstore.keyId } : null,
    play: a.play ? { developerId: a.play.developerId, apps: a.play.apps } : null,
  });

  return (
    <Card title="Store accounts" count={accounts ? accounts.length : undefined} right={<button className="btn primary" onClick={startAdd}>+ Add account</button>}>
      {error && <div className="error">{error}</div>}
      {accounts == null ? (
        <div className="note" style={{ padding: 0 }}>Loading…</div>
      ) : accounts.length === 0 ? (
        <div className="note" style={{ padding: 0 }}>No developer accounts yet. Add one to see App Store and Google Play release states on the Stores page.</div>
      ) : (
        accounts.map((a) => <AccountRow key={a.name} a={a} state={state} onEdit={() => startEdit(a)} onRemove={() => void onRemove(a)} />)
      )}
      <span className="hint">Keys are stored in config/secrets on this machine and never shown again here. Saving switches the stores on right away, no restart needed.</span>
      {editing && (
        <AccountDialog initial={editing} ascNames={ascNames} onClose={() => setEditing(null)} onSaved={(list) => { setAccounts(list); setEditing(null); reload(); }} />
      )}
    </Card>
  );
}
