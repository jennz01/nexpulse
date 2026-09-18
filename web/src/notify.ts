import type { Event } from '../../shared/types';
import type { AlertMode } from './settings/useSettings';

export function currentPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export async function requestPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

/** Toast mode: one native notification per high-priority event. Normal events only badge (spec §6). */
export function notifyHighEvents(events: Event[], mode: AlertMode, onClick: (e: Event) => void, ctor: typeof Notification | undefined = typeof Notification === 'undefined' ? undefined : Notification): void {
  if (mode !== 'toast' || !ctor || ctor.permission !== 'granted') return;
  for (const e of events) {
    if (e.priority !== 'high') continue;
    const n = new ctor(e.title, { body: `${e.source} · ${e.kind}`, tag: `${e.source}:${e.itemId}` });
    n.onclick = () => { window.focus(); onClick(e); n.close(); };
  }
}

/** Events to toast this run: none on the first load (badges only), otherwise those not seen before. Marks every event seen. */
export function toastable(events: Event[], seen: Set<number>, firstLoad: boolean): Event[] {
  const fresh = events.filter((e) => !seen.has(e.id));
  for (const e of events) seen.add(e.id);
  return firstLoad ? [] : fresh;
}

export function updateTitle(unread: number, mode: AlertMode): void {
  document.title = mode === 'off' || unread === 0 ? 'NexPulse' : `(${unread}) NexPulse`;
}
