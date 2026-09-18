import type { LarkAttachment, SourceId, SseMessage, StateResponse, StoreAccountInput, StoreAccountView, StoreTestResult } from '../../shared/types';

const POST_HEADERS = { 'x-requested-with': 'dashboard' };

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export async function fetchState(): Promise<StateResponse> {
  return json<StateResponse>(await fetch('/api/state'));
}

/** Opens the SSE stream. Returns a function that closes it. The browser reconnects on its own; every reconnect re-fires 'live'. */
export function openEvents(onMessage: (m: SseMessage) => void, onStatus: (s: 'live' | 'offline') => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => onStatus('live'));
  es.addEventListener('update', (ev) => onMessage(JSON.parse((ev as MessageEvent<string>).data) as SseMessage));
  es.onerror = () => onStatus('offline');
  return () => es.close();
}

export async function markSeen(body: { ids?: number[]; source?: SourceId }): Promise<void> {
  await fetch('/api/events/seen', { method: 'POST', headers: { 'content-type': 'application/json', ...POST_HEADERS }, body: JSON.stringify(body) });
}

export async function refreshSource(id: SourceId): Promise<void> {
  await json(await fetch(`/api/sources/${id}/refresh`, { method: 'POST', headers: POST_HEADERS }));
}

export async function triggerBuild(input: { appId: string; workflowId: string; branch: string }): Promise<{ buildId: string }> {
  return json<{ buildId: string }>(await fetch('/api/codemagic/builds', { method: 'POST', headers: { 'content-type': 'application/json', ...POST_HEADERS }, body: JSON.stringify(input) }));
}

export const artifactUrl = (buildId: string, index: number): string => `/api/codemagic/artifacts/${encodeURIComponent(buildId)}/${index}`;

/** A Base attachment, fetched and cached by the server; the trailing name only picks the content type and the title browsers show. */
export const attachmentUrl = (table: 'tasks' | 'issues' | 'feedback', recordId: string, a: LarkAttachment): string =>
  `/api/lark/attachments/${table}/${encodeURIComponent(recordId)}/${encodeURIComponent(a.token)}/${encodeURIComponent(a.name)}`;

// ---- Store accounts (Settings page) ----
const JSON_POST = { 'content-type': 'application/json', ...POST_HEADERS };

export async function listStoreAccounts(): Promise<StoreAccountView[]> {
  return json<StoreAccountView[]>(await fetch('/api/stores/accounts'));
}

export async function saveStoreAccount(input: StoreAccountInput): Promise<StoreAccountView[]> {
  return json<StoreAccountView[]>(await fetch('/api/stores/accounts', { method: 'POST', headers: JSON_POST, body: JSON.stringify(input) }));
}

export async function removeStoreAccount(name: string): Promise<StoreAccountView[]> {
  return json<StoreAccountView[]>(await fetch(`/api/stores/accounts/${encodeURIComponent(name)}`, { method: 'DELETE', headers: POST_HEADERS }));
}

export async function testStoreAccount(input: StoreAccountInput): Promise<StoreTestResult> {
  return json<StoreTestResult>(await fetch('/api/stores/test', { method: 'POST', headers: JSON_POST, body: JSON.stringify(input) }));
}
