import type { ReactNode } from 'react';
import type { PublicConfig } from '../../../shared/types';
import { IconCheck } from '../icons';
import type { AlertMode, Density, FontSize, Settings, Theme } from './useSettings';

/** A settings section styled like a dashboard panel. */
export function Card({ title, count, right, children }: { title: string; count?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-h">
        <div className="panel-h-left"><h2>{title}</h2>{count != null && <span className="count">{count}</span>}</div>
        <div className="panel-h-right">{right}</div>
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

const ALERTS: { value: AlertMode; title: string; desc: string }[] = [
  { value: 'toast', title: 'Windows toast', desc: 'Native notification for high-priority events: review requests, failed builds, new open issues, store rejections. Everything else badges.' },
  { value: 'badge', title: 'In-page badges only', desc: 'Unread counts on panels, in the sidebar and in the tab title. No notifications.' },
  { value: 'off', title: 'Off', desc: 'Show current data only, no unread state.' },
];

function Seg<T extends string>({ value, options, onPick }: { value: T; options: { v: T; label: string }[]; onPick: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.v} role="radio" aria-checked={o.v === value} className={o.v === value ? 'on' : ''} onClick={() => onPick(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  permission: NotificationPermission | 'unsupported';
  onRequestPermission: () => void;
  config: PublicConfig | null;
}

export function Preferences({ settings, onChange, permission, onRequestPermission, config }: Props) {
  return (
    <>
      <Card title="Alerts">
        <div className="radios">
          {ALERTS.map((a) => (
            <button key={a.value} className={`radio ${settings.alertMode === a.value ? 'on' : ''}`} onClick={() => onChange({ alertMode: a.value })}>
              <i className="rd" />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="radio-title">{a.title}</span>
                <span className="radio-desc">{a.desc}</span>
                {a.value === 'toast' && settings.alertMode === 'toast' && (
                  permission === 'granted' ? <span className="ok" style={{ marginTop: 6 }}><IconCheck size={12} />Notification permission granted</span>
                  : permission === 'unsupported' ? <span className="error" style={{ marginTop: 6 }}>This browser has no Notification API.</span>
                  : permission === 'denied' ? <span className="error" style={{ marginTop: 6 }}>Notifications are blocked for this site. Allow them in the browser's site settings, then reload.</span>
                  : <span style={{ marginTop: 6 }}><span className="btn" role="button" onClick={(e) => { e.stopPropagation(); onRequestPermission(); }}>Grant permission</span></span>
                )}
              </span>
            </button>
          ))}
        </div>
      </Card>

      <Card title="Appearance">
        <div className="fields-row">
          <div className="field">
            <span className="lbl">Theme</span>
            <Seg<Theme> value={settings.theme} options={[{ v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }, { v: 'auto', label: 'Auto' }]} onPick={(theme) => onChange({ theme })} />
            <span className="hint">Auto follows the Windows light/dark setting.</span>
          </div>
          <div className="field">
            <span className="lbl">Font size</span>
            <Seg<FontSize> value={settings.fontSize} options={[{ v: 'small', label: 'Small' }, { v: 'medium', label: 'Medium' }, { v: 'large', label: 'Large' }]} onPick={(fontSize) => onChange({ fontSize })} />
          </div>
          <div className="field">
            <span className="lbl">Density</span>
            <Seg<Density> value={settings.density} options={[{ v: 'comfortable', label: 'Comfortable' }, { v: 'compact', label: 'Compact' }]} onPick={(density) => onChange({ density })} />
          </div>
        </div>
      </Card>

      <Card title="Polling">
        {config && (
          <div className="kv">
            <span>GitHub</span><span className="mono muted">every {config.intervals.github} s</span>
            <span>Codemagic</span><span className="mono muted">every {config.intervals.codemagic} s · 30 s while building</span>
            <span>Lark Base · 3 views</span><span className="mono muted">every {config.intervals.lark} s</span>
            <span>App Store · Google Play</span><span className="mono muted">every {config.intervals.appstore} s</span>
          </div>
        )}
        <span className="hint">Intervals, the GitHub account and the Lark column names are set in config/dashboard.config.json; the Lark Base and its views are picked under Lark Base above. Sign-ins and the Codemagic token are managed under Connections; store accounts below.</span>
      </Card>
    </>
  );
}
