import { useState } from 'react';
import { currentPermission, requestPermission } from '../notify';
import { Preferences } from '../settings/Preferences';
import { StoreAccounts } from '../settings/StoreAccounts';
import type { PageContext } from './context';

export function SettingsPage({ state, settings, patchSettings, reload }: PageContext) {
  const [permission, setPermission] = useState(currentPermission());
  return (
    <main className="single settings">
      <Preferences settings={settings} onChange={patchSettings} permission={permission} onRequestPermission={() => void requestPermission().then(setPermission)} config={state.config} />
      <StoreAccounts state={state} reload={reload} />
    </main>
  );
}
