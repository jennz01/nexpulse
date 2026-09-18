import { useState } from 'react';
import { ConnectionsCard } from '../auth/ConnectionsCard';
import { currentPermission, requestPermission } from '../notify';
import { LarkBaseCard } from '../settings/LarkBaseCard';
import { Preferences } from '../settings/Preferences';
import { ReposCard } from '../settings/ReposCard';
import { StoreAccounts } from '../settings/StoreAccounts';
import type { PageContext } from './context';

export function SettingsPage({ state, settings, patchSettings, reload, auth, refreshAuth, openLogin }: PageContext) {
  const [permission, setPermission] = useState(currentPermission());
  return (
    <main className="single settings">
      <ConnectionsCard status={auth} onRefresh={refreshAuth} openLogin={openLogin} onCodemagicChanged={reload} />
      <ReposCard selected={state.config?.githubRepos ?? []} onSaved={reload} />
      <LarkBaseCard base={state.config?.larkBase} onSaved={reload} />
      <Preferences settings={settings} onChange={patchSettings} permission={permission} onRequestPermission={() => void requestPermission().then(setPermission)} config={state.config} />
      <StoreAccounts state={state} reload={reload} />
    </main>
  );
}
