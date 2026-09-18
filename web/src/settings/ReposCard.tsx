import { useEffect, useRef, useState } from 'react';
import type { RepoInfo } from '../../../shared/types';
import { fetchGithubRepos, saveGithubRepos } from '../api';
import { IconCheck, IconRefresh } from '../icons';
import { relativeTime } from '../time';
import { Card } from './Preferences';

const MAX = 50;

interface Props {
  /** The saved selection (config github.repos). */
  selected: string[];
  /** After a save, so the host refetches the state and the panel picks up the new list. */
  onSaved: () => void;
}

/** Settings card: tick the repositories whose open PRs the Pull Requests panel's All tab should list. */
export function ReposCard({ selected, onSaved }: Props) {
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(selected));
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /** Set once the user ticks anything, so a slow (or duplicated, in dev StrictMode) initial load cannot undo it. */
  const touched = useRef(false);

  const load = async (reset = false) => {
    setError(null);
    setRepos(null);
    try {
      const r = await fetchGithubRepos();
      setRepos(r.repos);
      if (reset || !touched.current) { setPicked(new Set(r.selected)); touched.current = false; }
    } catch (e) {
      setError((e as Error).message);
      setRepos([]);
    }
  };
  useEffect(() => { void load(); }, []);

  const dirty = picked.size !== selected.length || selected.some((s) => !picked.has(s));
  const q = filter.trim().toLowerCase();
  const known = new Set((repos ?? []).map((r) => r.name));
  // Repositories still selected but no longer visible to this account stay listed so they can be unticked.
  const orphans: (RepoInfo & { missing: true })[] = [...picked].filter((n) => !known.has(n)).map((name) => ({ name, private: false, archived: false, pushedAt: null, openPRs: 0, missing: true }));
  const rows: (RepoInfo & { missing?: true })[] = [...orphans, ...(repos ?? [])]
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .sort((a, b) => Number(picked.has(b.name)) - Number(picked.has(a.name)) || (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));

  const toggle = (name: string, on: boolean) => setPicked((prev) => {
    touched.current = true;
    const next = new Set(prev);
    if (on) { if (next.size >= MAX) return prev; next.add(name); } else next.delete(name);
    return next;
  });
  const save = async () => {
    setSaving(true);
    setSaved(null);
    setError(null);
    try {
      const r = await saveGithubRepos([...picked]);
      setPicked(new Set(r.selected));
      setSaved(`Saved ${r.selected.length} ${r.selected.length === 1 ? 'repository' : 'repositories'} · polling now`);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Pull requests" count={`${picked.size} of ${MAX} selected`}
      right={<>
        <button className="btn" disabled={repos === null} onClick={() => void load(true)}><IconRefresh size={14} />Reload list</button>
        <button className="btn primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
      </>}>
      <span className="hint">The All tab of the Pull Requests panel lists every open PR in the repositories ticked here, newest activity first. Review requested and Mine always cover everything your account can see. The list comes from GitHub for the account gh is signed in as.</span>
      <input className="search" type="search" placeholder="Filter repositories…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {error && <span className="error">{error}</span>}
      {repos === null && !error && <span className="waiting"><i className="dot blue pulse" />Loading repositories from GitHub…</span>}
      {repos && (
        <div className="repos" role="list">
          {rows.map((r) => (
            <label key={r.name} className={`repo ${picked.has(r.name) ? 'on' : ''}`}>
              <input type="checkbox" checked={picked.has(r.name)} onChange={(e) => toggle(r.name, e.target.checked)} />
              <span className="repo-name mono">{r.name}</span>
              {r.private && <span className="tag plain">private</span>}
              {r.archived && <span className="tag plain">archived</span>}
              {r.missing && <span className="tag warn">not visible to this account</span>}
              <span className="meta repo-meta">{r.missing ? '' : `${r.openPRs ? `${r.openPRs} open PR${r.openPRs === 1 ? '' : 's'}` : 'no open PRs'}${r.pushedAt ? ` · pushed ${relativeTime(r.pushedAt, Date.now())}` : ''}`}</span>
            </label>
          ))}
          {rows.length === 0 && <span className="note">No repositories match.</span>}
        </div>
      )}
      {saved && <span className="ok"><IconCheck size={12} />{saved}</span>}
    </Card>
  );
}
