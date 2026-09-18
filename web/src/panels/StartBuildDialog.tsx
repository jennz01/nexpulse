import { useState } from 'react';
import type { CodemagicSnapshot } from '../../../shared/types';
import { triggerBuild } from '../api';
import { IconPlay } from '../icons';

interface Props { snapshot: CodemagicSnapshot; onClose: () => void; onStarted: (buildId: string) => void }

export function StartBuildDialog({ snapshot, onClose, onStarted }: Props) {
  const firstApp = snapshot.apps[0];
  const [appId, setAppId] = useState(firstApp?.id ?? '');
  const app = snapshot.apps.find((a) => a.id === appId) ?? firstApp;
  const defaultWorkflow = (a = app) => a?.workflows[0]?.id ?? '';
  const defaultBranch = (a = app, wf = defaultWorkflow(a)) => a?.builds.find((b) => b.workflowId === wf)?.branch ?? 'main';
  const [workflowId, setWorkflowId] = useState(defaultWorkflow());
  const [branch, setBranch] = useState(defaultBranch());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickApp = (id: string) => {
    const a = snapshot.apps.find((x) => x.id === id);
    setAppId(id);
    const wf = defaultWorkflow(a);
    setWorkflowId(wf);
    setBranch(defaultBranch(a, wf));
  };
  const pickWorkflow = (wf: string) => { setWorkflowId(wf); setBranch(defaultBranch(app, wf)); };

  const submit = async () => {
    if (!app || !workflowId || !branch.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { buildId } = await triggerBuild({ appId: app.id, workflowId, branch: branch.trim() });
      onStarted(buildId);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dlg" role="dialog" aria-label="Start build" onClick={(e) => e.stopPropagation()}>
        <div className="dlg-h">Start build<span className="hint">Codemagic</span></div>
        <div className="dlg-body">
          <label className="field"><span className="lbl">App</span>
            <select value={appId} onChange={(e) => pickApp(e.target.value)}>{snapshot.apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          </label>
          <label className="field"><span className="lbl">Workflow</span>
            <select value={workflowId} onChange={(e) => pickWorkflow(e.target.value)}>{(app?.workflows ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          </label>
          <label className="field"><span className="lbl">Branch</span>
            <input className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
            <span className="hint">Defaults to the branch of this workflow's most recent build.</span>
          </label>
          {error && <span className="error" role="alert">{error}</span>}
        </div>
        <div className="dlg-f">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || !workflowId || !branch.trim()}><IconPlay size={12} />{busy ? 'Starting…' : 'Start build'}</button>
        </div>
      </div>
    </div>
  );
}
