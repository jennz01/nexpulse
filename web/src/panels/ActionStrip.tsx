import type { AttentionChip, PanelId } from '../../../shared/types';

export function ActionStrip({ chips, onNavigate }: { chips: AttentionChip[]; onNavigate: (panel: PanelId) => void }) {
  return (
    <section className="strip" aria-label="Needs attention">
      <span className="strip-label">NEEDS ATTENTION</span>
      {chips.length === 0 && <span className="meta">Nothing needs you right now.</span>}
      {chips.map((c) => (
        <button key={c.id} className={`chip ${c.tone}`} onClick={() => onNavigate(c.target)}>
          <i className={`dot ${c.tone === 'grey' && c.pulse ? 'blue' : c.tone} ${c.pulse ? 'pulse' : ''}`} />
          {c.text}
          {c.detail && <span className="mono">{c.detail}</span>}
        </button>
      ))}
    </section>
  );
}
