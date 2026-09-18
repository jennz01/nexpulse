// shared/status.ts — status vocabularies shared by server sources and the web UI.

export const BUILD_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'canceled', 'timeout', 'skipped', 'warning']);
export const isBuildRunning = (status: string): boolean => !BUILD_TERMINAL_STATUSES.has(status);
export const isBuildFailed = (status: string): boolean => status === 'failed' || status === 'timeout';

// ---- App Store Connect appStoreVersion states ----
export const APPSTORE_LIVE_STATES: ReadonlySet<string> = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION']);
export const APPSTORE_DEAD_STATES: ReadonlySet<string> = new Set(['REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'NOT_APPLICABLE']);
export const APPSTORE_REJECTED_STATES: ReadonlySet<string> = new Set(['REJECTED', 'METADATA_REJECTED', 'DEVELOPER_REJECTED', 'INVALID_BINARY']);
/** States that put a chip in the attention strip (spec §5.4). */
export const APPSTORE_ATTENTION_STATES: ReadonlySet<string> = new Set([
  'WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', ...APPSTORE_REJECTED_STATES,
]);
/** States whose arrival is a high-priority event (spec §5.4). */
export const APPSTORE_HIGH_STATES: ReadonlySet<string> = new Set(['PENDING_DEVELOPER_RELEASE', ...APPSTORE_REJECTED_STATES]);

const SMALL_WORDS = new Set(['for', 'of', 'to', 'with']);
/** 'READY_FOR_SALE' -> 'Ready for Sale'; 'inProgress' -> 'In progress'. */
export function humanState(state: string): string {
  if (!state) return '';
  if (state.includes('_') || state === state.toUpperCase()) {
    return state
      .toLowerCase()
      .split('_')
      .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ');
  }
  const spaced = state.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ---- Google Play track release statuses ----
export const PLAY_ATTENTION_STATUSES: ReadonlySet<string> = new Set(['inProgress', 'halted']);
