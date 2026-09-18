// shared/types.ts — shapes shared by server and web.

export type SourceId = 'github' | 'codemagic' | 'lark' | 'appstore' | 'playstore';
export const SOURCE_IDS: readonly SourceId[] = ['github', 'codemagic', 'lark', 'appstore', 'playstore'];

export type Priority = 'high' | 'normal';

/** What a source's diff() produces. The store assigns id, createdAt and seen. */
export interface NewEvent {
  source: SourceId;
  kind: string;
  priority: Priority;
  itemId: string;
  title: string;
  url: string | null;
}
export interface Event extends NewEvent {
  id: number;
  createdAt: number;
  seen: boolean;
}

// ---- GitHub ----
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type CiState = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;
export interface PullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
  authorAvatarUrl: string;
  repo: string; // owner/name
  reviewDecision: ReviewDecision;
  ci: CiState;
}
export interface GithubSnapshot {
  login: string;
  incoming: PullRequest[];
  mine: PullRequest[];
  /** Every open PR in the configured repositories (`github.repos`), most recently updated first. Absent in snapshots stored before the setting existed. */
  all?: PullRequest[];
}
/** A repository the signed-in GitHub account can see, for the Settings picker. */
export interface RepoInfo {
  name: string; // owner/name
  private: boolean;
  archived: boolean;
  pushedAt: string | null;
  openPRs: number;
}

// ---- Codemagic ----
export interface BuildArtifact {
  name: string;
  type: string;
  url: string;
  size: number | null;
}
export interface Build {
  id: string;
  appId: string;
  workflowId: string;
  workflowName: string;
  branch: string;
  status: string; // queued | preparing | fetching | building | testing | publishing | finishing | finished | failed | canceled | timeout | skipped | warning
  startedAt: string | null;
  finishedAt: string | null;
  durationSec: number | null;
  /** Codemagic user id of whoever triggered the build; an opaque id, kept for completeness. */
  startedBy: string | null;
  url: string;
  artifacts: BuildArtifact[];
  // Optional: added after the first snapshots were stored, so older persisted builds lack them.
  /** Commit author name, the readable "by". */
  author?: string | null;
  /** First line of the commit message. */
  commitMessage?: string | null;
  /** App version the build produced, e.g. "1.0.68". */
  version?: string | null;
  /** Codemagic's running build number for the app. */
  buildNumber?: number | null;
}
export interface CodemagicWorkflow {
  id: string;
  name: string;
}
export interface CodemagicApp {
  id: string;
  name: string;
  workflows: CodemagicWorkflow[];
  builds: Build[]; // newest first, max 10
}
export interface CodemagicSnapshot {
  apps: CodemagicApp[];
}

// ---- Lark Base ----
export interface LarkAttachment {
  /** Base file token; immutable, so it doubles as the cache key. */
  token: string;
  name: string;
  size: number;
}
export interface LarkRecord {
  recordId: string;
  url: string;
  /** logical field name (title, status, ...) -> display string */
  fields: Record<string, string>;
  /** Files in the table's mapped attachment column; present only when the column is configured. Served by /api/lark/attachments. */
  attachments?: LarkAttachment[];
}
export interface LarkGroup {
  status: string;
  records: LarkRecord[];
}
export interface LarkSnapshot {
  tasks: { groups: LarkGroup[]; total: number };
  issues: { groups: LarkGroup[]; counts: Record<string, number> };
  feedback: { records: LarkRecord[] };
}

// ---- App Store Connect ----
export interface AppStoreVersion {
  version: string;
  state: string;
}
export interface AppStoreApp {
  account: string;
  appId: string;
  name: string;
  bundleId: string;
  live: AppStoreVersion | null;
  inflight: AppStoreVersion | null;
  url: string;
}
export interface AppStoreSnapshot {
  apps: AppStoreApp[];
}

// ---- Google Play ----
export interface PlayRelease {
  track: string;
  name: string | null;
  versionCodes: string[];
  status: string; // draft | inProgress | halted | completed | statusUnspecified
  userFraction: number | null;
}
export interface PlayApp {
  account: string;
  packageName: string;
  name: string;
  releases: PlayRelease[];
  url: string;
}
export interface PlaySnapshot {
  apps: PlayApp[];
}

// ---- Cross-source state ----
export interface SnapshotBySource {
  github: GithubSnapshot;
  codemagic: CodemagicSnapshot;
  lark: LarkSnapshot;
  appstore: AppStoreSnapshot;
  playstore: PlaySnapshot;
}
export interface SourceState<S = unknown> {
  snapshot: S | null;
  fetchedAt: number | null;
  error: string | null;
  errorAt: number | null;
  /** non-null when the source is switched off by config validation */
  disabled: string | null;
}
export type SourceStates = { [K in SourceId]: SourceState<SnapshotBySource[K]> };

export interface PublicConfig {
  intervals: Record<SourceId, number>;
  larkDomain: string;
  accounts: string[];
  pendingLaunchStatus: string;
  collapsedStatuses: string[];
  showIssueStatuses: string[];
  /** Lark Base form that creates an R&D Task row; null when not configured (no "Create task" button). */
  taskFormUrl: string | null;
  /** Merchant Feedback groups (by R&D status) shown first, in this order; the rest follow by first appearance. */
  feedbackGroupOrder: string[];
  /** Repositories whose open PRs fill the Pull Requests panel's All tab (owner/name). */
  githubRepos: string[];
}
export interface StateResponse {
  states: SourceStates;
  events: Event[]; // unseen only
  config: PublicConfig;
}
export interface SseMessage {
  source: SourceId;
  state: SourceState;
  events: Event[];
}

// ---- Authorization: the gh and lark-cli sessions the sources depend on ----
export type AuthProvider = 'github' | 'lark';
export interface ProviderStatus {
  /** ok: signed in as expected; expired/missing: no usable session; wrong-account: gh is signed in as someone else; unknown: the CLI could not answer (offline, not installed). */
  state: 'ok' | 'expired' | 'missing' | 'wrong-account' | 'unknown';
  account: string | null;
  /** GitHub only: the login the config expects. */
  expected?: string;
  /** Lark only: when the current session stops refreshing itself (ISO string), if lark-cli reports it. */
  sessionUntil?: string | null;
  detail: string | null;
}
export interface AuthStatus {
  github: ProviderStatus;
  lark: ProviderStatus;
  checkedAt: number;
}
/** The Codemagic API token kept in config/secrets/.env, as the Settings page sees it (never the token itself). */
export interface CodemagicTokenStatus {
  configured: boolean;
  /** First 3 and last 4 characters of the stored token. */
  masked: string | null;
  /** `codemagic.enabled` in the config; false means the panel is switched off regardless of the token. */
  enabled: boolean;
  /** Apps in the last successful poll, when there was one. */
  apps: number | null;
  /** Why the source is disabled, when it is. */
  error: string | null;
}
/** A device-code sign-in driven by the server: the user copies `code` to `url`, the CLI waits, the server reports the outcome. */
export interface LoginState {
  phase: 'idle' | 'starting' | 'waiting' | 'done' | 'failed';
  code?: string;
  url?: string;
  message?: string;
  startedAt?: number;
}

// ---- UI ----
export type PanelId = 'prs' | 'builds' | 'tasks' | 'issues' | 'feedback' | 'stores';
export type Tone = 'red' | 'amber' | 'blue' | 'grey';
export interface AttentionChip {
  id: string;
  text: string;
  detail: string | null;
  tone: Tone;
  target: PanelId;
  pulse: boolean;
}

// ---- Store account management (Settings page) ----
export interface StorePlayAppInput { packageName: string; name: string; consoleUrl?: string }
/** What the Settings form sends. Key material travels only browser -> server, never back. */
export interface StoreAccountInput {
  name: string;
  /** Name of the account being edited; omitted when creating. */
  originalName?: string;
  /** keyPem may be omitted when editing to keep the stored key. */
  appstore: { issuerId: string; keyId: string; keyPem?: string } | null;
  /** serviceAccountJson may be omitted when editing to keep the stored file. */
  play: { developerId: string; serviceAccountJson?: string; apps: StorePlayAppInput[] } | null;
}
/** Secret-free view of a configured account. */
export interface StoreAccountView {
  name: string;
  appstore: { issuerId: string; keyId: string; keyFile: string; keyPresent: boolean } | null;
  play: { developerId: string; serviceAccountFile: string; filePresent: boolean; clientEmail: string | null; apps: StorePlayAppInput[] } | null;
}
export interface StoreTestResult {
  appstore: { ok: boolean; apps: string[]; error: string | null } | null;
  play: { ok: boolean; apps: { packageName: string; ok: boolean; releases: number; error: string | null }[]; error: string | null } | null;
}
