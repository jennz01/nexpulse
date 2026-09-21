import type { AuthProvider, AuthStatus, CodemagicTokenStatus, LarkAttachment, LarkBaseInfo, LarkBaseInput, LarkCommentsResponse, LarkTableInfo, LarkViewInfo, LoginState, RepoInfo, SourceId, SseMessage, StateResponse, StoreAccountInput, StoreAccountView, StoreTestResult } from '../../shared/types';

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

/** One record's comment threads. Read when the dialog opens rather than polled, so they are current at that moment. */
export const fetchRecordComments = async (table: 'tasks' | 'issues' | 'feedback', recordId: string): Promise<LarkCommentsResponse> =>
  json<LarkCommentsResponse>(await fetch(`/api/lark/comments/${table}/${encodeURIComponent(recordId)}`));

/** An image pasted into a comment; the server downloads and caches it by token. */
export const commentImageUrl = (token: string): string => `/api/lark/comment-images/${encodeURIComponent(token)}`;

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

// ---- gh / lark-cli sessions (Settings → Connections, banner) ----
export async function fetchAuthStatus(fresh = false): Promise<AuthStatus> {
  return json<AuthStatus>(await fetch(`/api/auth/status${fresh ? '?fresh=1' : ''}`));
}
export const getLogin = async (provider: AuthProvider): Promise<LoginState> => json<LoginState>(await fetch(`/api/auth/${provider}/login`));
export const startLogin = async (provider: AuthProvider): Promise<LoginState> => json<LoginState>(await fetch(`/api/auth/${provider}/login`, { method: 'POST', headers: POST_HEADERS }));
export const cancelLogin = async (provider: AuthProvider): Promise<LoginState> => json<LoginState>(await fetch(`/api/auth/${provider}/login`, { method: 'DELETE', headers: POST_HEADERS }));
export const switchGithubAccount = async (): Promise<AuthStatus> => json<AuthStatus>(await fetch('/api/auth/github/switch', { method: 'POST', headers: POST_HEADERS }));

// ---- Repositories for the Pull Requests panel's All tab (Settings → Pull requests) ----
export const fetchGithubRepos = async (): Promise<{ repos: RepoInfo[]; selected: string[] }> => json(await fetch('/api/github/repos'));
export const saveGithubRepos = async (repos: string[]): Promise<{ selected: string[] }> => json(await fetch('/api/github/repos', { method: 'PUT', headers: JSON_POST, body: JSON.stringify({ repos }) }));

// ---- The Lark Base behind the Lark panels (Settings → Lark Base) ----
export const fetchLarkBase = async (): Promise<{ base: LarkBaseInfo; tables: LarkTableInfo[] }> => json(await fetch('/api/lark/base'));
export const fetchLarkViews = async (tableId: string): Promise<{ views: LarkViewInfo[] }> => json(await fetch(`/api/lark/views/${encodeURIComponent(tableId)}`));
export const saveLarkBase = async (input: LarkBaseInput): Promise<{ base: LarkBaseInfo }> =>
  json(await fetch('/api/lark/base', { method: 'PUT', headers: JSON_POST, body: JSON.stringify(input) }));

// ---- Codemagic API token (Settings → Connections) ----
export const fetchCodemagicToken = async (): Promise<CodemagicTokenStatus> => json<CodemagicTokenStatus>(await fetch('/api/codemagic/token'));
export const testCodemagicToken = async (token: string): Promise<{ apps: number }> => json<{ apps: number }>(await fetch('/api/codemagic/token/test', { method: 'POST', headers: JSON_POST, body: JSON.stringify({ token }) }));
export const saveCodemagicToken = async (token: string): Promise<CodemagicTokenStatus> => json<CodemagicTokenStatus>(await fetch('/api/codemagic/token', { method: 'PUT', headers: JSON_POST, body: JSON.stringify({ token }) }));
export const removeCodemagicToken = async (): Promise<CodemagicTokenStatus> => json<CodemagicTokenStatus>(await fetch('/api/codemagic/token', { method: 'DELETE', headers: POST_HEADERS }));
