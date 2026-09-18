import type { Dispatch, SetStateAction } from 'react';
import type { AttentionChip, Event, PanelId, PublicConfig, SourceId } from '../../../shared/types';
import type { HomeLayout } from '../layout/layout';
import type { Settings } from '../settings/useSettings';
import type { DashboardState } from '../state';

/** Everything a page needs from the app shell. */
export interface PageContext {
  state: DashboardState;
  now: number;
  intervals: PublicConfig['intervals'];
  /** Unseen events per panel; already emptied when the alert mode is off. */
  unread: Record<PanelId, Event[]>;
  showUnread: boolean;
  chips: AttentionChip[];
  settings: Settings;
  patchSettings: (patch: Partial<Settings>) => void;
  /** Which panels Home shows, in what order, size and colour. */
  layout: HomeLayout;
  setLayout: Dispatch<SetStateAction<HomeLayout>>;
  /** Home is in customize mode: cards show their grips, handles and options instead of reacting to clicks. */
  customizing: boolean;
  setCustomizing: (on: boolean) => void;
  seeIds: (ids: number[]) => void;
  seeSource: (source: SourceId) => void;
  /** Switch to the page that hosts a panel and scroll it into view. */
  navigate: (panel: PanelId) => void;
  /** Re-fetch the whole state from the server (after a config change). */
  reload: () => void;
}
