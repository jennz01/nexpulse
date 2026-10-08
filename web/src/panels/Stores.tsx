import { APPSTORE_LIVE_STATES, APPSTORE_REJECTED_STATES, humanState } from '../../../shared/status';
import type { AppStoreApp, AppStoreSnapshot, Event, PlayApp, PlaySnapshot } from '../../../shared/types';
import { unreadItems } from '../state';
import { openItem } from './open';

export interface StoreRow { account: string; name: string; ios: AppStoreApp | null; android: PlayApp | null }

/**
 * The iOS app a Play app shares a row with: same name (a name override in Settings lands here), else the bundle id
 * equal to the package name. Callers pass only the iOS apps of the same account.
 */
export function iosPartner<T extends { name: string; bundleId: string }>(play: { packageName: string; name: string }, ios: T[]): T | null {
  return ios.find((a) => a.name === play.name) ?? ios.find((a) => a.bundleId === play.packageName) ?? null;
}

export function joinStoreApps(appstore: AppStoreSnapshot | null, playstore: PlaySnapshot | null, accountOrder: string[]): StoreRow[] {
  const rows = new Map<string, StoreRow>();
  const key = (account: string, name: string) => `${account}::${name}`;
  for (const a of appstore?.apps ?? []) rows.set(key(a.account, a.name), { account: a.account, name: a.name, ios: a, android: null });
  for (const p of playstore?.apps ?? []) {
    const unpaired = (appstore?.apps ?? []).filter((a) => a.account === p.account && !rows.get(key(a.account, a.name))?.android);
    const partner = iosPartner(p, unpaired);
    const existing = partner ? rows.get(key(partner.account, partner.name)) : rows.get(key(p.account, p.name));
    if (existing) existing.android = p;
    else rows.set(key(p.account, p.name), { account: p.account, name: p.name, ios: null, android: p });
  }
  const rank = (account: string) => { const i = accountOrder.indexOf(account); return i === -1 ? accountOrder.length : i; };
  return [...rows.values()].sort((a, b) => rank(a.account) - rank(b.account) || a.account.localeCompare(b.account));
}

export function iosStateClass(state: string): 'ok' | 'fail' | 'warn' | 'plain' {
  if (APPSTORE_LIVE_STATES.has(state)) return 'ok';
  if (APPSTORE_REJECTED_STATES.has(state)) return 'fail';
  if (state === 'WAITING_FOR_REVIEW' || state === 'IN_REVIEW' || state === 'PENDING_DEVELOPER_RELEASE' || state === 'PENDING_APPLE_RELEASE') return 'warn';
  return 'plain';
}
export function playStatusClass(status: string): 'ok' | 'run' | 'fail' | 'plain' {
  return status === 'completed' ? 'ok' : status === 'inProgress' ? 'run' : status === 'halted' ? 'fail' : 'plain';
}

interface Props { appstore: AppStoreSnapshot | null; playstore: PlaySnapshot | null; events: Event[]; onSee: (ids: number[]) => void; accounts: string[] }

export function Stores({ appstore, playstore, events, onSee, accounts }: Props) {
  const rows = joinStoreApps(appstore, playstore, accounts);
  if (!appstore && !playstore) return <div className="note">Waiting for the first store poll…</div>;
  if (rows.length === 0) return <div className="note">No apps found for the configured accounts.</div>;
  const unread = unreadItems(events, 'stores');
  const idsFor = (r: StoreRow) => [
    ...(r.ios ? unread.get(`${r.ios.account}/${r.ios.appId}`) ?? [] : []),
    ...(r.android ? r.android.releases.flatMap((rel) => unread.get(`${r.android!.account}/${r.android!.packageName}/${rel.track}`) ?? []) : []),
  ];
  let lastAccount: string | null = null;
  return (
    <div className="rows" role="list">
      <div className="stores" style={{ paddingTop: 8, paddingBottom: 6 }}>
        <span className="sub head">APP</span><span className="sub head">iOS · APP STORE</span><span className="sub head">ANDROID · GOOGLE PLAY</span>
      </div>
      {rows.map((r) => {
        const header = r.account !== lastAccount ? <div className="group" key={`g-${r.account}`}>{r.account.toUpperCase()}</div> : null;
        lastAccount = r.account;
        const ids = idsFor(r);
        // The source keeps production only; it can hold two releases at once (live + staged rollout).
        const production = r.android?.releases.filter((rel) => rel.track === 'production') ?? [];
        return (
          <div key={`${r.account}/${r.name}`}>
            {header}
            <div className={`stores ${ids.length ? 'new' : ''}`} role="listitem">
              <div className="cell">
                <span style={{ fontWeight: 500, display: 'inline-flex', gap: 8, alignItems: 'center' }}>{ids.length ? <i className="newdot" /> : null}{r.name}</span>
                <span className="sub mono">{r.ios?.bundleId ?? r.android?.packageName}</span>
              </div>
              <div className="cell">
                {!r.ios && <span className="sub">not on this account</span>}
                {r.ios?.live && <span className="ver"><span className="mono">{r.ios.live.version}</span><span className={`tag ${iosStateClass(r.ios.live.state)}`}>{humanState(r.ios.live.state)}</span></span>}
                {r.ios?.inflight && (
                  <span className="ver">
                    <span className="mono">{r.ios.inflight.version}</span>
                    <span className={`tag ${iosStateClass(r.ios.inflight.state)}`}>{humanState(r.ios.inflight.state)}</span>
                    {APPSTORE_REJECTED_STATES.has(r.ios.inflight.state) && <a className="sub" href={r.ios.url} target="_blank" rel="noreferrer" onClick={() => onSee(ids)}>open App Review</a>}
                  </span>
                )}
                {r.ios && !r.ios.live && !r.ios.inflight && <span className="sub">no iOS versions</span>}
                {r.ios && <a className="sub" href={r.ios.url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openItem(r.ios!.url, ids, onSee); }}>App Store Connect</a>}
              </div>
              <div className="cell">
                {!r.android && <span className="sub">not on this account</span>}
                {production.map((rel, i) => (
                  <span className="ver" key={i}><span className="mono">{rel.name ?? ''} ({rel.versionCodes.join(', ')})</span><span className={`tag ${playStatusClass(rel.status)}`}>{rel.status === 'inProgress' ? `${Math.round((rel.userFraction ?? 0) * 100)}% rollout` : humanState(rel.status)}</span></span>
                ))}
                {r.android && production.length === 0 && <span className="sub">not in production yet</span>}
                {r.android && <a className="sub" href={r.android.url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openItem(r.android!.url, ids, onSee); }}>Play Console</a>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
