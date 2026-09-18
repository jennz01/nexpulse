import { emptyStates } from '../../shared/attention';
import type { Event, PanelId, PublicConfig, SourceId, SourceStates, SseMessage, StateResponse } from '../../shared/types';

export type Connection = 'connecting' | 'live' | 'offline';

export interface DashboardState {
  loaded: boolean;
  states: SourceStates;
  events: Event[]; // unseen
  config: PublicConfig | null;
  connection: Connection;
  lastMessageAt: number | null;
  error: string | null;
}

export type Action =
  | { type: 'loaded'; payload: StateResponse }
  | { type: 'sse'; payload: SseMessage; now: number }
  | { type: 'seen'; ids: number[] }
  | { type: 'seenSource'; source: SourceId }
  | { type: 'connection'; status: Connection }
  | { type: 'error'; message: string };

export const initialState: DashboardState = { loaded: false, states: emptyStates(), events: [], config: null, connection: 'connecting', lastMessageAt: null, error: null };

function mergeEvents(existing: Event[], incoming: Event[]): Event[] {
  const ids = new Set(existing.map((e) => e.id));
  return [...existing, ...incoming.filter((e) => !ids.has(e.id))];
}

export function reducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case 'loaded':
      return { ...state, loaded: true, states: action.payload.states, events: action.payload.events, config: action.payload.config, error: null };
    case 'sse': {
      const { source, state: incoming, events, config } = action.payload;
      const prev = state.states[source];
      return {
        ...state,
        config: config ?? state.config,
        lastMessageAt: action.now,
        states: { ...state.states, [source]: { ...incoming, disabled: prev.disabled } } as SourceStates,
        events: mergeEvents(state.events, events),
      };
    }
    case 'seen': {
      const ids = new Set(action.ids);
      return { ...state, events: state.events.filter((e) => !ids.has(e.id)) };
    }
    case 'seenSource':
      return { ...state, events: state.events.filter((e) => e.source !== action.source) };
    case 'connection':
      return { ...state, connection: action.status };
    case 'error':
      return { ...state, error: action.message };
  }
}

const KIND_PANEL: Record<string, PanelId> = { pr: 'prs', build: 'builds', issue: 'issues', feedback: 'feedback', store: 'stores' };

export function panelForEvent(e: Event): PanelId | null {
  return KIND_PANEL[e.kind.split('.')[0] ?? ''] ?? null;
}

export function unreadByPanel(events: Event[]): Record<PanelId, Event[]> {
  const out: Record<PanelId, Event[]> = { prs: [], builds: [], tasks: [], issues: [], feedback: [], stores: [] };
  for (const e of events) {
    const panel = panelForEvent(e);
    if (panel) out[panel].push(e);
  }
  return out;
}

/** itemId -> ids of unseen events about it, for one panel. Rows use this to highlight and to mark seen on click. */
export function unreadItems(events: Event[], panel: PanelId): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const e of events) {
    if (panelForEvent(e) !== panel) continue;
    out.set(e.itemId, [...(out.get(e.itemId) ?? []), e.id]);
  }
  return out;
}
