# Personal Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web dashboard on `http://127.0.0.1:6600` that polls GitHub, Codemagic, Lark Base, App Store Connect and Google Play in the background, caches snapshots in SQLite, diffs them into events, pushes updates to the browser over SSE, and renders six panels plus a "needs attention" strip with alert and appearance settings.

**Architecture:** One Bun process runs a Hono HTTP app and a scheduler with one polling loop per source. Each source module implements the same `fetch` / `diff` contract and never touches storage; the scheduler saves snapshots and events to SQLite and broadcasts them. A Vite-built React app loads everything from `/api/state`, then patches per SSE message; alert and appearance settings live in the browser's localStorage.

**Tech Stack:** Bun ≥ 1.3 (runtime, test runner, `bun:sqlite`), Hono 4, zod 4, React 19, Vite 8, TypeScript 5, `@fontsource/ibm-plex-sans` + `@fontsource/ibm-plex-mono`, `@testing-library/react` + `@happy-dom/global-registrator` for component tests. External CLIs: `gh` (GitHub CLI, already logged in as `jennsg`), `lark-cli` 1.0.49 (already logged in). No Node-only APIs; everything runs under Bun.

**Spec:** `docs/superpowers/specs/2026-09-17-personal-dashboard-design.md` — read it first. Section numbers below refer to it. The approved visual mockup lives on the private design canvas linked from the spec (its source boards were later removed from the repo); copy its CSS values, do not reinterpret them.

## Global Constraints

- Server binds to `127.0.0.1` only, port from config, default **6600** (spec §2, §3.1). Never 6666 (browsers block 6665–6669).
- Windows 11 is the target machine. Shell scripts in `package.json` must work under `cmd.exe`; no `&&`-chained background jobs, no bash-isms. Use `concurrently` for parallel dev processes.
- All code is TypeScript with `"strict": true`. No `any` except where a third-party payload is parsed, and then it is narrowed immediately.
- Secrets never leave `config/secrets/` (gitignored) and are never sent to the browser. The Codemagic token, `.p8` keys and Play service-account JSON are read server-side only (spec §7).
- Sources implement `Source<S, C>` from `server/sources/types.ts` and do not import `Store` or `SseHub` (spec §3.3).
- Every source separates a pure `parse*` step from network I/O so fixtures can drive tests (spec §9).
- First poll after an empty database creates no events (spec §6): `diff(null, next)` returns `[]` in every source, and the scheduler also skips diff when there is no previous snapshot.
- Event kinds and priorities are exactly the table in spec §6: `pr.review_requested` high, `pr.review_decision` normal, `pr.ci_failed` normal, `build.failed` high, `build.finished` normal, `issue.opened` high, `feedback.new` normal, `store.state_changed` high or normal.
- Polling defaults: github 60 s, codemagic 120 s (30 s while a build runs), lark 120 s, stores 600 s. Backoff doubles per consecutive failure, capped at 600 s (spec §3.4).
- CLI spawns time out at 60 s (spec §8).
- UI sizes in `rem`; root font size is the Appearance setting 14 / 16 / 18 px; colour tokens are the table in spec §4.5, verbatim.
- Icons are inline stroke SVG; no emoji, no icon fonts (spec §4.5).
- Commit after every task with a conventional-commit message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commit as the repo's existing author (`git log -1 --format='%an <%ae>'`).
- Run `bun test` before every commit; it must pass.

## File Structure

```
personal-dashboard/
  package.json, tsconfig.json, bunfig.toml
  shared/
    types.ts            all cross-tier types (snapshots, events, state, chips)
    stores.ts           App Store / Play state constants shared by server diff and web attention
    attention.ts        pure: SourceStates -> AttentionChip[]
  server/
    index.ts            entry: load config, build sources, start scheduler, Bun.serve
    app.ts              createApp(): Hono routes
    config.ts           zod schema, loadConfig(), validateSources(), publicConfig()
    store.ts            Store class over bun:sqlite
    scheduler.ts        Scheduler class: per-source loops, backoff, refresh()
    sse.ts              SseHub: client set + broadcast
    proc.ts             run(): spawn CLIs with timeout, stdin, Windows .cmd shim handling
    jwt.ts              base64url, PEM->DER, signJwt (ES256 / RS256) via WebCrypto
    check.ts            `bun run check`: hit every configured source once, print table
    sources/
      types.ts          Source, SourceContext, RegisteredSource
      index.ts          buildSources(loaded): RegisteredSource[]
      github.ts         gh api graphql -> GithubSnapshot
      codemagic.ts      Codemagic REST -> CodemagicSnapshot, triggerBuild, artifact proxy
      lark.ts           lark-cli base +record-list -> LarkSnapshot
      appstore.ts       App Store Connect API -> AppStoreSnapshot
      playstore.ts      Google Play Developer API -> PlaySnapshot
      __fixtures__/     recorded JSON, secrets and personal data scrubbed
  web/
    index.html, vite.config.ts
    test/setup.ts       happy-dom registration for bun test
    src/
      main.tsx, App.tsx, styles.css
      api.ts            fetchState(), openEvents(), markSeen(), refreshSource(), triggerBuild()
      state.ts          reducer: StateResponse + SseMessage -> DashboardState
      time.ts           relative-time and duration formatting
      icons.tsx         the inline SVG icon set
      panels/Panel.tsx  shared panel chrome (header, count, unread, refresh, open link)
      panels/ActionStrip.tsx, PullRequests.tsx, Builds.tsx, StartBuildDialog.tsx,
             Tasks.tsx, Issues.tsx, Feedback.tsx, Stores.tsx
      settings/useSettings.ts, SettingsDrawer.tsx
      notify.ts         alert-mode side effects: Notification API, document.title badge
  config/
    dashboard.config.example.json
    secrets/.gitkeep
  README.md             setup guide (Task 21)
```

Tasks 1–13 are server and shared code; after Task 6 the server runs with zero sources, and each of Tasks 7–11 adds one working source. Tasks 14–20 are the web UI, each adding one visible piece. Task 21 is setup documentation and the manual smoke run.

---

### Task 1: Project scaffold and shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `shared/types.ts`, `shared/types.test.ts`, `config/secrets/.gitkeep`
- Modify: `.gitignore` (already has `node_modules/`, `dist/`, `web/dist/`, `data/`, `config/secrets/`, `*.sqlite`, `.env`; add `!config/secrets/.gitkeep`)

**Interfaces:**
- Produces: every type in `shared/types.ts` below. Later tasks import from `../shared/types` (server) or `../../shared/types` (web).

- [ ] **Step 1: Create package.json**

```json
{
  "name": "personal-dashboard",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -k -n server,web -c blue,magenta \"bun --watch server/index.ts\" \"vite --config web/vite.config.ts\"",
    "dev:server": "bun --watch server/index.ts",
    "dev:web": "vite --config web/vite.config.ts",
    "build": "vite build --config web/vite.config.ts",
    "start": "bun server/index.ts",
    "check": "bun server/check.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run from the repo root:

```bash
bun add hono@^4 zod@^4 react@^19 react-dom@^19 @fontsource/ibm-plex-sans@^5 @fontsource/ibm-plex-mono@^5
bun add -d typescript@^5 @types/bun @types/react@^19 @types/react-dom@^19 vite@^8 @vitejs/plugin-react@^6 concurrently@^10 @testing-library/react@^16 @happy-dom/global-registrator@^20
```

Expected: `bun.lock` and `node_modules/` created; no errors.

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["server", "shared", "web/src", "web/test", "web/vite.config.ts"]
}
```

- [ ] **Step 4: Write shared/types.ts**

```ts
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
  startedBy: string | null;
  url: string;
  artifacts: BuildArtifact[];
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
export interface LarkRecord {
  recordId: string;
  url: string;
  /** logical field name (title, status, ...) -> display string */
  fields: Record<string, string>;
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
```

- [ ] **Step 5: Write the smoke test**

`shared/types.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { SOURCE_IDS } from './types';

test('five sources are registered', () => {
  expect(SOURCE_IDS).toEqual(['github', 'codemagic', 'lark', 'appstore', 'playstore']);
});
```

- [ ] **Step 6: Run tests and typecheck**

Run: `bun test` → Expected: `1 pass`.
Run: `bun run typecheck` → Expected: no output, exit 0.

- [ ] **Step 7: Create config/secrets/.gitkeep and update .gitignore**

Create an empty `config/secrets/.gitkeep`. Append to `.gitignore`:

```
!config/secrets/.gitkeep
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold bun project and shared types

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Configuration loading and validation

**Files:**
- Create: `server/config.ts`, `server/config.test.ts`, `config/dashboard.config.example.json`

**Interfaces:**
- Produces: `loadConfig(rootDir): LoadedConfig`, `validateSources(config, secrets, configDir, exists?)`, `parseEnvFile(text)`, `publicConfig(config): PublicConfig`, types `DashboardConfig`, `LarkConfig`, `LarkTableKey`, `StoreAccountConfig`, `Secrets`, `LoadedConfig { config, secrets, problems, configDir }`.

- [ ] **Step 1: Write the example config**

`config/dashboard.config.example.json` (spec §7 verbatim; the real `dashboard.config.json` is a copy of this with real ids):

```json
{
  "server": { "port": 6600 },
  "polling": { "github": 60, "codemagic": 120, "lark": 120, "stores": 600 },
  "github": { "account": "jennsg" },
  "codemagic": { "enabled": true },
  "lark": {
    "domain": "example.larksuite.com",
    "baseToken": "bascXXXX",
    "tables": {
      "tasks": {
        "tableId": "tblXXXX", "viewId": "vewXXXX",
        "pendingLaunchStatus": "PENDING TO LAUNCH", "collapsedStatuses": ["PRODUCTION"],
        "fields": { "title": "Task Name", "status": "Status", "pic": "PIC", "type": "Task Type", "priority": "Priority", "progress": "Progress" }
      },
      "issues": {
        "tableId": "tblXXXX", "viewId": "vewXXXX",
        "showStatuses": ["OPEN", "CHECKING"],
        "fields": { "ticketId": "Ticket ID", "reportedDate": "Reported Date", "hoursSince": "Hours Since", "priority": "Priority", "store": "ERP Store Name / Email", "description": "Issue Description", "status": "Status" }
      },
      "feedback": {
        "tableId": "tblXXXX", "viewId": "vewXXXX", "limit": 30,
        "fields": { "reportedDate": "Reported Date", "category": "Category", "store": "ERP Store Name / Email", "text": "Feedback / Suggestion" }
      }
    }
  },
  "stores": {
    "accounts": [
      {
        "name": "Account A",
        "appstore": { "issuerId": "00000000-0000-0000-0000-000000000000", "keyId": "ABC123DEFG", "keyFile": "secrets/AuthKey_ABC123DEFG.p8" },
        "play": {
          "serviceAccountFile": "secrets/play-account-a.json", "developerId": "1234567890",
          "apps": [ { "packageName": "com.example.app", "name": "SGPOS", "consoleUrl": "https://play.google.com/console/u/0/developers/1234567890/app/4970000000000000000/tracks/production" } ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing tests**

`server/config.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { ConfigSchema, parseEnvFile, publicConfig, validateSources } from './config';
import example from '../config/dashboard.config.example.json';

describe('ConfigSchema', () => {
  test('parses the example config and applies defaults', () => {
    const parsed = ConfigSchema.parse(example);
    expect(parsed.server.port).toBe(6600);
    expect(parsed.lark.tables.feedback.limit).toBe(30);
    expect(parsed.stores.accounts[0]?.name).toBe('Account A');
  });

  test('fills polling defaults when polling is partially given', () => {
    const parsed = ConfigSchema.parse({ ...example, polling: { github: 30 } });
    expect(parsed.polling.github).toBe(30);
    expect(parsed.polling.stores).toBe(600);
  });

  test('rejects a config without github.account', () => {
    const { github, ...rest } = example;
    expect(ConfigSchema.safeParse(rest).success).toBe(false);
  });
});

describe('parseEnvFile', () => {
  test('reads KEY=VALUE lines, ignores comments and quotes', () => {
    const env = parseEnvFile('# comment\nCODEMAGIC_API_TOKEN="abc123"\nEMPTY=\n\nOTHER=x=y\n');
    expect(env).toEqual({ CODEMAGIC_API_TOKEN: 'abc123', EMPTY: '', OTHER: 'x=y' });
  });
});

describe('validateSources', () => {
  const config = ConfigSchema.parse(example);

  test('reports a missing Codemagic token', () => {
    const problems = validateSources(config, {}, 'C:/repo/config', () => true);
    expect(problems.codemagic).toContain('CODEMAGIC_API_TOKEN');
    expect(problems.appstore).toBeUndefined();
    expect(problems.playstore).toBeUndefined();
  });

  test('reports missing key files per account', () => {
    const problems = validateSources(config, { CODEMAGIC_API_TOKEN: 't' }, 'C:/repo/config', (p) => !p.endsWith('.p8'));
    expect(problems.appstore).toBe('key file missing for: Account A');
    expect(problems.playstore).toBeUndefined();
  });

  test('disables store sources when no accounts are configured', () => {
    const problems = validateSources({ ...config, stores: { accounts: [] } }, { CODEMAGIC_API_TOKEN: 't' }, 'C:/repo/config', () => true);
    expect(problems.appstore).toBe('no App Store Connect accounts configured');
    expect(problems.playstore).toBe('no Google Play accounts configured');
  });
});

describe('publicConfig', () => {
  test('exposes only non-secret values', () => {
    const pub = publicConfig(ConfigSchema.parse(example));
    expect(pub.intervals.appstore).toBe(600);
    expect(pub.accounts).toEqual(['Account A']);
    expect(JSON.stringify(pub)).not.toContain('secrets/');
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `bun test server/config.test.ts`
Expected: FAIL, "Cannot find module './config'".

- [ ] **Step 4: Write server/config.ts**

```ts
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PublicConfig, SourceId } from '../shared/types';

const id = z.string().min(1);

const TaskFields = z.object({ title: id, status: id, pic: id, type: id, priority: id, progress: id });
const IssueFields = z.object({ ticketId: id, reportedDate: id, hoursSince: id, priority: id, store: id, description: id, status: id });
const FeedbackFields = z.object({ reportedDate: id, category: id, store: id, text: id });

const TasksTable = z.object({
  tableId: id,
  viewId: id,
  pendingLaunchStatus: z.string().default('PENDING TO LAUNCH'),
  collapsedStatuses: z.array(z.string()).default(['PRODUCTION']),
  fields: TaskFields,
});
const IssuesTable = z.object({
  tableId: id,
  viewId: id,
  showStatuses: z.array(z.string()).default(['OPEN', 'CHECKING']),
  fields: IssueFields,
});
const FeedbackTable = z.object({
  tableId: id,
  viewId: id,
  limit: z.number().int().positive().default(30),
  fields: FeedbackFields,
});

const AppStoreAccount = z.object({ issuerId: id, keyId: id, keyFile: id });
const PlayAppSchema = z.object({ packageName: id, name: id, consoleUrl: z.string().optional() });
const PlayAccount = z.object({ serviceAccountFile: id, developerId: id, apps: z.array(PlayAppSchema) });
const StoreAccount = z.object({ name: id, appstore: AppStoreAccount.optional(), play: PlayAccount.optional() });

export const ConfigSchema = z.object({
  server: z.object({ port: z.number().int().min(1).max(65535).default(6600) }).default({ port: 6600 }),
  polling: z
    .object({
      github: z.number().int().positive().default(60),
      codemagic: z.number().int().positive().default(120),
      lark: z.number().int().positive().default(120),
      stores: z.number().int().positive().default(600),
    })
    .default({ github: 60, codemagic: 120, lark: 120, stores: 600 }),
  github: z.object({ account: id }),
  codemagic: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  lark: z.object({
    domain: id,
    baseToken: id,
    tables: z.object({ tasks: TasksTable, issues: IssuesTable, feedback: FeedbackTable }),
  }),
  stores: z.object({ accounts: z.array(StoreAccount).default([]) }).default({ accounts: [] }),
});

export type DashboardConfig = z.infer<typeof ConfigSchema>;
export type LarkConfig = DashboardConfig['lark'];
export type LarkTableKey = keyof LarkConfig['tables'];
export type StoreAccountConfig = z.infer<typeof StoreAccount>;
export type PlayAppConfig = z.infer<typeof PlayAppSchema>;

export interface Secrets {
  CODEMAGIC_API_TOKEN?: string;
}
export interface LoadedConfig {
  config: DashboardConfig;
  secrets: Secrets;
  /** source id -> reason it is disabled */
  problems: Partial<Record<SourceId, string>>;
  /** absolute path of the config/ directory; key files resolve against it */
  configDir: string;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function validateSources(
  config: DashboardConfig,
  secrets: Secrets,
  configDir: string,
  exists: (path: string) => boolean = existsSync,
): Partial<Record<SourceId, string>> {
  const problems: Partial<Record<SourceId, string>> = {};

  if (!config.codemagic.enabled) problems.codemagic = 'disabled in config';
  else if (!secrets.CODEMAGIC_API_TOKEN) problems.codemagic = 'CODEMAGIC_API_TOKEN missing from config/secrets/.env';

  const asc = config.stores.accounts.filter((a) => a.appstore);
  if (asc.length === 0) problems.appstore = 'no App Store Connect accounts configured';
  else {
    const missing = asc.filter((a) => !exists(resolve(configDir, a.appstore!.keyFile)));
    if (missing.length) problems.appstore = `key file missing for: ${missing.map((a) => a.name).join(', ')}`;
  }

  const play = config.stores.accounts.filter((a) => a.play);
  if (play.length === 0) problems.playstore = 'no Google Play accounts configured';
  else {
    const missing = play.filter((a) => !exists(resolve(configDir, a.play!.serviceAccountFile)));
    if (missing.length) problems.playstore = `service account file missing for: ${missing.map((a) => a.name).join(', ')}`;
  }
  return problems;
}

export function loadConfig(rootDir: string): LoadedConfig {
  const configDir = resolve(rootDir, 'config');
  const configPath = resolve(configDir, 'dashboard.config.json');
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${configPath}. Copy config/dashboard.config.example.json to config/dashboard.config.json and fill it in.`);
  }
  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid dashboard.config.json:\n${lines.join('\n')}`);
  }
  const envPath = resolve(configDir, 'secrets', '.env');
  const secrets: Secrets = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  return { config: parsed.data, secrets, problems: validateSources(parsed.data, secrets, configDir), configDir };
}

export function publicConfig(config: DashboardConfig): PublicConfig {
  return {
    intervals: {
      github: config.polling.github,
      codemagic: config.polling.codemagic,
      lark: config.polling.lark,
      appstore: config.polling.stores,
      playstore: config.polling.stores,
    },
    larkDomain: config.lark.domain,
    accounts: config.stores.accounts.map((a) => a.name),
    pendingLaunchStatus: config.lark.tables.tasks.pendingLaunchStatus,
    collapsedStatuses: config.lark.tables.tasks.collapsedStatuses,
    showIssueStatuses: config.lark.tables.issues.showStatuses,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test server/config.test.ts`
Expected: 8 pass.

- [ ] **Step 6: Commit**

```bash
git add server/config.ts server/config.test.ts config/dashboard.config.example.json
git commit -m "feat(server): config schema, secrets loading and per-source validation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: SQLite store

**Files:**
- Create: `server/store.ts`, `server/store.test.ts`

**Interfaces:**
- Consumes: `NewEvent`, `Event`, `SourceId`, `SourceState`, `SourceStates`, `SOURCE_IDS` from `shared/types.ts`.
- Produces: `class Store` with `getSnapshot<S>(source): SnapshotRow<S> | null`, `saveSnapshot(source, data, fetchedAt)`, `saveError(source, error, errorAt)`, `addEvents(events: NewEvent[], now): Event[]`, `unseenEvents(): Event[]`, `markSeen({ ids?, source? }): number`, `pruneEvents(maxAgeMs, now): number`, `allStates(disabled): SourceStates`, `close()`. `SnapshotRow<S> = { data: S | null; fetchedAt: number | null; error: string | null; errorAt: number | null }`.

- [ ] **Step 1: Write the failing tests**

`server/store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Store } from './store';
import type { NewEvent } from '../shared/types';

let store: Store;
beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => { store.close(); });

const ev = (itemId: string, priority: 'high' | 'normal' = 'high'): NewEvent => ({
  source: 'github', kind: 'pr.review_requested', priority, itemId, title: `PR ${itemId}`, url: `https://x/${itemId}`,
});

describe('snapshots', () => {
  test('returns null before anything is saved', () => {
    expect(store.getSnapshot('github')).toBeNull();
  });

  test('round-trips a snapshot and clears any previous error', () => {
    store.saveError('github', 'boom', 1000);
    store.saveSnapshot('github', { login: 'jennsg', incoming: [], mine: [] }, 2000);
    expect(store.getSnapshot('github')).toEqual({
      data: { login: 'jennsg', incoming: [], mine: [] }, fetchedAt: 2000, error: null, errorAt: null,
    });
  });

  test('records an error without touching the last good snapshot', () => {
    store.saveSnapshot('lark', { a: 1 }, 1000);
    store.saveError('lark', 'lark-cli exited 1', 3000);
    expect(store.getSnapshot('lark')).toEqual({ data: { a: 1 }, fetchedAt: 1000, error: 'lark-cli exited 1', errorAt: 3000 });
  });

  test('records an error before the first snapshot', () => {
    store.saveError('appstore', '401', 500);
    expect(store.getSnapshot('appstore')).toEqual({ data: null, fetchedAt: null, error: '401', errorAt: 500 });
  });
});

describe('events', () => {
  test('addEvents assigns ids and returns full events', () => {
    const out = store.addEvents([ev('a'), ev('b', 'normal')], 5000);
    expect(out.map((e) => e.id)).toEqual([1, 2]);
    expect(out[1]).toMatchObject({ itemId: 'b', priority: 'normal', createdAt: 5000, seen: false });
  });

  test('addEvents with an empty list is a no-op', () => {
    expect(store.addEvents([], 1)).toEqual([]);
    expect(store.unseenEvents()).toEqual([]);
  });

  test('unseenEvents lists oldest first and markSeen by ids removes them', () => {
    store.addEvents([ev('a')], 1000);
    store.addEvents([ev('b')], 2000);
    expect(store.unseenEvents().map((e) => e.itemId)).toEqual(['a', 'b']);
    expect(store.markSeen({ ids: [1] })).toBe(1);
    expect(store.unseenEvents().map((e) => e.itemId)).toEqual(['b']);
  });

  test('markSeen by source only touches that source', () => {
    store.addEvents([ev('a'), { ...ev('c'), source: 'lark', kind: 'issue.opened' }], 1000);
    expect(store.markSeen({ source: 'lark' })).toBe(1);
    expect(store.unseenEvents().map((e) => e.source)).toEqual(['github']);
  });

  test('markSeen with no filter marks everything', () => {
    store.addEvents([ev('a'), ev('b')], 1000);
    expect(store.markSeen({})).toBe(2);
    expect(store.unseenEvents()).toEqual([]);
  });

  test('pruneEvents deletes events older than maxAge', () => {
    store.addEvents([ev('old')], 1000);
    store.addEvents([ev('new')], 9000);
    expect(store.pruneEvents(5000, 10000)).toBe(1);
    expect(store.unseenEvents().map((e) => e.itemId)).toEqual(['new']);
  });
});

describe('allStates', () => {
  test('returns an entry for every source with disabled reasons applied', () => {
    store.saveSnapshot('github', { login: 'x', incoming: [], mine: [] }, 1000);
    const states = store.allStates({ codemagic: 'token missing' });
    expect(Object.keys(states).sort()).toEqual(['appstore', 'codemagic', 'github', 'lark', 'playstore']);
    expect(states.github.fetchedAt).toBe(1000);
    expect(states.codemagic).toEqual({ snapshot: null, fetchedAt: null, error: null, errorAt: null, disabled: 'token missing' });
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `bun test server/store.test.ts` → Expected: FAIL, "Cannot find module './store'".

- [ ] **Step 3: Write server/store.ts**

```ts
import { Database } from 'bun:sqlite';
import { SOURCE_IDS } from '../shared/types';
import type { Event, NewEvent, Priority, SourceId, SourceStates } from '../shared/types';

export interface SnapshotRow<S = unknown> {
  data: S | null;
  fetchedAt: number | null;
  error: string | null;
  errorAt: number | null;
}

interface SnapshotDbRow { data: string | null; fetched_at: number | null; error: string | null; error_at: number | null }
interface EventDbRow { id: number; source: string; kind: string; priority: string; item_id: string; title: string; url: string | null; created_at: number; seen: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  source     TEXT PRIMARY KEY,
  data       TEXT,
  fetched_at INTEGER,
  error      TEXT,
  error_at   INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  priority   TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  url        TEXT,
  created_at INTEGER NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_unseen ON events(seen, created_at);
`;

function rowToEvent(r: EventDbRow): Event {
  return {
    id: r.id,
    source: r.source as SourceId,
    kind: r.kind,
    priority: r.priority as Priority,
    itemId: r.item_id,
    title: r.title,
    url: r.url,
    createdAt: r.created_at,
    seen: r.seen === 1,
  };
}

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  getSnapshot<S = unknown>(source: SourceId): SnapshotRow<S> | null {
    const row = this.db
      .query<SnapshotDbRow, [string]>('SELECT data, fetched_at, error, error_at FROM snapshots WHERE source = ?')
      .get(source);
    if (!row) return null;
    return {
      data: row.data == null ? null : (JSON.parse(row.data) as S),
      fetchedAt: row.fetched_at,
      error: row.error,
      errorAt: row.error_at,
    };
  }

  saveSnapshot(source: SourceId, data: unknown, fetchedAt: number): void {
    this.db.run(
      `INSERT INTO snapshots (source, data, fetched_at, error, error_at) VALUES (?, ?, ?, NULL, NULL)
       ON CONFLICT(source) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at, error = NULL, error_at = NULL`,
      [source, JSON.stringify(data), fetchedAt],
    );
  }

  saveError(source: SourceId, error: string, errorAt: number): void {
    this.db.run(
      `INSERT INTO snapshots (source, data, fetched_at, error, error_at) VALUES (?, NULL, NULL, ?, ?)
       ON CONFLICT(source) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`,
      [source, error, errorAt],
    );
  }

  addEvents(events: NewEvent[], now: number): Event[] {
    if (events.length === 0) return [];
    const insert = this.db.query<{ id: number }, [string, string, string, string, string, string | null, number]>(
      'INSERT INTO events (source, kind, priority, item_id, title, url, created_at, seen) VALUES (?, ?, ?, ?, ?, ?, ?, 0) RETURNING id',
    );
    const out: Event[] = [];
    const tx = this.db.transaction(() => {
      for (const e of events) {
        const row = insert.get(e.source, e.kind, e.priority, e.itemId, e.title, e.url, now);
        if (!row) throw new Error('insert returned no id');
        out.push({ ...e, id: row.id, createdAt: now, seen: false });
      }
    });
    tx();
    return out;
  }

  unseenEvents(): Event[] {
    return this.db
      .query<EventDbRow, []>('SELECT * FROM events WHERE seen = 0 ORDER BY created_at ASC, id ASC')
      .all()
      .map(rowToEvent);
  }

  markSeen(opts: { ids?: number[]; source?: SourceId }): number {
    if (opts.ids && opts.ids.length > 0) {
      const placeholders = opts.ids.map(() => '?').join(',');
      return this.db.run(`UPDATE events SET seen = 1 WHERE seen = 0 AND id IN (${placeholders})`, opts.ids).changes;
    }
    if (opts.source) return this.db.run('UPDATE events SET seen = 1 WHERE seen = 0 AND source = ?', [opts.source]).changes;
    return this.db.run('UPDATE events SET seen = 1 WHERE seen = 0').changes;
  }

  pruneEvents(maxAgeMs: number, now: number): number {
    return this.db.run('DELETE FROM events WHERE created_at < ?', [now - maxAgeMs]).changes;
  }

  allStates(disabled: Partial<Record<SourceId, string>>): SourceStates {
    const states: Partial<Record<SourceId, unknown>> = {};
    for (const id of SOURCE_IDS) {
      const row = this.getSnapshot(id);
      states[id] = {
        snapshot: row?.data ?? null,
        fetchedAt: row?.fetchedAt ?? null,
        error: row?.error ?? null,
        errorAt: row?.errorAt ?? null,
        disabled: disabled[id] ?? null,
      };
    }
    return states as SourceStates;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test server/store.test.ts` → Expected: 11 pass.

- [ ] **Step 5: Commit**

```bash
git add server/store.ts server/store.test.ts
git commit -m "feat(server): sqlite store for snapshots and events

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Source contract and CLI process runner

**Files:**
- Create: `server/proc.ts`, `server/proc.test.ts`, `server/sources/types.ts`

**Interfaces:**
- Produces: `run(cmd, args, opts?): Promise<RunResult>` with `RunResult { stdout, stderr, code, timedOut }` and `RunOptions { timeoutMs?, stdin?, cwd? }`; `resolveCommand(cmd, platform?, which?)`. In `sources/types.ts`: `Runner`, `SourceContext<C> { config, run, fetch, log, now }`, `Source<S, C> { id, defaultIntervalSec, fetch(ctx), diff(prev, next), fastIntervalSec?(snapshot) }`, `RegisteredSource { source, ctx, intervalSec, disabled }`, `class SourceError extends Error { hint?: string }`.

- [ ] **Step 1: Write the failing tests**

`server/proc.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { resolveCommand, run } from './proc';

describe('run', () => {
  test('captures stdout and the exit code', async () => {
    const r = await run('bun', ['-e', 'console.log("hi"); process.exit(3)']);
    expect(r.stdout.trim()).toBe('hi');
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  test('pipes stdin to the child', async () => {
    const r = await run('bun', ['-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(s.toUpperCase()))'], { stdin: 'abc' });
    expect(r.stdout).toBe('ABC');
  });

  test('kills the child when the timeout elapses', async () => {
    const r = await run('bun', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });
});

describe('resolveCommand', () => {
  test('non-windows: returns the bare command', () => {
    expect(resolveCommand('lark-cli', 'linux', () => '/usr/bin/lark-cli')).toEqual(['lark-cli']);
  });

  test('windows: an .exe is called directly', () => {
    expect(resolveCommand('gh', 'win32', () => 'C:\\Program Files\\GitHub CLI\\gh.exe')).toEqual(['C:\\Program Files\\GitHub CLI\\gh.exe']);
  });

  test('windows: a .cmd shim goes through cmd.exe', () => {
    const which = (c: string) => (c === 'lark-cli.cmd' ? 'C:\\npm\\lark-cli.cmd' : c === 'lark-cli' ? 'C:\\npm\\lark-cli' : null);
    expect(resolveCommand('lark-cli', 'win32', which)).toEqual(['cmd.exe', '/d', '/c', 'C:\\npm\\lark-cli.cmd']);
  });

  test('windows: unknown command falls through unchanged', () => {
    expect(resolveCommand('nope', 'win32', () => null)).toEqual(['nope']);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `bun test server/proc.test.ts` → Expected: FAIL, "Cannot find module './proc'".

- [ ] **Step 3: Write server/proc.ts**

```ts
export interface RunResult {
  stdout: string;
  stderr: string;
  /** exit code; -1 if the process died without one (killed) */
  code: number;
  timedOut: boolean;
}
export interface RunOptions {
  timeoutMs?: number;
  stdin?: string;
  cwd?: string;
}

/**
 * npm-installed CLIs on Windows (lark-cli) are `.cmd` shims that only cmd.exe can execute.
 * Native executables (gh.exe, bun.exe) are spawned directly. Elsewhere the name is used as-is.
 */
export function resolveCommand(
  cmd: string,
  platform: NodeJS.Platform = process.platform,
  which: (c: string) => string | null = (c) => Bun.which(c),
): string[] {
  if (platform !== 'win32') return [cmd];
  const direct = which(cmd);
  if (direct && /\.exe$/i.test(direct)) return [direct];
  const shim = direct && /\.(cmd|bat)$/i.test(direct) ? direct : which(`${cmd}.cmd`);
  if (shim) return ['cmd.exe', '/d', '/c', shim];
  return [direct ?? cmd];
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const argv = [...resolveCommand(cmd), ...args];
  // stdin is always piped so `proc.stdin` is a FileSink for TypeScript; an empty pipe is closed at once.
  const proc = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd: opts.cwd, env: process.env });
  if (opts.stdin !== undefined) proc.stdin.write(opts.stdin);
  proc.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? 60_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code: typeof code === 'number' ? code : -1, timedOut };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Write server/sources/types.ts**

```ts
import type { NewEvent, SourceId } from '../../shared/types';
import type { RunOptions, RunResult } from '../proc';

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Everything a source may touch. Sources never import the store or the SSE hub. */
export interface SourceContext<C> {
  config: C;
  run: Runner;
  fetch: typeof fetch;
  log: (message: string) => void;
  now: () => number;
}

export interface Source<S, C> {
  id: SourceId;
  defaultIntervalSec: number;
  /** Talk to the outside world and return a normalised snapshot. Throw SourceError on failure. */
  fetch(ctx: SourceContext<C>): Promise<S>;
  /** What changed and matters. Must return [] when prev is null. */
  diff(prev: S | null, next: S): NewEvent[];
  /** Optional shorter interval while something is in flight (Codemagic builds). */
  fastIntervalSec?(snapshot: S): number | null;
}

export interface RegisteredSource {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry; each source is typed at its definition
  source: Source<any, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: SourceContext<any>;
  intervalSec: number;
  disabled: string | null;
}

/** A failure with an optional human hint, e.g. "run `gh auth login`". */
export class SourceError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'SourceError';
  }
}

export function describeError(err: unknown): string {
  if (err instanceof SourceError) return err.hint ? `${err.message} (${err.hint})` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test server/proc.test.ts` → Expected: 7 pass. Then `bun run typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/proc.ts server/proc.test.ts server/sources/types.ts
git commit -m "feat(server): source contract and CLI runner with timeout and .cmd shim support

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Scheduler

**Files:**
- Create: `server/scheduler.ts`, `server/scheduler.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 3), `RegisteredSource`, `describeError` (Task 4), `SseMessage`, `NewEvent`, `SourceId`.
- Produces: `class Scheduler(sources, store, onUpdate, opts?)` with `start()`, `stop()`, `tick(id)`, `refresh(id)`, `status(): Record<SourceId, SourceStatus>`; pure helpers `backoffDelaySec(intervalSec, failures, maxSec)` and `chooseDelaySec(source, snapshot, intervalSec)`. `SourceStatus { nextRunAt: number | null; inflight: boolean; consecutiveFailures: number; disabled: string | null }`.

- [ ] **Step 1: Write the failing tests**

`server/scheduler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Scheduler, backoffDelaySec, chooseDelaySec } from './scheduler';
import { Store } from './store';
import { SourceError } from './sources/types';
import type { RegisteredSource, Source, SourceContext } from './sources/types';
import type { NewEvent, SseMessage } from '../shared/types';

interface Snap { items: string[] }

function makeSource(fetchImpl: () => Promise<Snap>): Source<Snap, {}> {
  return {
    id: 'github',
    defaultIntervalSec: 60,
    fetch: fetchImpl,
    diff(prev, next): NewEvent[] {
      if (!prev) return [];
      return next.items.filter((i) => !prev.items.includes(i)).map((i) => ({
        source: 'github', kind: 'pr.review_requested', priority: 'high', itemId: i, title: i, url: null,
      }));
    },
  };
}

const ctx: SourceContext<{}> = { config: {}, run: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }), fetch, log: () => {}, now: Date.now };

let store: Store;
let updates: SseMessage[];
beforeEach(() => { store = new Store(':memory:'); updates = []; });
afterEach(() => store.close());

function scheduler(reg: RegisteredSource, now = () => 1_000_000) {
  return new Scheduler([reg], store, (m) => updates.push(m), { now });
}

describe('tick', () => {
  test('first tick saves the snapshot and emits no events', async () => {
    const src = makeSource(async () => ({ items: ['a'] }));
    const s = scheduler({ source: src, ctx, intervalSec: 60, disabled: null });
    await s.tick('github');
    expect(store.getSnapshot<Snap>('github')?.data).toEqual({ items: ['a'] });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.events).toEqual([]);
    expect(updates[0]?.state).toMatchObject({ snapshot: { items: ['a'] }, fetchedAt: 1_000_000, error: null });
  });

  test('second tick diffs against the stored snapshot and stores the events', async () => {
    let call = 0;
    const src = makeSource(async () => ({ items: call++ === 0 ? ['a'] : ['a', 'b'] }));
    const s = scheduler({ source: src, ctx, intervalSec: 60, disabled: null });
    await s.tick('github');
    await s.tick('github');
    expect(updates[1]?.events.map((e) => e.itemId)).toEqual(['b']);
    expect(store.unseenEvents().map((e) => e.itemId)).toEqual(['b']);
  });

  test('a failing fetch records the error, keeps the old snapshot and backs off', async () => {
    let call = 0;
    const src = makeSource(async () => {
      if (call++ === 0) return { items: ['a'] };
      throw new SourceError('gh exited 1', 'run `gh auth login`');
    });
    const s = scheduler({ source: src, ctx, intervalSec: 60, disabled: null });
    await s.tick('github');
    await s.tick('github');
    expect(store.getSnapshot<Snap>('github')).toMatchObject({ data: { items: ['a'] }, error: 'gh exited 1 (run `gh auth login`)' });
    expect(updates[1]?.state).toMatchObject({ snapshot: { items: ['a'] }, error: 'gh exited 1 (run `gh auth login`)' });
    expect(s.status().github.consecutiveFailures).toBe(1);
    await s.tick('github');
    expect(s.status().github.consecutiveFailures).toBe(2);
  });

  test('a disabled source never runs', async () => {
    const fetchImpl = mock(async () => ({ items: [] }));
    const s = scheduler({ source: makeSource(fetchImpl), ctx, intervalSec: 60, disabled: 'no token' });
    await s.tick('github');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.status().github.disabled).toBe('no token');
  });

  test('overlapping ticks do not double-fetch', async () => {
    let release: (v: Snap) => void = () => {};
    const fetchImpl = mock(() => new Promise<Snap>((r) => { release = r; }));
    const s = scheduler({ source: makeSource(fetchImpl), ctx, intervalSec: 60, disabled: null });
    const first = s.tick('github');
    await s.tick('github');
    release({ items: [] });
    await first;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('refresh resets the failure count before ticking', async () => {
    let fail = true;
    const src = makeSource(async () => { if (fail) throw new Error('x'); return { items: [] }; });
    const s = scheduler({ source: src, ctx, intervalSec: 60, disabled: null });
    await s.tick('github');
    expect(s.status().github.consecutiveFailures).toBe(1);
    fail = false;
    await s.refresh('github');
    expect(s.status().github.consecutiveFailures).toBe(0);
  });
});

describe('delays', () => {
  test('backoff doubles per failure and caps', () => {
    expect(backoffDelaySec(60, 1, 600)).toBe(120);
    expect(backoffDelaySec(60, 3, 600)).toBe(480);
    expect(backoffDelaySec(60, 4, 600)).toBe(600);
    expect(backoffDelaySec(600, 1, 600)).toBe(600);
  });

  test('chooseDelaySec prefers the fast interval when the source offers one', () => {
    const src: Source<Snap, {}> = { ...makeSource(async () => ({ items: [] })), fastIntervalSec: (s) => (s.items.length ? 30 : null) };
    expect(chooseDelaySec(src, { items: ['x'] }, 120)).toBe(30);
    expect(chooseDelaySec(src, { items: [] }, 120)).toBe(120);
    expect(chooseDelaySec(makeSource(async () => ({ items: [] })), { items: ['x'] }, 120)).toBe(120);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `bun test server/scheduler.test.ts` → Expected: FAIL, "Cannot find module './scheduler'".

- [ ] **Step 3: Write server/scheduler.ts**

```ts
import type { NewEvent, SourceId, SseMessage } from '../shared/types';
import type { Store } from './store';
import { describeError } from './sources/types';
import type { RegisteredSource, Source } from './sources/types';

export interface SchedulerOptions {
  now?: () => number;
  maxBackoffSec?: number;
  log?: (line: string) => void;
}
export interface SourceStatus {
  nextRunAt: number | null;
  inflight: boolean;
  consecutiveFailures: number;
  disabled: string | null;
}

export function backoffDelaySec(intervalSec: number, consecutiveFailures: number, maxSec: number): number {
  return Math.min(intervalSec * 2 ** consecutiveFailures, maxSec);
}

export function chooseDelaySec<S>(source: Source<S, unknown>, snapshot: S, intervalSec: number): number {
  const fast = source.fastIntervalSec?.(snapshot) ?? null;
  return fast ?? intervalSec;
}

export class Scheduler {
  private timers = new Map<SourceId, ReturnType<typeof setTimeout>>();
  private failures = new Map<SourceId, number>();
  private inflight = new Set<SourceId>();
  private nextRunAt = new Map<SourceId, number>();
  private started = false;
  private readonly now: () => number;
  private readonly maxBackoffSec: number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly sources: RegisteredSource[],
    private readonly store: Store,
    private readonly onUpdate: (msg: SseMessage) => void,
    opts: SchedulerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.maxBackoffSec = opts.maxBackoffSec ?? 600;
    this.log = opts.log ?? (() => {});
  }

  /** Begin polling. Until this is called, tick() runs once and schedules nothing (handy for tests and `bun run check`). */
  start(): void {
    this.started = true;
    for (const reg of this.sources) if (!reg.disabled) this.schedule(reg.source.id, 0);
  }

  stop(): void {
    this.started = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.nextRunAt.clear();
  }

  status(): Record<SourceId, SourceStatus> {
    const out = {} as Record<SourceId, SourceStatus>;
    for (const reg of this.sources) {
      const id = reg.source.id;
      out[id] = {
        nextRunAt: this.nextRunAt.get(id) ?? null,
        inflight: this.inflight.has(id),
        consecutiveFailures: this.failures.get(id) ?? 0,
        disabled: reg.disabled,
      };
    }
    return out;
  }

  /** Poll one source now, resetting its backoff. */
  async refresh(id: SourceId): Promise<void> {
    this.failures.set(id, 0);
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    await this.tick(id);
  }

  async tick(id: SourceId): Promise<void> {
    const reg = this.sources.find((r) => r.source.id === id);
    if (!reg || reg.disabled || this.inflight.has(id)) return;
    this.inflight.add(id);
    const startedAt = this.now();
    try {
      const prev = this.store.getSnapshot(id);
      const next: unknown = await reg.source.fetch(reg.ctx);
      const fetchedAt = this.now();
      this.store.saveSnapshot(id, next, fetchedAt);
      const fresh: NewEvent[] = prev?.data == null ? [] : reg.source.diff(prev.data, next);
      const events = this.store.addEvents(fresh, fetchedAt);
      this.failures.set(id, 0);
      const delaySec = chooseDelaySec(reg.source, next, reg.intervalSec);
      this.log(`${id}: ok in ${fetchedAt - startedAt} ms, ${events.length} event(s), next in ${delaySec} s`);
      this.onUpdate({ source: id, state: { snapshot: next, fetchedAt, error: null, errorAt: null, disabled: null }, events });
      this.schedule(id, delaySec * 1000);
    } catch (err) {
      const message = describeError(err);
      const errorAt = this.now();
      this.store.saveError(id, message, errorAt);
      const n = (this.failures.get(id) ?? 0) + 1;
      this.failures.set(id, n);
      const delaySec = backoffDelaySec(reg.intervalSec, n, this.maxBackoffSec);
      this.log(`${id}: FAILED ${message}; retry in ${delaySec} s`);
      const row = this.store.getSnapshot(id);
      this.onUpdate({
        source: id,
        state: { snapshot: row?.data ?? null, fetchedAt: row?.fetchedAt ?? null, error: message, errorAt, disabled: null },
        events: [],
      });
      this.schedule(id, delaySec * 1000);
    } finally {
      this.inflight.delete(id);
    }
  }

  private schedule(id: SourceId, delayMs: number): void {
    if (!this.started) return;
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    this.nextRunAt.set(id, this.now() + delayMs);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.tick(id);
    }, delayMs);
    this.timers.set(id, timer);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test server/scheduler.test.ts` → Expected: 8 pass.

- [ ] **Step 5: Commit**

```bash
git add server/scheduler.ts server/scheduler.test.ts
git commit -m "feat(server): per-source scheduler with backoff, fast interval and refresh

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: SSE hub, HTTP API and server entry point

**Files:**
- Create: `server/sse.ts`, `server/sse.test.ts`, `server/app.ts`, `server/app.test.ts`, `server/sources/index.ts`, `server/index.ts`

**Interfaces:**
- Consumes: `Store`, `Scheduler`, `describeError`, `publicConfig`, `loadConfig`, `LoadedConfig`.
- Produces: `class SseHub { add, remove, size, broadcast(msg) }`; `createApp(deps: AppDeps): Hono` where `AppDeps { store, scheduler, hub, publicConfig, disabled, codemagic? }` and `CodemagicActions { trigger({appId, workflowId, branch}): Promise<{ buildId: string }>; artifact(buildId, index): Promise<Response> }`; `buildSources(loaded, deps: BuildDeps): Promise<{ sources: RegisteredSource[]; codemagic?: CodemagicActions }>` with `BuildDeps { log; getSnapshot<S>(id): S | null }` (empty registry for now; Tasks 7–11 register sources here). Routes exactly as spec §3.6.

- [ ] **Step 1: Write the failing SSE hub test**

`server/sse.test.ts`:

```ts
import { expect, mock, test } from 'bun:test';
import { SseHub } from './sse';
import type { SSEStreamingApi } from 'hono/streaming';

function fakeStream(fail = false) {
  const writeSSE = mock(async () => { if (fail) throw new Error('closed'); });
  return { stream: { writeSSE } as unknown as SSEStreamingApi, writeSSE };
}

test('broadcast writes the same JSON to every client and drops failing ones', async () => {
  const hub = new SseHub();
  const a = fakeStream();
  const b = fakeStream(true);
  hub.add(a.stream);
  hub.add(b.stream);
  await hub.broadcast({ source: 'github', state: { snapshot: null, fetchedAt: 1, error: null, errorAt: null, disabled: null }, events: [] });
  expect(a.writeSSE).toHaveBeenCalledTimes(1);
  const arg = a.writeSSE.mock.calls[0]?.[0] as { event: string; data: string };
  expect(arg.event).toBe('update');
  expect(JSON.parse(arg.data).source).toBe('github');
  expect(hub.size).toBe(1);
});
```

- [ ] **Step 2: Write server/sse.ts**

```ts
import type { SSEStreamingApi } from 'hono/streaming';
import type { SseMessage } from '../shared/types';

export class SseHub {
  private clients = new Set<SSEStreamingApi>();

  add(stream: SSEStreamingApi): void { this.clients.add(stream); }
  remove(stream: SSEStreamingApi): void { this.clients.delete(stream); }
  get size(): number { return this.clients.size; }

  async broadcast(msg: SseMessage): Promise<void> {
    const data = JSON.stringify(msg);
    await Promise.all(
      [...this.clients].map(async (stream) => {
        try {
          await stream.writeSSE({ event: 'update', data });
        } catch {
          this.remove(stream);
        }
      }),
    );
  }
}
```

Run: `bun test server/sse.test.ts` → Expected: 1 pass.

- [ ] **Step 3: Write the failing app tests**

`server/app.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApp } from './app';
import { Scheduler } from './scheduler';
import { SseHub } from './sse';
import { Store } from './store';
import type { PublicConfig } from '../shared/types';

const publicConfig: PublicConfig = {
  intervals: { github: 60, codemagic: 120, lark: 120, appstore: 600, playstore: 600 },
  larkDomain: 'example.larksuite.com', accounts: [], pendingLaunchStatus: 'PENDING TO LAUNCH', collapsedStatuses: ['PRODUCTION'], showIssueStatuses: ['OPEN', 'CHECKING'],
};

let store: Store;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  store = new Store(':memory:');
  const scheduler = new Scheduler([], store, () => {});
  app = createApp({ store, scheduler, hub: new SseHub(), publicConfig, disabled: { codemagic: 'token missing' }, pingIntervalMs: 50 });
});
afterEach(() => store.close());

describe('GET /api/state', () => {
  test('returns states for all sources, unseen events and public config', async () => {
    store.addEvents([{ source: 'github', kind: 'pr.review_requested', priority: 'high', itemId: '1', title: 't', url: null }], 1);
    const res = await app.request('/api/state');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.states).sort()).toEqual(['appstore', 'codemagic', 'github', 'lark', 'playstore']);
    expect(body.states.codemagic.disabled).toBe('token missing');
    expect(body.events).toHaveLength(1);
    expect(body.config.larkDomain).toBe('example.larksuite.com');
  });
});

describe('POST /api/events/seen', () => {
  test('marks by ids', async () => {
    const [e] = store.addEvents([{ source: 'github', kind: 'k', priority: 'high', itemId: '1', title: 't', url: null }], 1);
    const res = await app.request('/api/events/seen', { method: 'POST', body: JSON.stringify({ ids: [e!.id] }), headers: { 'content-type': 'application/json' } });
    expect(await res.json()).toEqual({ updated: 1 });
    expect(store.unseenEvents()).toEqual([]);
  });

  test('rejects an empty body', async () => {
    const res = await app.request('/api/events/seen', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sources/:id/refresh', () => {
  test('404 for an unknown source, 409 for a disabled one', async () => {
    expect((await app.request('/api/sources/nope/refresh', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/sources/codemagic/refresh', { method: 'POST' })).status).toBe(409);
  });
});

describe('codemagic routes without a configured client', () => {
  test('trigger returns 409 with the disabled reason', async () => {
    const res = await app.request('/api/codemagic/builds', { method: 'POST', body: JSON.stringify({ appId: 'a', workflowId: 'w', branch: 'main' }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('token missing');
  });
});

describe('GET /api/events', () => {
  test('is an SSE stream that greets the client', async () => {
    const res = await app.request('/api/events');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('event: hello');
    await reader.cancel();
  });
});

test('GET /api/health reports scheduler status', async () => {
  const res = await app.request('/api/health');
  expect((await res.json()).ok).toBe(true);
});
```

- [ ] **Step 4: Run the app tests to confirm they fail**

Run: `bun test server/app.test.ts` → Expected: FAIL, "Cannot find module './app'".

- [ ] **Step 5: Write server/app.ts**

```ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { SOURCE_IDS } from '../shared/types';
import type { PublicConfig, SourceId, StateResponse } from '../shared/types';
import type { Scheduler } from './scheduler';
import { describeError } from './sources/types';
import type { SseHub } from './sse';
import type { Store } from './store';

export interface CodemagicActions {
  trigger(input: { appId: string; workflowId: string; branch: string }): Promise<{ buildId: string }>;
  /** Streams the artifact body with the auth token added server-side. */
  artifact(buildId: string, index: number): Promise<Response>;
}

export interface AppDeps {
  store: Store;
  scheduler: Scheduler;
  hub: SseHub;
  publicConfig: PublicConfig;
  disabled: Partial<Record<SourceId, string>>;
  codemagic?: CodemagicActions;
  /** SSE keep-alive interval in ms; tests shorten it so no long timer outlives them. */
  pingIntervalMs?: number;
}

const isSourceId = (s: string): s is SourceId => (SOURCE_IDS as readonly string[]).includes(s);

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true, sources: deps.scheduler.status(), clients: deps.hub.size }));

  app.get('/api/state', (c) => {
    const body: StateResponse = {
      states: deps.store.allStates(deps.disabled),
      events: deps.store.unseenEvents(),
      config: deps.publicConfig,
    };
    return c.json(body);
  });

  app.post('/api/events/seen', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; source?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((n): n is number => Number.isInteger(n)) : undefined;
    const source = typeof body.source === 'string' && isSourceId(body.source) ? body.source : undefined;
    if ((!ids || ids.length === 0) && !source) return c.json({ error: 'ids[] or source required' }, 400);
    return c.json({ updated: deps.store.markSeen({ ids, source }) });
  });

  app.post('/api/sources/:id/refresh', async (c) => {
    const id = c.req.param('id');
    if (!isSourceId(id)) return c.json({ error: 'unknown source' }, 404);
    const reason = deps.disabled[id];
    if (reason) return c.json({ error: reason }, 409);
    await deps.scheduler.refresh(id);
    return c.json({ ok: true, state: deps.store.allStates(deps.disabled)[id] });
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      deps.hub.add(stream);
      stream.onAbort(() => deps.hub.remove(stream));
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ clients: deps.hub.size }) });
      while (!stream.aborted && !stream.closed) {
        await stream.sleep(deps.pingIntervalMs ?? 20_000);
        await stream.writeSSE({ event: 'ping', data: '' });
      }
      deps.hub.remove(stream);
    }),
  );

  app.post('/api/codemagic/builds', async (c) => {
    if (!deps.codemagic) return c.json({ error: deps.disabled.codemagic ?? 'Codemagic not configured' }, 409);
    const body = (await c.req.json().catch(() => null)) as { appId?: unknown; workflowId?: unknown; branch?: unknown } | null;
    if (!body || typeof body.appId !== 'string' || typeof body.workflowId !== 'string' || typeof body.branch !== 'string' || !body.branch.trim()) {
      return c.json({ error: 'appId, workflowId and branch are required' }, 400);
    }
    try {
      const result = await deps.codemagic.trigger({ appId: body.appId, workflowId: body.workflowId, branch: body.branch.trim() });
      void deps.scheduler.refresh('codemagic');
      return c.json(result);
    } catch (err) {
      return c.json({ error: describeError(err) }, 502);
    }
  });

  app.get('/api/codemagic/artifacts/:buildId/:index', async (c) => {
    if (!deps.codemagic) return c.json({ error: deps.disabled.codemagic ?? 'Codemagic not configured' }, 409);
    const index = Number(c.req.param('index'));
    if (!Number.isInteger(index) || index < 0) return c.json({ error: 'bad artifact index' }, 400);
    try {
      return await deps.codemagic.artifact(c.req.param('buildId'), index);
    } catch (err) {
      return c.json({ error: describeError(err) }, 502);
    }
  });

  return app;
}
```

- [ ] **Step 6: Run the app tests**

Run: `bun test server/app.test.ts` → Expected: 7 pass.

- [ ] **Step 7: Write server/sources/index.ts (empty registry, filled by Tasks 7–11)**

```ts
import type { SourceId } from '../../shared/types';
import type { CodemagicActions } from '../app';
import type { LoadedConfig } from '../config';
import type { RegisteredSource } from './types';

export interface BuiltSources {
  sources: RegisteredSource[];
  codemagic?: CodemagicActions;
}

export interface BuildDeps {
  log: (line: string) => void;
  /** Latest stored snapshot for a source, or null before its first fetch. Used by actions that need current data (artifact lookup). */
  getSnapshot: <S>(id: SourceId) => S | null;
}

/** Instantiate every source from the loaded config. Sources with a config problem are registered as disabled so the UI can show why. */
export async function buildSources(loaded: LoadedConfig, deps: BuildDeps): Promise<BuiltSources> {
  void loaded;
  void deps;
  return { sources: [] };
}
```

- [ ] **Step 8: Write server/index.ts**

```ts
import { serveStatic } from 'hono/bun';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app';
import { loadConfig, publicConfig } from './config';
import { Scheduler } from './scheduler';
import { buildSources } from './sources/index';
import { SseHub } from './sse';
import { Store } from './store';
import type { SourceId } from '../shared/types';

const ROOT = resolve(import.meta.dir, '..');
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

const loaded = loadConfig(ROOT);
mkdirSync(resolve(ROOT, 'data'), { recursive: true });
const store = new Store(resolve(ROOT, 'data', 'dashboard.sqlite'));
const pruned = store.pruneEvents(30 * 24 * 3600 * 1000, Date.now());
if (pruned) log(`pruned ${pruned} events older than 30 days`);

const hub = new SseHub();
const { sources, codemagic } = await buildSources(loaded, {
  log,
  getSnapshot: <S>(id: SourceId): S | null => store.getSnapshot<S>(id)?.data ?? null,
});
const disabled: Partial<Record<SourceId, string>> = { ...loaded.problems };
for (const s of sources) if (s.disabled) disabled[s.source.id] = s.disabled;

const scheduler = new Scheduler(sources, store, (msg) => void hub.broadcast(msg), { log });
const app = createApp({ store, scheduler, hub, publicConfig: publicConfig(loaded.config), disabled, codemagic });

// Static UI: serveStatic paths are relative to the process cwd, so run from the repo root.
if (existsSync(resolve(ROOT, 'web', 'dist', 'index.html'))) {
  app.use('/*', serveStatic({ root: './web/dist' }));
  app.get('*', serveStatic({ path: './web/dist/index.html' }));
} else {
  app.get('/', (c) => c.text('UI not built yet. Run `bun run build`, or `bun run dev` and open the Vite URL it prints.'));
}

scheduler.start();
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: loaded.config.server.port,
  idleTimeout: 0, // SSE connections stay open; the route sends its own pings
  fetch: app.fetch,
});
log(`dashboard listening on http://127.0.0.1:${server.port}`);
for (const s of sources) log(`source ${s.source.id}: ${s.disabled ? `disabled (${s.disabled})` : `every ${s.intervalSec} s`}`);
for (const [id, reason] of Object.entries(loaded.problems)) if (!sources.some((s) => s.source.id === id)) log(`source ${id}: disabled (${reason})`);
```

- [ ] **Step 9: Create a working config and run the server**

Copy the example: `cp config/dashboard.config.example.json config/dashboard.config.json` (placeholders are fine for now; the real ids are filled in Task 21). Run:

```bash
bun run typecheck
bun run start
```

Expected: log line `dashboard listening on http://127.0.0.1:6600`. In another terminal: `curl http://127.0.0.1:6600/api/health` → `{"ok":true,...}`; `curl http://127.0.0.1:6600/api/state` → JSON with five `states` entries. Stop the server with Ctrl+C.

- [ ] **Step 10: Run all tests and commit**

Run: `bun test` → Expected: all pass.

```bash
git add server/sse.ts server/sse.test.ts server/app.ts server/app.test.ts server/sources/index.ts server/index.ts
git commit -m "feat(server): hono api, sse hub and entry point

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

`config/dashboard.config.json` is committed too (it holds no secrets): `git add config/dashboard.config.json && git commit -m "chore: initial dashboard config from example" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`.

---

### Task 7: GitHub source

**Files:**
- Create: `server/sources/github.ts`, `server/sources/github.test.ts`, `server/sources/__fixtures__/github.json`
- Modify: `server/sources/index.ts` (register the source)

**Interfaces:**
- Consumes: `Source`, `SourceContext`, `SourceError`, `Runner` (Task 4); `GithubSnapshot`, `PullRequest`, `NewEvent` (Task 1).
- Produces: `GITHUB_QUERY`, `parseGithub(raw): GithubSnapshot`, `diffGithub(prev, next): NewEvent[]`, `fetchGithub(ctx)`, `checkGithubAccount(run, expected): Promise<string | null>` (null = ok, string = disabled reason), `githubSource: Source<GithubSnapshot, GithubConfig>`, `GithubConfig { account: string }`.

- [ ] **Step 1: Write the fixture**

`server/sources/__fixtures__/github.json` — the shape `gh api graphql` returns for `GITHUB_QUERY`:

```json
{
  "data": {
    "viewer": { "login": "jennsg" },
    "incoming": {
      "nodes": [
        {
          "id": "PR_kwDOA1", "number": 482, "title": "[FEATURE] Receipt: show item-based discount line",
          "url": "https://github.com/sitegiant/sgpos-mobile/pull/482", "isDraft": false,
          "createdAt": "2026-09-17T01:10:00Z", "updatedAt": "2026-09-17T07:30:00Z",
          "author": { "login": "syamil", "avatarUrl": "https://avatars.githubusercontent.com/u/1?v=4" },
          "repository": { "nameWithOwner": "sitegiant/sgpos-mobile" },
          "reviewDecision": "REVIEW_REQUIRED",
          "commits": { "nodes": [ { "commit": { "statusCheckRollup": { "state": "SUCCESS" } } } ] }
        },
        {
          "id": "PR_kwDOA2", "number": 217, "title": "Affiliate register and link tracking",
          "url": "https://github.com/sitegiant/shopping-app/pull/217", "isDraft": false,
          "createdAt": "2026-09-16T02:00:00Z", "updatedAt": "2026-09-16T09:00:00Z",
          "author": null,
          "repository": { "nameWithOwner": "sitegiant/shopping-app" },
          "reviewDecision": null,
          "commits": { "nodes": [ { "commit": { "statusCheckRollup": null } } ] }
        }
      ]
    },
    "mine": {
      "nodes": [
        {
          "id": "PR_kwDOB1", "number": 470, "title": "Flutter upgrade to 3.47.2",
          "url": "https://github.com/sitegiant/sgpos-mobile/pull/470", "isDraft": false,
          "createdAt": "2026-09-10T01:00:00Z", "updatedAt": "2026-09-16T10:00:00Z",
          "author": { "login": "jennsg", "avatarUrl": "https://avatars.githubusercontent.com/u/2?v=4" },
          "repository": { "nameWithOwner": "sitegiant/sgpos-mobile" },
          "reviewDecision": "REVIEW_REQUIRED",
          "commits": { "nodes": [ { "commit": { "statusCheckRollup": { "state": "PENDING" } } } ] }
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

`server/sources/github.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import fixture from './__fixtures__/github.json';
import { checkGithubAccount, diffGithub, fetchGithub, parseGithub } from './github';
import type { GithubSnapshot, PullRequest } from '../../shared/types';
import type { Runner, SourceContext } from './types';

describe('parseGithub', () => {
  const snap = parseGithub(fixture);

  test('maps both lists and the viewer login', () => {
    expect(snap.login).toBe('jennsg');
    expect(snap.incoming.map((p) => p.number)).toEqual([482, 217]);
    expect(snap.mine.map((p) => p.number)).toEqual([470]);
  });

  test('maps repo, author, review decision and CI rollup', () => {
    const pr = snap.incoming[0]!;
    expect(pr).toMatchObject({ repo: 'sitegiant/sgpos-mobile', authorLogin: 'syamil', reviewDecision: 'REVIEW_REQUIRED', ci: 'SUCCESS', isDraft: false });
  });

  test('tolerates a deleted author and a missing rollup', () => {
    const pr = snap.incoming[1]!;
    expect(pr.authorLogin).toBe('ghost');
    expect(pr.ci).toBeNull();
    expect(pr.reviewDecision).toBeNull();
  });

  test('throws a SourceError on GraphQL errors', () => {
    expect(() => parseGithub({ errors: [{ message: 'Bad credentials' }] })).toThrow('Bad credentials');
  });
});

const pr = (id: string, over: Partial<PullRequest> = {}): PullRequest => ({
  id, number: 1, title: 'T', url: `https://github.com/o/r/pull/${id}`, isDraft: false, createdAt: '', updatedAt: '',
  authorLogin: 'a', authorAvatarUrl: '', repo: 'o/r', reviewDecision: 'REVIEW_REQUIRED', ci: 'SUCCESS', ...over,
});
const snap = (incoming: PullRequest[], mine: PullRequest[]): GithubSnapshot => ({ login: 'jennsg', incoming, mine });

describe('diffGithub', () => {
  test('first snapshot produces nothing', () => {
    expect(diffGithub(null, snap([pr('a')], []))).toEqual([]);
  });

  test('a new incoming PR is a high-priority review request', () => {
    const events = diffGithub(snap([pr('a')], []), snap([pr('a'), pr('b', { number: 9, title: 'New' })], []));
    expect(events).toEqual([{ source: 'github', kind: 'pr.review_requested', priority: 'high', itemId: 'b', title: 'Review requested: r #9: New', url: 'https://github.com/o/r/pull/b' }]);
  });

  test('review decision changes on my PRs are normal events', () => {
    const events = diffGithub(snap([], [pr('m')]), snap([], [pr('m', { reviewDecision: 'CHANGES_REQUESTED' })]));
    expect(events.map((e) => e.kind)).toEqual(['pr.review_decision']);
    expect(events[0]?.title).toStartWith('Changes requested:');
  });

  test('CI turning red on my PR is a normal event, staying red is not', () => {
    const red = pr('m', { ci: 'FAILURE' });
    expect(diffGithub(snap([], [pr('m')]), snap([], [red])).map((e) => e.kind)).toEqual(['pr.ci_failed']);
    expect(diffGithub(snap([], [red]), snap([], [red]))).toEqual([]);
  });

  test('unchanged snapshots produce nothing', () => {
    const s = snap([pr('a')], [pr('m')]);
    expect(diffGithub(s, s)).toEqual([]);
  });
});

describe('fetchGithub / checkGithubAccount', () => {
  const ctxWith = (run: Runner): SourceContext<{ account: string }> => ({ config: { account: 'jennsg' }, run, fetch, log: () => {}, now: Date.now });

  test('sends the query on stdin and parses stdout', async () => {
    let seen: { args: string[]; stdin?: string } | null = null;
    const run: Runner = async (_cmd, args, opts) => { seen = { args, stdin: opts?.stdin }; return { stdout: JSON.stringify(fixture), stderr: '', code: 0, timedOut: false }; };
    const snap = await fetchGithub(ctxWith(run));
    expect(snap.incoming).toHaveLength(2);
    expect(seen!.args).toEqual(['api', 'graphql', '--input', '-']);
    expect(JSON.parse(seen!.stdin!).query).toContain('review-requested:@me');
  });

  test('a non-zero exit with an auth message carries a hint', async () => {
    const run: Runner = async () => ({ stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login', code: 4, timedOut: false });
    await expect(fetchGithub(ctxWith(run))).rejects.toThrow('gh exited 4');
    await expect(fetchGithub(ctxWith(run))).rejects.toMatchObject({ hint: 'run `gh auth login`' });
  });

  test('a different active account is rejected', async () => {
    const other = { ...fixture, data: { ...fixture.data, viewer: { login: 'mobileapp-sitegiant' } } };
    const run: Runner = async () => ({ stdout: JSON.stringify(other), stderr: '', code: 0, timedOut: false });
    await expect(fetchGithub(ctxWith(run))).rejects.toThrow('logged in as mobileapp-sitegiant');
  });

  test('checkGithubAccount returns null when the login matches, a reason otherwise', async () => {
    expect(await checkGithubAccount(async () => ({ stdout: 'jennsg\n', stderr: '', code: 0, timedOut: false }), 'jennsg')).toBeNull();
    expect(await checkGithubAccount(async () => ({ stdout: 'other\n', stderr: '', code: 0, timedOut: false }), 'jennsg')).toContain('gh auth switch');
    expect(await checkGithubAccount(async () => ({ stdout: '', stderr: 'error connecting', code: 1, timedOut: false }), 'jennsg')).toContain('gh not ready');
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `bun test server/sources/github.test.ts` → Expected: FAIL, "Cannot find module './github'".

- [ ] **Step 4: Write server/sources/github.ts**

```ts
import type { CiState, GithubSnapshot, NewEvent, PullRequest, ReviewDecision } from '../../shared/types';
import { SourceError } from './types';
import type { Runner, Source, SourceContext } from './types';

export interface GithubConfig {
  account: string;
}

export const GITHUB_QUERY = `
query {
  viewer { login }
  incoming: search(query: "is:pr is:open review-requested:@me", type: ISSUE, first: 50) { nodes { ...PR } }
  mine: search(query: "is:pr is:open author:@me", type: ISSUE, first: 50) { nodes { ...PR } }
}
fragment PR on PullRequest {
  id number title url isDraft createdAt updatedAt
  author { login avatarUrl }
  repository { nameWithOwner }
  reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`;

interface RawPR {
  id: string; number: number; title: string; url: string; isDraft: boolean; createdAt: string; updatedAt: string;
  author: { login: string; avatarUrl: string } | null;
  repository: { nameWithOwner: string };
  reviewDecision: string | null;
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
}
interface RawResponse {
  data?: { viewer: { login: string }; incoming: { nodes: Array<RawPR | null> }; mine: { nodes: Array<RawPR | null> } };
  errors?: Array<{ message: string }>;
}

const REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
const CI_STATES = new Set(['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED']);

function toPR(raw: RawPR): PullRequest {
  const rollup = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    isDraft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    authorLogin: raw.author?.login ?? 'ghost',
    authorAvatarUrl: raw.author?.avatarUrl ?? '',
    repo: raw.repository.nameWithOwner,
    reviewDecision: raw.reviewDecision && REVIEW_DECISIONS.has(raw.reviewDecision) ? (raw.reviewDecision as ReviewDecision) : null,
    ci: rollup && CI_STATES.has(rollup) ? (rollup as CiState) : null,
  };
}

export function parseGithub(raw: unknown): GithubSnapshot {
  const r = raw as RawResponse;
  if (r.errors?.length) throw new SourceError(`GitHub GraphQL: ${r.errors.map((e) => e.message).join('; ')}`);
  if (!r.data) throw new SourceError('GitHub GraphQL: response has no data');
  const nodes = (list: Array<RawPR | null>) => list.filter((n): n is RawPR => n != null && typeof n.number === 'number').map(toPR);
  return { login: r.data.viewer.login, incoming: nodes(r.data.incoming.nodes), mine: nodes(r.data.mine.nodes) };
}

const prLabel = (pr: PullRequest) => `${pr.repo.split('/')[1] ?? pr.repo} #${pr.number}: ${pr.title}`;
const isRed = (ci: CiState) => ci === 'FAILURE' || ci === 'ERROR';

export function diffGithub(prev: GithubSnapshot | null, next: GithubSnapshot): NewEvent[] {
  if (!prev) return [];
  const events: NewEvent[] = [];
  const prevIncoming = new Set(prev.incoming.map((p) => p.id));
  for (const pr of next.incoming) {
    if (prevIncoming.has(pr.id)) continue;
    events.push({ source: 'github', kind: 'pr.review_requested', priority: 'high', itemId: pr.id, title: `Review requested: ${prLabel(pr)}`, url: pr.url });
  }
  const prevMine = new Map(prev.mine.map((p) => [p.id, p]));
  for (const pr of next.mine) {
    const before = prevMine.get(pr.id);
    if (!before) continue;
    if (pr.reviewDecision !== before.reviewDecision && (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === 'CHANGES_REQUESTED')) {
      const word = pr.reviewDecision === 'APPROVED' ? 'Approved' : 'Changes requested';
      events.push({ source: 'github', kind: 'pr.review_decision', priority: 'normal', itemId: pr.id, title: `${word}: ${prLabel(pr)}`, url: pr.url });
    }
    if (isRed(pr.ci) && !isRed(before.ci)) {
      events.push({ source: 'github', kind: 'pr.ci_failed', priority: 'normal', itemId: pr.id, title: `CI failing: ${prLabel(pr)}`, url: pr.url });
    }
  }
  return events;
}

export function ghHint(text: string): string | undefined {
  return /auth login|not logged|authentication|token|HTTP 401|HTTP 403/i.test(text) ? 'run `gh auth login`' : undefined;
}
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? '';

export async function fetchGithub(ctx: SourceContext<GithubConfig>): Promise<GithubSnapshot> {
  const res = await ctx.run('gh', ['api', 'graphql', '--input', '-'], { stdin: JSON.stringify({ query: GITHUB_QUERY }) });
  if (res.timedOut) throw new SourceError('gh api graphql timed out after 60 s');
  if (res.code !== 0) throw new SourceError(`gh exited ${res.code}: ${firstLine(res.stderr)}`, ghHint(res.stderr));
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new SourceError(`gh returned non-JSON output: ${firstLine(res.stdout)}`);
  }
  const snap = parseGithub(json);
  if (snap.login !== ctx.config.account) {
    throw new SourceError(`gh is logged in as ${snap.login}, expected ${ctx.config.account}`, `run \`gh auth switch --user ${ctx.config.account}\``);
  }
  return snap;
}

/** Startup check: null when the active gh account matches, otherwise the reason to disable the source. */
export async function checkGithubAccount(run: Runner, expected: string): Promise<string | null> {
  const res = await run('gh', ['api', 'user', '-q', '.login'], { timeoutMs: 20_000 });
  if (res.code !== 0) {
    const hint = ghHint(res.stderr);
    return `gh not ready: ${firstLine(res.stderr) || 'unknown error'}${hint ? ` (${hint})` : ''}`;
  }
  const login = res.stdout.trim();
  if (login !== expected) return `gh active account is ${login}, expected ${expected} (run \`gh auth switch --user ${expected}\`)`;
  return null;
}

export const githubSource: Source<GithubSnapshot, GithubConfig> = {
  id: 'github',
  defaultIntervalSec: 60,
  fetch: fetchGithub,
  diff: diffGithub,
};
```

- [ ] **Step 5: Run the tests**

Run: `bun test server/sources/github.test.ts` → Expected: 13 pass.

- [ ] **Step 6: Register the source**

Replace the body of `buildSources` in `server/sources/index.ts`:

```ts
import { run } from '../proc';
import { checkGithubAccount, githubSource } from './github';
// (keep existing imports)

export async function buildSources(loaded: LoadedConfig, deps: BuildDeps): Promise<BuiltSources> {
  const { log } = deps;
  const base = { run, fetch, log, now: Date.now };
  const sources: RegisteredSource[] = [];

  const githubDisabled = await checkGithubAccount(run, loaded.config.github.account);
  sources.push({ source: githubSource, ctx: { ...base, config: loaded.config.github }, intervalSec: loaded.config.polling.github, disabled: githubDisabled });

  return { sources };
}
```

(`BuildDeps` is `{ log: (line: string) => void; getSnapshot: <S>(id: SourceId) => S | null }`, defined in Task 6; `index.ts` passes `getSnapshot: (id) => store.getSnapshot(id)?.data ?? null`.)

- [ ] **Step 7: Verify live**

Run `bun run start`, wait for the log line `github: ok in … ms`, then `curl http://127.0.0.1:6600/api/state | head -c 600` → `states.github.snapshot.login` is `jennsg`. If the log says `disabled (gh active account is …)`, run `gh auth switch --user jennsg` and restart. Stop the server.

- [ ] **Step 8: Commit**

```bash
bun test
git add server/sources/github.ts server/sources/github.test.ts server/sources/__fixtures__/github.json server/sources/index.ts
git commit -m "feat(github): pull request source via gh graphql

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Codemagic source, build trigger and artifact proxy

**Files:**
- Create: `shared/status.ts`, `server/sources/codemagic.ts`, `server/sources/codemagic.test.ts`, `server/sources/__fixtures__/codemagic-apps.json`, `server/sources/__fixtures__/codemagic-builds.json`
- Modify: `server/sources/index.ts`

`shared/status.ts` starts here and grows in Tasks 10 and 11; it holds status vocabularies the web UI needs too (spec §4.2), so it lives in `shared/`, not `server/`. Create it first:

```ts
// shared/status.ts — status vocabularies shared by server sources and the web UI.

export const BUILD_TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'failed', 'canceled', 'timeout', 'skipped', 'warning']);
export const isBuildRunning = (status: string): boolean => !BUILD_TERMINAL_STATUSES.has(status);
export const isBuildFailed = (status: string): boolean => status === 'failed' || status === 'timeout';
```

**Interfaces:**
- Consumes: `CodemagicActions` (Task 6), `Source`, `SourceContext`, `SourceError`; `CodemagicSnapshot`, `CodemagicApp`, `Build` types.
- Produces: `CODEMAGIC_API`, `TERMINAL_STATUSES`, `isRunning(status)`, `parseApps(raw)`, `parseBuilds(raw, app)`, `diffCodemagic(prev, next)`, `codemagicJson(fetchImpl, token, path, init?)`, `fetchCodemagic(ctx)`, `codemagicSource`, `createCodemagicActions(token, getSnapshot, fetchImpl): CodemagicActions`, `CodemagicConfig { token: string }`.

The Codemagic REST API (`https://api.codemagic.io`, header `x-auth-token`) uses British `artefacts` in build objects and keys workflows by id in `GET /apps`. The fixtures below follow the documented shapes; Step 8 replaces them with scrubbed real responses.

- [ ] **Step 1: Write the fixtures**

`server/sources/__fixtures__/codemagic-apps.json`:

```json
{
  "applications": [
    {
      "_id": "app1", "appName": "SGPOS",
      "workflows": { "wf-ios": { "name": "ios-release" }, "wf-android": { "name": "android-release" } }
    },
    { "_id": "app2", "appName": "Shopping App", "workflows": { "wf-and2": { "name": "android-release" } } }
  ]
}
```

`server/sources/__fixtures__/codemagic-builds.json`:

```json
{
  "builds": [
    {
      "_id": "b-old", "appId": "app1", "workflowId": "wf-ios", "branch": "develop", "status": "finished",
      "startedAt": "2026-09-16T09:20:00Z", "finishedAt": "2026-09-16T09:41:00Z", "config": { "name": "ios-release" },
      "artefacts": [ { "name": "SGPOS.ipa", "type": "ipa", "url": "https://api.codemagic.io/artifacts/abc/SGPOS.ipa", "size": 88080384 } ]
    },
    {
      "_id": "b-run", "appId": "app1", "workflowId": "wf-android", "branch": "release/3.47.2", "status": "building",
      "startedAt": "2026-09-17T01:35:00Z", "finishedAt": null, "config": { "name": "android-release" }, "artefacts": []
    },
    {
      "_id": "b-fail", "appId": "app1", "workflowId": "wf-ios", "branch": "release/3.47.2", "status": "failed",
      "startedAt": "2026-09-17T01:10:00Z", "finishedAt": "2026-09-17T01:28:00Z", "config": { "name": "ios-release" }, "artefacts": []
    }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

`server/sources/codemagic.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import apps from './__fixtures__/codemagic-apps.json';
import builds from './__fixtures__/codemagic-builds.json';
import { codemagicJson, codemagicSource, createCodemagicActions, diffCodemagic, isRunning, parseApps, parseBuilds } from './codemagic';
import type { Build, CodemagicSnapshot } from '../../shared/types';

const fakeFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;

describe('parseApps', () => {
  test('maps apps and their workflows', () => {
    const out = parseApps(apps);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 'app1', name: 'SGPOS', workflows: [{ id: 'wf-ios', name: 'ios-release' }, { id: 'wf-android', name: 'android-release' }] });
  });
  test('rejects an unexpected shape', () => {
    expect(() => parseApps({ nope: [] })).toThrow('unexpected response shape');
  });
});

describe('parseBuilds', () => {
  const app = parseApps(apps)[0]!;
  const out = parseBuilds(builds, app);

  test('sorts newest first and maps fields', () => {
    expect(out.map((b) => b.id)).toEqual(['b-run', 'b-fail', 'b-old']);
    expect(out[2]).toMatchObject({ workflowName: 'ios-release', branch: 'develop', status: 'finished', durationSec: 1260, url: 'https://codemagic.io/app/app1/build/b-old' });
    expect(out[2]?.artifacts).toEqual([{ name: 'SGPOS.ipa', type: 'ipa', url: 'https://api.codemagic.io/artifacts/abc/SGPOS.ipa', size: 88080384 }]);
  });
  test('a running build has no duration', () => {
    expect(out[0]?.durationSec).toBeNull();
    expect(isRunning(out[0]!.status)).toBe(true);
    expect(isRunning('failed')).toBe(false);
  });
});

const build = (id: string, status: string, over: Partial<Build> = {}): Build => ({
  id, appId: 'app1', workflowId: 'wf', workflowName: 'ios-release', branch: 'main', status, startedAt: '2026-09-17T00:00:00Z', finishedAt: null,
  durationSec: null, startedBy: null, url: `https://codemagic.io/app/app1/build/${id}`, artifacts: [], ...over,
});
const snap = (...b: Build[]): CodemagicSnapshot => ({ apps: [{ id: 'app1', name: 'SGPOS', workflows: [], builds: b }] });

describe('diffCodemagic', () => {
  test('first snapshot produces nothing', () => {
    expect(diffCodemagic(null, snap(build('a', 'failed')))).toEqual([]);
  });
  test('running -> failed is a high event; running -> finished is normal', () => {
    expect(diffCodemagic(snap(build('a', 'building')), snap(build('a', 'failed')))).toEqual([
      { source: 'codemagic', kind: 'build.failed', priority: 'high', itemId: 'a', title: 'Build failed: SGPOS · ios-release · main', url: 'https://codemagic.io/app/app1/build/a' },
    ]);
    expect(diffCodemagic(snap(build('a', 'building')), snap(build('a', 'finished'))).map((e) => [e.kind, e.priority])).toEqual([['build.finished', 'normal']]);
  });
  test('a build that appears already finished still counts once; canceled and unchanged do not', () => {
    expect(diffCodemagic(snap(), snap(build('n', 'finished'))).map((e) => e.kind)).toEqual(['build.finished']);
    expect(diffCodemagic(snap(build('a', 'building')), snap(build('a', 'canceled')))).toEqual([]);
    expect(diffCodemagic(snap(build('a', 'failed')), snap(build('a', 'failed')))).toEqual([]);
  });
  test('fastIntervalSec is 30 while anything runs', () => {
    expect(codemagicSource.fastIntervalSec!(snap(build('a', 'queued')))).toBe(30);
    expect(codemagicSource.fastIntervalSec!(snap(build('a', 'finished')))).toBeNull();
  });
});

describe('codemagicJson', () => {
  test('adds the token header and parses JSON', async () => {
    let headers: Headers | undefined;
    const f = fakeFetch((_u, init) => { headers = new Headers(init?.headers); return Response.json({ ok: 1 }); });
    expect(await codemagicJson(f, 'tok', '/apps')).toEqual({ ok: 1 });
    expect(headers?.get('x-auth-token')).toBe('tok');
  });
  test('401 carries a token hint', async () => {
    const f = fakeFetch(() => new Response('nope', { status: 401 }));
    await expect(codemagicJson(f, 'tok', '/apps')).rejects.toMatchObject({ hint: expect.stringContaining('CODEMAGIC_API_TOKEN') });
  });
});

describe('createCodemagicActions', () => {
  test('trigger posts appId, workflowId and branch', async () => {
    let body: unknown;
    const f = fakeFetch((url, init) => { if (url.endsWith('/builds') && init?.method === 'POST') { body = JSON.parse(String(init.body)); return Response.json({ buildId: 'new1' }); } return new Response('', { status: 404 }); });
    const actions = createCodemagicActions('tok', () => null, f);
    expect(await actions.trigger({ appId: 'app1', workflowId: 'wf-ios', branch: 'main' })).toEqual({ buildId: 'new1' });
    expect(body).toEqual({ appId: 'app1', workflowId: 'wf-ios', branch: 'main' });
  });

  test('artifact proxies the download with the token and a filename', async () => {
    const snapshot: CodemagicSnapshot = { apps: [{ id: 'app1', name: 'SGPOS', workflows: [], builds: [build('b1', 'finished', { artifacts: [{ name: 'SGPOS.ipa', type: 'ipa', url: 'https://api.codemagic.io/artifacts/x/SGPOS.ipa', size: 3 }] })] }] };
    let tokenSeen: string | null = null;
    const f = fakeFetch((_u, init) => { tokenSeen = new Headers(init?.headers).get('x-auth-token'); return new Response('abc', { headers: { 'content-type': 'application/octet-stream' } }); });
    const res = await createCodemagicActions('tok', () => snapshot, f).artifact('b1', 0);
    expect(tokenSeen).toBe('tok');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="SGPOS.ipa"');
    expect(await res.text()).toBe('abc');
  });

  test('artifact rejects unknown build or index', async () => {
    const actions = createCodemagicActions('tok', () => null, fakeFetch(() => new Response('')));
    await expect(actions.artifact('nope', 0)).rejects.toThrow('not in the current snapshot');
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `bun test server/sources/codemagic.test.ts` → Expected: FAIL, "Cannot find module './codemagic'".

- [ ] **Step 4: Write server/sources/codemagic.ts**

```ts
import { BUILD_TERMINAL_STATUSES, isBuildRunning } from '../../shared/status';
import type { Build, CodemagicApp, CodemagicSnapshot, NewEvent } from '../../shared/types';
import type { CodemagicActions } from '../app';
import { SourceError } from './types';
import type { Source, SourceContext } from './types';

export interface CodemagicConfig {
  token: string;
}

export const CODEMAGIC_API = 'https://api.codemagic.io';
export const CODEMAGIC_WEB = 'https://codemagic.io';
export const TERMINAL_STATUSES = BUILD_TERMINAL_STATUSES;
export const isRunning = isBuildRunning;

interface RawApp { _id: string; appName: string; workflows?: Record<string, { name?: string } | null> }
interface RawArtifact { name?: string; type?: string; url?: string; size?: number }
interface RawBuild {
  _id: string; appId: string; workflowId: string; branch?: string; status: string;
  startedAt?: string | null; finishedAt?: string | null; config?: { name?: string } | null;
  artefacts?: RawArtifact[]; startedBy?: { name?: string; email?: string } | string | null;
}

export type AppMeta = Omit<CodemagicApp, 'builds'>;

export function parseApps(raw: unknown): AppMeta[] {
  const list = (raw as { applications?: unknown }).applications;
  if (!Array.isArray(list)) throw new SourceError('Codemagic /apps: unexpected response shape');
  return (list as RawApp[]).map((a) => ({
    id: a._id,
    name: a.appName,
    workflows: Object.entries(a.workflows ?? {}).map(([id, w]) => ({ id, name: w?.name ?? id })),
  }));
}

export const buildUrl = (appId: string, buildId: string): string => `${CODEMAGIC_WEB}/app/${appId}/build/${buildId}`;

function durationSec(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}
function startedBy(v: RawBuild['startedBy']): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.name ?? v.email ?? null;
}

export function parseBuilds(raw: unknown, app: AppMeta): Build[] {
  const list = (raw as { builds?: unknown }).builds;
  if (!Array.isArray(list)) throw new SourceError(`Codemagic /builds for ${app.name}: unexpected response shape`);
  const names = new Map(app.workflows.map((w) => [w.id, w.name]));
  return (list as RawBuild[])
    .map<Build>((b) => ({
      id: b._id,
      appId: b.appId,
      workflowId: b.workflowId,
      workflowName: b.config?.name ?? names.get(b.workflowId) ?? b.workflowId,
      branch: b.branch ?? '',
      status: b.status,
      startedAt: b.startedAt ?? null,
      finishedAt: b.finishedAt ?? null,
      durationSec: durationSec(b.startedAt, b.finishedAt),
      startedBy: startedBy(b.startedBy),
      url: buildUrl(b.appId, b._id),
      artifacts: (b.artefacts ?? [])
        .filter((a) => typeof a.url === 'string')
        .map((a) => ({ name: a.name ?? 'artifact', type: a.type ?? '', url: a.url!, size: typeof a.size === 'number' ? a.size : null })),
    }))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .slice(0, 10);
}

export async function codemagicJson(fetchImpl: typeof fetch, token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetchImpl(`${CODEMAGIC_API}${path}`, {
    ...init,
    headers: { 'x-auth-token': token, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
  if (res.status === 401 || res.status === 403) throw new SourceError(`Codemagic ${path}: HTTP ${res.status}`, 'Codemagic token rejected; check CODEMAGIC_API_TOKEN in config/secrets/.env');
  if (!res.ok) throw new SourceError(`Codemagic ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function fetchCodemagic(ctx: SourceContext<CodemagicConfig>): Promise<CodemagicSnapshot> {
  const apps = parseApps(await codemagicJson(ctx.fetch, ctx.config.token, '/apps'));
  const out: CodemagicApp[] = [];
  for (let i = 0; i < apps.length; i += 4) {
    const chunk = apps.slice(i, i + 4);
    const done = await Promise.all(
      chunk.map(async (app) => ({
        ...app,
        builds: parseBuilds(await codemagicJson(ctx.fetch, ctx.config.token, `/builds?appId=${encodeURIComponent(app.id)}&limit=10`), app),
      })),
    );
    out.push(...done);
  }
  return { apps: out };
}

export function diffCodemagic(prev: CodemagicSnapshot | null, next: CodemagicSnapshot): NewEvent[] {
  if (!prev) return [];
  const before = new Map<string, Build>();
  for (const a of prev.apps) for (const b of a.builds) before.set(b.id, b);
  const events: NewEvent[] = [];
  for (const app of next.apps) {
    for (const b of app.builds) {
      const p = before.get(b.id);
      const wasRunning = !p || isRunning(p.status);
      if (!wasRunning || isRunning(b.status)) continue;
      const label = `${app.name} · ${b.workflowName} · ${b.branch}`;
      if (b.status === 'failed' || b.status === 'timeout') {
        events.push({ source: 'codemagic', kind: 'build.failed', priority: 'high', itemId: b.id, title: `Build failed: ${label}`, url: b.url });
      } else if (b.status === 'finished' || b.status === 'warning') {
        events.push({ source: 'codemagic', kind: 'build.finished', priority: 'normal', itemId: b.id, title: `Build finished: ${label}`, url: b.url });
      }
    }
  }
  return events;
}

export const codemagicSource: Source<CodemagicSnapshot, CodemagicConfig> = {
  id: 'codemagic',
  defaultIntervalSec: 120,
  fetch: fetchCodemagic,
  diff: diffCodemagic,
  fastIntervalSec: (s) => (s.apps.some((a) => a.builds.some((b) => isRunning(b.status))) ? 30 : null),
};

export function createCodemagicActions(token: string, getSnapshot: () => CodemagicSnapshot | null, fetchImpl: typeof fetch = fetch): CodemagicActions {
  return {
    async trigger(input) {
      const json = (await codemagicJson(fetchImpl, token, '/builds', { method: 'POST', body: JSON.stringify(input) })) as { buildId?: string };
      if (!json.buildId) throw new SourceError('Codemagic did not return a buildId');
      return { buildId: json.buildId };
    },
    async artifact(buildId, index) {
      const build = getSnapshot()?.apps.flatMap((a) => a.builds).find((b) => b.id === buildId);
      const artifact = build?.artifacts[index];
      if (!build || !artifact) throw new SourceError(`artifact ${index} of build ${buildId} is not in the current snapshot`);
      const upstream = await fetchImpl(artifact.url, { headers: { 'x-auth-token': token } });
      if (!upstream.ok || !upstream.body) throw new SourceError(`Codemagic artifact download: HTTP ${upstream.status}`);
      const headers = new Headers({
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${artifact.name.replace(/"/g, '')}"`,
      });
      const len = upstream.headers.get('content-length');
      if (len) headers.set('content-length', len);
      return new Response(upstream.body, { headers });
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test server/sources/codemagic.test.ts` → Expected: 13 pass.

- [ ] **Step 6: Register the source and actions**

In `server/sources/index.ts` add after the GitHub block:

```ts
import { codemagicSource, createCodemagicActions } from './codemagic';
import type { CodemagicSnapshot } from '../../shared/types';
// ...
  const token = loaded.secrets.CODEMAGIC_API_TOKEN ?? '';
  const codemagicDisabled = loaded.problems.codemagic ?? null;
  sources.push({ source: codemagicSource, ctx: { ...base, config: { token } }, intervalSec: loaded.config.polling.codemagic, disabled: codemagicDisabled });
  const codemagic = codemagicDisabled ? undefined : createCodemagicActions(token, () => deps.getSnapshot<CodemagicSnapshot>('codemagic'));

  return { sources, codemagic };
```

- [ ] **Step 7: Verify live (needs the token)**

Create `config/secrets/.env` with `CODEMAGIC_API_TOKEN=<token from Codemagic → Teams → Personal Account → Integrations → Codemagic API>`. Run `bun run start`; expect `codemagic: ok in … ms`. `curl http://127.0.0.1:6600/api/state` shows `states.codemagic.snapshot.apps[]` with builds. If the token is not available yet, skip to Step 8 and record this check in Task 21's smoke list.

- [ ] **Step 8: Replace fixtures with scrubbed real responses**

With the token present:

```bash
curl -s -H "x-auth-token: $CODEMAGIC_API_TOKEN" https://api.codemagic.io/apps > /tmp/apps.json
curl -s -H "x-auth-token: $CODEMAGIC_API_TOKEN" "https://api.codemagic.io/builds?appId=<one app id>&limit=3" > /tmp/builds.json
```

Copy them over the two fixture files, then: delete every key that is not read by `parseApps` / `parseBuilds` (keep `_id`, `appName`, `workflows.*.name`, and for builds `_id`, `appId`, `workflowId`, `branch`, `status`, `startedAt`, `finishedAt`, `config.name`, `artefacts[].{name,type,url,size}`, `startedBy`); replace emails, names, signed URL query strings and any token-like string with dummies. Re-run `bun test server/sources/codemagic.test.ts`; if a field name differs from the assumed shape (e.g. `startedBy` is structured differently or `artefacts` is spelled otherwise), fix the `Raw*` interfaces and parsers, not the fixture. Update test expectations only where the real shape genuinely differs.

- [ ] **Step 9: Commit**

```bash
bun test
git add server/sources/codemagic.ts server/sources/codemagic.test.ts server/sources/__fixtures__/codemagic-*.json server/sources/index.ts
git commit -m "feat(codemagic): builds source, trigger and artifact proxy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Lark Base source

**Files:**
- Create: `server/sources/lark.ts`, `server/sources/lark.test.ts`, `server/sources/__fixtures__/lark-record-list.json`
- Modify: `server/sources/index.ts`, `server/config.ts` (placeholder detection), `server/config.test.ts`

**Interfaces:**
- Consumes: `LarkConfig`, `LarkTableKey` (Task 2); `Runner`, `Source`, `SourceContext`, `SourceError`; `LarkSnapshot`, `LarkGroup`, `LarkRecord`, `NewEvent`.
- Produces: `PAGE_SIZE`, `extractPage(json): { items: RawRecord[]; hasMore: boolean }`, `cellToString(value): string`, `formatDate(ms)`, `recordUrl(domain, baseToken, tableId, viewId, recordId)`, `mapRecord(raw, fields, url)`, `groupByStatus(records, order?)`, `buildLarkSnapshot(raw, cfg)`, `diffLark(prev, next)`, `listRecords(run, cfg, key)`, `fetchLark(ctx)`, `larkSource`, `RawRecord { record_id: string; fields: Record<string, unknown> }`.

`lark-cli base +record-list --help` (v1.0.49) gives: `--base-token`, `--table-id`, `--view-id` (id or name), `--field-id` (repeatable projection), `--limit` 1–200 (default 100), `--offset`, `--format json`, `--as user`. The JSON envelope wraps the Lark API payload (`items[]` of `{ record_id, fields }`, `has_more`); `extractPage` accepts the payload at the top level or under `data`. Step 8 pins the real shape.

- [ ] **Step 1: Write the fixture**

`server/sources/__fixtures__/lark-record-list.json` (Lark API payload shape; cell values show the variety `cellToString` must handle):

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "has_more": false,
    "total": 3,
    "items": [
      {
        "record_id": "recA1",
        "fields": {
          "Task Name": [ { "type": "text", "text": "[FEATURE] MOBILE/SGPOS (RECEIPT) - Show item based discount on Receipt" } ],
          "Status": "PENDING TO LAUNCH",
          "PIC": [ { "id": "ou_1", "name": "Jenn" }, { "id": "ou_2", "name": "Syamil Aiman" } ],
          "Task Type": "FEATURE",
          "Priority": "High",
          "Progress": 0.92
        }
      },
      {
        "record_id": "recA2",
        "fields": {
          "Task Name": [ { "type": "text", "text": "[CHORE] - Update new auth key" } ],
          "Status": "PENDING TO LAUNCH",
          "PIC": [ { "id": "ou_1", "name": "Jenn" } ],
          "Task Type": "CHORE",
          "Priority": "Normal",
          "Progress": 1
        }
      },
      {
        "record_id": "recA3",
        "fields": {
          "Task Name": [ { "type": "text", "text": "[QE] MOBILE/SGPOS (GENERAL) - BCRS" } ],
          "Status": "SENIOR QC",
          "PIC": [ { "id": "ou_1", "name": "Jenn" } ],
          "Task Type": "QE",
          "Priority": "High",
          "Progress": 0.6,
          "Reported Date": 1789516920000,
          "Hours Since": { "type": 1, "value": [ "24 hours | 1 days" ] },
          "ERP Store Name / Email": [ { "type": "url", "text": "store@example.com", "link": "mailto:store@example.com" } ]
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing tests**

`server/sources/lark.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import fixture from './__fixtures__/lark-record-list.json';
import { buildLarkSnapshot, cellToString, diffLark, extractPage, groupByStatus, listRecords, recordUrl } from './lark';
import type { LarkConfig } from '../config';
import type { LarkRecord, LarkSnapshot } from '../../shared/types';
import type { Runner } from './types';

const cfg: LarkConfig = {
  domain: 'example.larksuite.com',
  baseToken: 'bascT',
  tables: {
    tasks: { tableId: 'tblTasks', viewId: 'vewJ1', pendingLaunchStatus: 'PENDING TO LAUNCH', collapsedStatuses: ['PRODUCTION'],
      fields: { title: 'Task Name', status: 'Status', pic: 'PIC', type: 'Task Type', priority: 'Priority', progress: 'Progress' } },
    issues: { tableId: 'tblIssues', viewId: 'vewJ2', showStatuses: ['OPEN', 'CHECKING'],
      fields: { ticketId: 'Ticket ID', reportedDate: 'Reported Date', hoursSince: 'Hours Since', priority: 'Priority', store: 'ERP Store Name / Email', description: 'Issue Description', status: 'Status' } },
    feedback: { tableId: 'tblFb', viewId: 'vewJ3', limit: 2,
      fields: { reportedDate: 'Reported Date', category: 'Category', store: 'ERP Store Name / Email', text: 'Feedback / Suggestion' } },
  },
};

describe('cellToString', () => {
  test('flattens text segments, people, selects, numbers and formulas', () => {
    const f = fixture.data.items[2]!.fields;
    expect(cellToString(f['Task Name'])).toBe('[QE] MOBILE/SGPOS (GENERAL) - BCRS');
    expect(cellToString(fixture.data.items[0]!.fields.PIC)).toBe('Jenn, Syamil Aiman');
    expect(cellToString(f.Status)).toBe('SENIOR QC');
    expect(cellToString(f.Progress)).toBe('0.6');
    expect(cellToString(f['Hours Since'])).toBe('24 hours | 1 days');
    expect(cellToString(f['ERP Store Name / Email'])).toBe('store@example.com');
    expect(cellToString(f['Reported Date'])).toMatch(/^2026\/09\/1\d \d\d:\d\d$/);
    expect(cellToString(null)).toBe('');
    expect(cellToString(true)).toBe('Yes');
  });
});

describe('extractPage', () => {
  test('reads items and has_more from a wrapped payload', () => {
    const page = extractPage(fixture);
    expect(page.items.map((i) => i.record_id)).toEqual(['recA1', 'recA2', 'recA3']);
    expect(page.hasMore).toBe(false);
  });
  test('accepts an unwrapped payload and a bare array', () => {
    expect(extractPage({ items: fixture.data.items, has_more: true }).hasMore).toBe(true);
    expect(extractPage(fixture.data.items).items).toHaveLength(3);
  });
  test('rejects a payload without records', () => {
    expect(() => extractPage({ data: { foo: 1 } })).toThrow('no items array');
  });
});

describe('buildLarkSnapshot', () => {
  const rec = (id: string, fields: Record<string, unknown>) => ({ record_id: id, fields });
  const raw = {
    tasks: fixture.data.items,
    issues: [
      rec('i1', { 'Ticket ID': '#G001', Status: 'RESOLVED', Priority: 'Normal' }),
      rec('i2', { 'Ticket ID': '#G002', Status: 'OPEN', Priority: 'Normal', 'Hours Since': '69 hours | 2.9 days' }),
      rec('i3', { 'Ticket ID': '#G003', Status: 'CHECKING', Priority: 'Normal' }),
      rec('i4', { 'Ticket ID': '#G004', Status: 'CLOSED' }),
    ],
    feedback: [rec('f1', { Category: 'A' }), rec('f2', { Category: 'B' }), rec('f3', { Category: 'C' })],
  };
  const snap = buildLarkSnapshot(raw, cfg);

  test('groups tasks by status in order of first appearance', () => {
    expect(snap.tasks.groups.map((g) => [g.status, g.records.length])).toEqual([['PENDING TO LAUNCH', 2], ['SENIOR QC', 1]]);
    expect(snap.tasks.total).toBe(3);
    expect(snap.tasks.groups[0]?.records[0]?.fields).toMatchObject({ title: '[FEATURE] MOBILE/SGPOS (RECEIPT) - Show item based discount on Receipt', priority: 'High', pic: 'Jenn, Syamil Aiman' });
  });
  test('issues: only shown statuses become groups, counts cover every status', () => {
    expect(snap.issues.groups.map((g) => g.status)).toEqual(['OPEN', 'CHECKING']);
    expect(snap.issues.counts).toEqual({ RESOLVED: 1, OPEN: 1, CHECKING: 1, CLOSED: 1 });
  });
  test('feedback is truncated to the configured limit', () => {
    expect(snap.feedback.records.map((r) => r.recordId)).toEqual(['f1', 'f2']);
  });
  test('every record deep-links to itself in its table and view', () => {
    expect(snap.issues.groups[0]?.records[0]?.url).toBe('https://example.larksuite.com/base/bascT?table=tblIssues&view=vewJ2&record=i2');
    expect(recordUrl('d', 'b', 't', 'v', 'r')).toBe('https://d/base/b?table=t&view=v&record=r');
  });
});

describe('groupByStatus', () => {
  const r = (id: string, status: string): LarkRecord => ({ recordId: id, url: '', fields: { status } });
  test('honours an explicit order and drops empty groups', () => {
    expect(groupByStatus([r('a', 'CHECKING'), r('b', 'OPEN')], ['OPEN', 'CHECKING', 'X']).map((g) => g.status)).toEqual(['OPEN', 'CHECKING']);
  });
});

describe('diffLark', () => {
  const r = (id: string, status: string): LarkRecord => ({ recordId: id, url: `u/${id}`, fields: { status, ticketId: `#${id}`, description: 'd', text: 't', category: 'c' } });
  const s = (open: LarkRecord[], checking: LarkRecord[], feedback: LarkRecord[]): LarkSnapshot => ({
    tasks: { groups: [], total: 0 },
    issues: { groups: [{ status: 'OPEN', records: open }, { status: 'CHECKING', records: checking }], counts: {} },
    feedback: { records: feedback },
  });
  test('first snapshot produces nothing', () => {
    expect(diffLark(null, s([r('a', 'OPEN')], [], []))).toEqual([]);
  });
  test('a new record in the first issue group is a high event; new feedback is normal', () => {
    const events = diffLark(s([r('a', 'OPEN')], [], [r('f1', '')]), s([r('a', 'OPEN'), r('b', 'OPEN')], [], [r('f2', ''), r('f1', '')]));
    expect(events).toEqual([
      { source: 'lark', kind: 'issue.opened', priority: 'high', itemId: 'b', title: 'New issue #b: d', url: 'u/b' },
      { source: 'lark', kind: 'feedback.new', priority: 'normal', itemId: 'f2', title: 'New feedback (c): t', url: 'u/f2' },
    ]);
  });
  test('a record moving from CHECKING to OPEN is not "new"', () => {
    expect(diffLark(s([], [r('a', 'CHECKING')], []), s([r('a', 'OPEN')], [], []))).toEqual([]);
  });
});

describe('listRecords', () => {
  test('pages with --offset until a short page arrives', async () => {
    const calls: string[][] = [];
    const page = (n: number) => ({ data: { has_more: n < 200, items: Array.from({ length: n }, (_, i) => ({ record_id: `r${i}`, fields: {} })) } });
    const run: Runner = async (_c, args) => { calls.push(args); const offset = Number(args[args.indexOf('--offset') + 1]); return { stdout: JSON.stringify(offset === 0 ? page(200) : page(5)), stderr: '', code: 0, timedOut: false }; };
    const items = await listRecords(run, cfg, 'issues');
    expect(items).toHaveLength(205);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['base', '+record-list', '--base-token', 'bascT', '--table-id', 'tblIssues', '--view-id', 'vewJ2', '--as', 'user', '--format', 'json', '--limit', '200', '--offset', '0']);
  });
  test('a failing CLI with an auth message carries a login hint', async () => {
    const run: Runner = async () => ({ stdout: '', stderr: 'Error: user access token expired, please run lark-cli auth login', code: 1, timedOut: false });
    await expect(listRecords(run, cfg, 'tasks')).rejects.toMatchObject({ hint: 'run `lark-cli auth login`' });
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `bun test server/sources/lark.test.ts` → Expected: FAIL, "Cannot find module './lark'".

- [ ] **Step 4: Write server/sources/lark.ts**

```ts
import type { LarkGroup, LarkRecord, LarkSnapshot, NewEvent } from '../../shared/types';
import type { LarkConfig, LarkTableKey } from '../config';
import { SourceError } from './types';
import type { Runner, Source, SourceContext } from './types';

export const PAGE_SIZE = 200;
const MAX_PAGES = 25;

export interface RawRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

const isRawRecord = (x: unknown): x is RawRecord =>
  !!x && typeof x === 'object' && typeof (x as RawRecord).record_id === 'string' && typeof (x as RawRecord).fields === 'object';

/** lark-cli wraps the Lark API payload; accept the payload at top level, under `data`, or as a bare array. */
export function extractPage(json: unknown): { items: RawRecord[]; hasMore: boolean } {
  if (Array.isArray(json)) return { items: json.filter(isRawRecord), hasMore: false };
  if (!json || typeof json !== 'object') throw new SourceError('lark-cli returned no JSON object');
  const top = json as Record<string, unknown>;
  const data = (top.data && typeof top.data === 'object' ? top.data : top) as Record<string, unknown>;
  const list = [data.items, data.records, data.list].find(Array.isArray) as unknown[] | undefined;
  if (!list) throw new SourceError(`lark-cli response has no items array (keys: ${Object.keys(data).join(', ')})`);
  return { items: list.filter(isRawRecord), hasMore: data.has_more === true };
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Flatten any Lark cell value (text segments, people, selects, formulas, dates) to display text. */
export function cellToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return v > 1e11 && v < 1e13 ? formatDate(v) : String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) {
    const parts = v.map(cellToString).filter(Boolean);
    const segments = v.length > 0 && v.every((x) => x && typeof x === 'object' && 'type' in (x as object) && 'text' in (x as object));
    return parts.join(segments ? '' : ', ');
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text.trim();
    if (typeof o.name === 'string') return o.name.trim();
    if ('value' in o) return cellToString(o.value);
    if (typeof o.link === 'string') return o.link;
    if (typeof o.en_name === 'string') return o.en_name;
    return '';
  }
  return String(v);
}

export const recordUrl = (domain: string, baseToken: string, tableId: string, viewId: string, recordId: string): string =>
  `https://${domain}/base/${baseToken}?table=${tableId}&view=${viewId}&record=${recordId}`;

export function mapRecord(raw: RawRecord, fields: Record<string, string>, url: string): LarkRecord {
  const out: Record<string, string> = {};
  for (const [logical, larkName] of Object.entries(fields)) out[logical] = cellToString(raw.fields[larkName]);
  return { recordId: raw.record_id, url, fields: out };
}

/** Group by fields.status. With `order`, groups follow it and unlisted statuses are dropped; otherwise order of first appearance. */
export function groupByStatus(records: LarkRecord[], order?: string[]): LarkGroup[] {
  const groups = new Map<string, LarkRecord[]>();
  if (order) for (const s of order) groups.set(s, []);
  for (const r of records) {
    const status = r.fields.status ?? '';
    if (order && !groups.has(status)) continue;
    (groups.get(status) ?? groups.set(status, []).get(status)!).push(r);
  }
  return [...groups.entries()].filter(([, rs]) => rs.length > 0).map(([status, rs]) => ({ status, records: rs }));
}

export function buildLarkSnapshot(raw: Record<LarkTableKey, RawRecord[]>, cfg: LarkConfig): LarkSnapshot {
  const t = cfg.tables;
  const url = (key: LarkTableKey, id: string) => recordUrl(cfg.domain, cfg.baseToken, t[key].tableId, t[key].viewId, id);

  const tasks = raw.tasks.map((r) => mapRecord(r, t.tasks.fields, url('tasks', r.record_id)));
  const issues = raw.issues.map((r) => mapRecord(r, t.issues.fields, url('issues', r.record_id)));
  const counts: Record<string, number> = {};
  for (const r of issues) {
    const s = r.fields.status ?? '';
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const feedback = raw.feedback.slice(0, t.feedback.limit).map((r) => mapRecord(r, t.feedback.fields, url('feedback', r.record_id)));

  return {
    tasks: { groups: groupByStatus(tasks), total: tasks.length },
    issues: { groups: groupByStatus(issues, t.issues.showStatuses), counts },
    feedback: { records: feedback },
  };
}

export function diffLark(prev: LarkSnapshot | null, next: LarkSnapshot): NewEvent[] {
  if (!prev) return [];
  const events: NewEvent[] = [];
  const known = new Set(prev.issues.groups.flatMap((g) => g.records.map((r) => r.recordId)));
  for (const r of next.issues.groups[0]?.records ?? []) {
    if (known.has(r.recordId)) continue;
    const f = r.fields;
    events.push({ source: 'lark', kind: 'issue.opened', priority: 'high', itemId: r.recordId, title: `New issue ${f.ticketId ?? r.recordId}: ${(f.description ?? '').slice(0, 120)}`, url: r.url });
  }
  const knownFeedback = new Set(prev.feedback.records.map((r) => r.recordId));
  for (const r of next.feedback.records) {
    if (knownFeedback.has(r.recordId)) continue;
    const f = r.fields;
    events.push({ source: 'lark', kind: 'feedback.new', priority: 'normal', itemId: r.recordId, title: `New feedback (${f.category ?? ''}): ${(f.text ?? '').slice(0, 120)}`, url: r.url });
  }
  return events;
}

export const larkHint = (text: string): string | undefined =>
  /token|auth|login|permission|forbidden|99991|not logged/i.test(text) ? 'run `lark-cli auth login`' : undefined;
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? '';

export async function listRecords(run: Runner, cfg: LarkConfig, key: LarkTableKey): Promise<RawRecord[]> {
  const t = cfg.tables[key];
  const all: RawRecord[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = [
      'base', '+record-list',
      '--base-token', cfg.baseToken,
      '--table-id', t.tableId,
      '--view-id', t.viewId,
      '--as', 'user',
      '--format', 'json',
      '--limit', String(PAGE_SIZE),
      '--offset', String(page * PAGE_SIZE),
    ];
    const res = await run('lark-cli', args);
    if (res.timedOut) throw new SourceError(`lark-cli timed out reading ${key}`);
    if (res.code !== 0) throw new SourceError(`lark-cli exited ${res.code} reading ${key}: ${firstLine(res.stderr || res.stdout)}`, larkHint(res.stderr + res.stdout));
    let json: unknown;
    try {
      json = JSON.parse(res.stdout);
    } catch {
      throw new SourceError(`lark-cli returned non-JSON for ${key}: ${firstLine(res.stdout)}`);
    }
    const { items, hasMore } = extractPage(json);
    all.push(...items);
    if (items.length === 0 || (!hasMore && items.length < PAGE_SIZE)) break;
  }
  return all;
}

export async function fetchLark(ctx: SourceContext<LarkConfig>): Promise<LarkSnapshot> {
  const [tasks, issues, feedback] = await Promise.all([
    listRecords(ctx.run, ctx.config, 'tasks'),
    listRecords(ctx.run, ctx.config, 'issues'),
    listRecords(ctx.run, ctx.config, 'feedback'),
  ]);
  return buildLarkSnapshot({ tasks, issues, feedback }, ctx.config);
}

export const larkSource: Source<LarkSnapshot, LarkConfig> = {
  id: 'lark',
  defaultIntervalSec: 120,
  fetch: fetchLark,
  diff: diffLark,
};
```

- [ ] **Step 5: Run the tests**

Run: `bun test server/sources/lark.test.ts` → Expected: 14 pass.

- [ ] **Step 6: Detect placeholder Lark ids in config validation**

In `server/config.ts` `validateSources`, add before `return problems;`:

```ts
  const larkIds = [config.lark.baseToken, ...Object.values(config.lark.tables).flatMap((t) => [t.tableId, t.viewId])];
  if (larkIds.some((v) => /XXXX/.test(v))) problems.lark = 'lark config still has placeholder ids (see README: Lark setup)';
```

Add to `server/config.test.ts` inside `describe('validateSources')`:

```ts
  test('flags placeholder Lark ids', () => {
    const problems = validateSources(config, { CODEMAGIC_API_TOKEN: 't' }, 'C:/repo/config', () => true);
    expect(problems.lark).toContain('placeholder');
  });
```

Run `bun test server/config.test.ts` → all pass.

- [ ] **Step 7: Register the source**

In `server/sources/index.ts` add after the Codemagic block:

```ts
import { larkSource } from './lark';
// ...
  sources.push({ source: larkSource, ctx: { ...base, config: loaded.config.lark }, intervalSec: loaded.config.polling.lark, disabled: loaded.problems.lark ?? null });
```

- [ ] **Step 8: Pin the real lark-cli output shape (needs the Lark URLs)**

Take the three "Jenn" view URLs from Lark (each looks like `https://<domain>/base/<baseToken>?table=<tableId>&view=<viewId>`), fill `lark.domain`, `lark.baseToken`, and each table's `tableId` / `viewId` in `config/dashboard.config.json`. Confirm the field names with:

```bash
lark-cli base +field-list --base-token <baseToken> --table-id <tableId> --format json --as user
```

and correct `fields.*` in config where a name differs from the example (the status field is the one each view groups by). Then capture one real page:

```bash
lark-cli base +record-list --base-token <baseToken> --table-id <tasks tableId> --view-id <tasks viewId> --as user --format json --limit 2 > /tmp/lark.json
```

Compare its envelope with `extractPage`'s expectations. If items live somewhere `extractPage` does not look, add that path to the `[data.items, data.records, data.list]` candidates. Replace `__fixtures__/lark-record-list.json` with the captured output after scrubbing: replace people names and store emails with dummies, keep field names and value shapes. Re-run `bun test server/sources/lark.test.ts` and fix `cellToString` for any cell shape it flattens wrongly (the test for it must be extended with that real shape). If the URLs are not available yet, leave the fixture as-is and carry this step into Task 21.

- [ ] **Step 9: Verify live**

`bun run start`; expect `lark: ok in … ms`. `curl http://127.0.0.1:6600/api/state` → `states.lark.snapshot.tasks.groups[]` and `issues.counts`. If it says `disabled (lark config still has placeholder ids…)`, the config still needs Step 8.

- [ ] **Step 10: Commit**

```bash
bun test
git add server/sources/lark.ts server/sources/lark.test.ts server/sources/__fixtures__/lark-record-list.json server/sources/index.ts server/config.ts server/config.test.ts config/dashboard.config.json
git commit -m "feat(lark): tasks, issues and feedback source via lark-cli views

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: JWT signing and the App Store Connect source

**Files:**
- Create: `server/jwt.ts`, `server/jwt.test.ts`, `server/sources/appstore.ts`, `server/sources/appstore.test.ts`, `server/sources/__fixtures__/asc-apps.json`, `server/sources/__fixtures__/asc-versions.json`
- Modify: `shared/status.ts` (App Store state sets + `humanState`), `server/sources/index.ts`

**Interfaces:**
- Consumes: `StoreAccountConfig`, `LoadedConfig.configDir` (Task 2); `Source`, `SourceContext`, `SourceError`; `AppStoreSnapshot`, `AppStoreApp`, `AppStoreVersion`, `NewEvent`.
- Produces: in `jwt.ts`: `base64url(input)`, `pemToDer(pem): Uint8Array`, `importPrivateKey(pem, alg): Promise<CryptoKey>`, `signJwt({ alg, header?, payload, key }): Promise<string>`, `JwtAlg = 'ES256' | 'RS256'`. In `shared/status.ts`: `APPSTORE_LIVE_STATES`, `APPSTORE_DEAD_STATES`, `APPSTORE_ATTENTION_STATES`, `APPSTORE_REJECTED_STATES`, `APPSTORE_HIGH_STATES`, `humanState(state)`. In `appstore.ts`: `AppStoreAccount { name, issuerId, keyId, privateKeyPem }`, `AppStoreConfig { accounts }`, `ASC_API`, `class AscTokenCache { token(account, now?) }`, `parseAscApps(raw)`, `summarizeVersions(raw)`, `ascJson(fetchImpl, token, path, accountName)`, `fetchAppStore(ctx)`, `diffAppStore(prev, next)`, `appstoreSource`, `loadAppStoreAccounts(accounts, configDir, readFile?)`.

Apple's `.p8` key is a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`), signed with ES256. WebCrypto's ECDSA signature is already the raw `r||s` form JWS requires, so no DER conversion is needed.

- [ ] **Step 1: Write the failing JWT tests**

`server/jwt.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { base64url, importPrivateKey, pemToDer, signJwt } from './jwt';

async function toPem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}
function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe('base64url', () => {
  test('encodes without padding using the url alphabet', () => {
    expect(base64url('hi')).toBe('aGk');
    expect(base64url(new Uint8Array([251, 255]))).toBe('-_8');
  });
});

describe('pemToDer', () => {
  test('strips armour and whitespace', () => {
    expect([...pemToDer('-----BEGIN PRIVATE KEY-----\nAAEC\nAw==\n-----END PRIVATE KEY-----')]).toEqual([0, 1, 2, 3]);
  });
});

describe('signJwt', () => {
  test('ES256 token verifies with the public key and carries kid', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const key = await importPrivateKey(await toPem(pair.privateKey), 'ES256');
    const jwt = await signJwt({ alg: 'ES256', header: { kid: 'KEY1' }, payload: { iss: 'issuer', aud: 'appstoreconnect-v1' }, key });
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'KEY1' });
    expect(JSON.parse(new TextDecoder().decode(fromB64url(p))).aud).toBe('appstoreconnect-v1');
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });

  test('RS256 token verifies with the public key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const key = await importPrivateKey(await toPem(pair.privateKey), 'RS256');
    const jwt = await signJwt({ alg: 'RS256', payload: { scope: 'x' }, key });
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, pair.publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });
});
```

- [ ] **Step 2: Write server/jwt.ts**

```ts
export type JwtAlg = 'ES256' | 'RS256';

const ALGS = {
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' } as EcKeyImportParams, sign: { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams },
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as RsaHashedImportParams, sign: { name: 'RSASSA-PKCS1-v1_5' } as Algorithm },
} as const;

export function base64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function importPrivateKey(pem: string, alg: JwtAlg): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pemToDer(pem), ALGS[alg].import, false, ['sign']);
}

export async function signJwt(opts: { alg: JwtAlg; header?: Record<string, unknown>; payload: Record<string, unknown>; key: CryptoKey }): Promise<string> {
  const header = base64url(JSON.stringify({ alg: opts.alg, typ: 'JWT', ...opts.header }));
  const payload = base64url(JSON.stringify(opts.payload));
  const signature = await crypto.subtle.sign(ALGS[opts.alg].sign, opts.key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(signature)}`;
}
```

Run: `bun test server/jwt.test.ts` → Expected: 4 pass.

- [ ] **Step 3: Extend shared/status.ts**

Append:

```ts
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
```

- [ ] **Step 4: Write the fixtures**

`server/sources/__fixtures__/asc-apps.json`:

```json
{
  "data": [
    { "type": "apps", "id": "1111111111", "attributes": { "name": "SGPOS", "bundleId": "com.sitegiant.sgpos", "sku": "SGPOS" } },
    { "type": "apps", "id": "2222222222", "attributes": { "name": "Shopping App", "bundleId": "com.sitegiant.shopping", "sku": "SHOP" } }
  ],
  "links": { "self": "https://api.appstoreconnect.apple.com/v1/apps?limit=200" }
}
```

`server/sources/__fixtures__/asc-versions.json`:

```json
{
  "data": [
    { "type": "appStoreVersions", "id": "v3", "attributes": { "platform": "IOS", "versionString": "3.47.2", "appStoreState": "REJECTED", "appVersionState": "REJECTED", "createdAt": "2026-09-15T02:00:00Z" } },
    { "type": "appStoreVersions", "id": "v2", "attributes": { "platform": "IOS", "versionString": "3.47.1", "appStoreState": "READY_FOR_SALE", "appVersionState": "READY_FOR_DISTRIBUTION", "createdAt": "2026-08-20T02:00:00Z" } },
    { "type": "appStoreVersions", "id": "v1", "attributes": { "platform": "IOS", "versionString": "3.47.0", "appStoreState": "REPLACED_WITH_NEW_VERSION", "appVersionState": "REPLACED_WITH_NEW_VERSION", "createdAt": "2026-07-01T02:00:00Z" } }
  ]
}
```

- [ ] **Step 5: Write the failing App Store tests**

`server/sources/appstore.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import apps from './__fixtures__/asc-apps.json';
import versions from './__fixtures__/asc-versions.json';
import { AscTokenCache, ascJson, diffAppStore, fetchAppStore, loadAppStoreAccounts, parseAscApps, summarizeVersions } from './appstore';
import type { AppStoreAccount } from './appstore';
import type { SourceContext } from './types';
import type { AppStoreApp, AppStoreSnapshot } from '../../shared/types';
import { humanState } from '../../shared/status';

async function testAccount(): Promise<AppStoreAccount> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return { name: 'Acc', issuerId: 'iss-1', keyId: 'KEY1', privateKeyPem: pem };
}
const fakeFetch = (handler: (url: string, init?: RequestInit) => Response): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;

describe('parseAscApps / summarizeVersions', () => {
  test('maps apps', () => {
    expect(parseAscApps(apps)).toEqual([
      { id: '1111111111', name: 'SGPOS', bundleId: 'com.sitegiant.sgpos' },
      { id: '2222222222', name: 'Shopping App', bundleId: 'com.sitegiant.shopping' },
    ]);
  });
  test('picks the live version and the newest in-flight one, ignoring replaced versions', () => {
    expect(summarizeVersions(versions)).toEqual({ live: { version: '3.47.1', state: 'READY_FOR_DISTRIBUTION' }, inflight: { version: '3.47.2', state: 'REJECTED' } });
  });
  test('falls back to appStoreState and handles no in-flight version', () => {
    const only = { data: [{ id: 'v', attributes: { versionString: '1.0', appStoreState: 'READY_FOR_SALE', createdAt: '2026-01-01T00:00:00Z' } }] };
    expect(summarizeVersions(only)).toEqual({ live: { version: '1.0', state: 'READY_FOR_SALE' }, inflight: null });
  });
  test('humanState reads well', () => {
    expect(humanState('READY_FOR_SALE')).toBe('Ready for Sale');
    expect(humanState('PENDING_DEVELOPER_RELEASE')).toBe('Pending Developer Release');
    expect(humanState('inProgress')).toBe('In progress');
  });
});

describe('AscTokenCache', () => {
  test('issues an ES256 token with kid and caches it for the account', async () => {
    const acc = await testAccount();
    const cache = new AscTokenCache();
    const t1 = await cache.token(acc, 1_000_000_000_000);
    const t2 = await cache.token(acc, 1_000_000_000_000 + 60_000);
    expect(t1).toBe(t2);
    const header = JSON.parse(atob(t1.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'KEY1' });
    const t3 = await cache.token(acc, 1_000_000_000_000 + 16 * 60_000);
    expect(t3).not.toBe(t1);
  });
});

describe('ascJson', () => {
  test('sends a bearer token and names the account on 401', async () => {
    let auth: string | null = null;
    const ok = fakeFetch((_u, init) => { auth = new Headers(init?.headers).get('authorization'); return Response.json({ data: [] }); });
    expect(await ascJson(ok, 'tok', '/apps', 'Acc')).toEqual({ data: [] });
    expect(auth).toBe('Bearer tok');
    const bad = fakeFetch(() => new Response('{}', { status: 401 }));
    await expect(ascJson(bad, 'tok', '/apps', 'Acc')).rejects.toMatchObject({ hint: 'App Store key for account Acc rejected' });
  });
});

describe('fetchAppStore', () => {
  test('walks every account and app', async () => {
    const acc = await testAccount();
    const f = fakeFetch((url) => (url.includes('/appStoreVersions') ? Response.json(versions) : Response.json(apps)));
    const ctx: SourceContext<{ accounts: AppStoreAccount[] }> = { config: { accounts: [acc] }, run: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }), fetch: f, log: () => {}, now: Date.now };
    const snap = await fetchAppStore(ctx);
    expect(snap.apps.map((a) => [a.account, a.name, a.inflight?.state])).toEqual([['Acc', 'SGPOS', 'REJECTED'], ['Acc', 'Shopping App', 'REJECTED']]);
    expect(snap.apps[0]?.url).toBe('https://appstoreconnect.apple.com/apps/1111111111/distribution');
  });
});

const app = (over: Partial<AppStoreApp> = {}): AppStoreApp => ({
  account: 'Acc', appId: '1', name: 'SGPOS', bundleId: 'b', live: { version: '1.0', state: 'READY_FOR_SALE' }, inflight: null, url: 'u', ...over,
});
const snap = (...apps: AppStoreApp[]): AppStoreSnapshot => ({ apps });

describe('diffAppStore', () => {
  test('first snapshot produces nothing', () => {
    expect(diffAppStore(null, snap(app()))).toEqual([]);
  });
  test('a rejection is high priority, entering review is normal', () => {
    expect(diffAppStore(snap(app()), snap(app({ inflight: { version: '1.1', state: 'REJECTED' } })))).toEqual([
      { source: 'appstore', kind: 'store.state_changed', priority: 'high', itemId: 'Acc/1', title: 'SGPOS iOS 1.1: Rejected', url: 'u' },
    ]);
    expect(diffAppStore(snap(app()), snap(app({ inflight: { version: '1.1', state: 'IN_REVIEW' } })))[0]?.priority).toBe('normal');
  });
  test('a new live version is a normal event; no change is nothing', () => {
    const a = app({ inflight: { version: '1.1', state: 'IN_REVIEW' } });
    const b = app({ live: { version: '1.1', state: 'READY_FOR_SALE' } });
    expect(diffAppStore(snap(a), snap(b)).map((e) => e.title)).toEqual(['SGPOS iOS 1.1: Ready for Sale']);
    expect(diffAppStore(snap(a), snap(a))).toEqual([]);
  });
});

describe('loadAppStoreAccounts', () => {
  test('reads each key file relative to the config dir', () => {
    const accounts = loadAppStoreAccounts(
      [{ name: 'A', appstore: { issuerId: 'i', keyId: 'k', keyFile: 'secrets/a.p8' } }, { name: 'B' }],
      'C:/repo/config',
      (p) => `PEM(${p.replace(/\\/g, '/')})`,
    );
    expect(accounts).toEqual([{ name: 'A', issuerId: 'i', keyId: 'k', privateKeyPem: 'PEM(C:/repo/config/secrets/a.p8)' }]);
  });
});
```

- [ ] **Step 6: Run the tests to confirm they fail**

Run: `bun test server/sources/appstore.test.ts` → Expected: FAIL, "Cannot find module './appstore'".

- [ ] **Step 7: Write server/sources/appstore.ts**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APPSTORE_DEAD_STATES, APPSTORE_HIGH_STATES, APPSTORE_LIVE_STATES, humanState } from '../../shared/status';
import type { AppStoreApp, AppStoreSnapshot, AppStoreVersion, NewEvent } from '../../shared/types';
import type { StoreAccountConfig } from '../config';
import { importPrivateKey, signJwt } from '../jwt';
import { SourceError } from './types';
import type { Source, SourceContext } from './types';

export interface AppStoreAccount {
  name: string;
  issuerId: string;
  keyId: string;
  privateKeyPem: string;
}
export interface AppStoreConfig {
  accounts: AppStoreAccount[];
}

export const ASC_API = 'https://api.appstoreconnect.apple.com/v1';
const TOKEN_TTL_SEC = 15 * 60;

export class AscTokenCache {
  private cache = new Map<string, { token: string; expMs: number }>();

  async token(acc: AppStoreAccount, now: number = Date.now()): Promise<string> {
    const hit = this.cache.get(acc.keyId);
    if (hit && hit.expMs - 60_000 > now) return hit.token;
    const key = await importPrivateKey(acc.privateKeyPem, 'ES256');
    const iat = Math.floor(now / 1000);
    const exp = iat + TOKEN_TTL_SEC;
    const token = await signJwt({ alg: 'ES256', header: { kid: acc.keyId }, payload: { iss: acc.issuerId, iat, exp, aud: 'appstoreconnect-v1' }, key });
    this.cache.set(acc.keyId, { token, expMs: exp * 1000 });
    return token;
  }
}

interface RawApp { id: string; attributes: { name: string; bundleId: string } }
interface RawVersion { id: string; attributes: { versionString: string; appStoreState?: string | null; appVersionState?: string | null; createdAt?: string } }

export function parseAscApps(raw: unknown): { id: string; name: string; bundleId: string }[] {
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new SourceError('App Store Connect /apps: unexpected response shape');
  return (data as RawApp[]).map((a) => ({ id: a.id, name: a.attributes.name, bundleId: a.attributes.bundleId }));
}

export function summarizeVersions(raw: unknown): { live: AppStoreVersion | null; inflight: AppStoreVersion | null } {
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new SourceError('App Store Connect /appStoreVersions: unexpected response shape');
  const versions = (data as RawVersion[])
    .map((v) => ({ version: v.attributes.versionString, state: v.attributes.appVersionState ?? v.attributes.appStoreState ?? 'UNKNOWN', createdAt: v.attributes.createdAt ?? '' }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const live = versions.find((v) => APPSTORE_LIVE_STATES.has(v.state)) ?? null;
  const inflight = versions.find((v) => v !== live && !APPSTORE_LIVE_STATES.has(v.state) && !APPSTORE_DEAD_STATES.has(v.state) && (!live || v.createdAt >= live.createdAt)) ?? null;
  const strip = (v: typeof live): AppStoreVersion | null => (v ? { version: v.version, state: v.state } : null);
  return { live: strip(live), inflight: strip(inflight) };
}

export async function ascJson(fetchImpl: typeof fetch, token: string, path: string, accountName: string): Promise<unknown> {
  const res = await fetchImpl(`${ASC_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) throw new SourceError(`App Store Connect ${path}: HTTP ${res.status}`, `App Store key for account ${accountName} rejected`);
  if (!res.ok) throw new SourceError(`App Store Connect ${path} (${accountName}): HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const tokens = new AscTokenCache();
export const ascAppUrl = (appId: string): string => `https://appstoreconnect.apple.com/apps/${appId}/distribution`;

export async function fetchAppStore(ctx: SourceContext<AppStoreConfig>): Promise<AppStoreSnapshot> {
  const apps: AppStoreApp[] = [];
  for (const acc of ctx.config.accounts) {
    const token = await tokens.token(acc, ctx.now());
    const list = parseAscApps(await ascJson(ctx.fetch, token, '/apps?limit=200', acc.name));
    for (const app of list) {
      const versions = summarizeVersions(await ascJson(ctx.fetch, token, `/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=5`, acc.name));
      apps.push({ account: acc.name, appId: app.id, name: app.name, bundleId: app.bundleId, live: versions.live, inflight: versions.inflight, url: ascAppUrl(app.id) });
    }
  }
  return { apps };
}

const versionKey = (v: AppStoreVersion | null) => (v ? `${v.version}@${v.state}` : '');

export function diffAppStore(prev: AppStoreSnapshot | null, next: AppStoreSnapshot): NewEvent[] {
  if (!prev) return [];
  const before = new Map(prev.apps.map((a) => [`${a.account}/${a.appId}`, a]));
  const events: NewEvent[] = [];
  for (const app of next.apps) {
    const id = `${app.account}/${app.appId}`;
    const p = before.get(id);
    if (!p) continue;
    const changed: AppStoreVersion[] = [];
    if (versionKey(p.inflight) !== versionKey(app.inflight) && app.inflight) changed.push(app.inflight);
    if (versionKey(p.live) !== versionKey(app.live) && app.live) changed.push(app.live);
    for (const v of changed) {
      events.push({
        source: 'appstore',
        kind: 'store.state_changed',
        priority: APPSTORE_HIGH_STATES.has(v.state) ? 'high' : 'normal',
        itemId: id,
        title: `${app.name} iOS ${v.version}: ${humanState(v.state)}`,
        url: app.url,
      });
    }
  }
  return events;
}

export const appstoreSource: Source<AppStoreSnapshot, AppStoreConfig> = {
  id: 'appstore',
  defaultIntervalSec: 600,
  fetch: fetchAppStore,
  diff: diffAppStore,
};

export function loadAppStoreAccounts(
  accounts: StoreAccountConfig[],
  configDir: string,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): AppStoreAccount[] {
  return accounts
    .filter((a): a is StoreAccountConfig & { appstore: NonNullable<StoreAccountConfig['appstore']> } => !!a.appstore)
    .map((a) => ({ name: a.name, issuerId: a.appstore.issuerId, keyId: a.appstore.keyId, privateKeyPem: readFile(resolve(configDir, a.appstore.keyFile)) }));
}
```

- [ ] **Step 8: Run the tests**

Run: `bun test server/sources/appstore.test.ts` → Expected: 11 pass. `bun test server/sources/codemagic.test.ts` still passes (it now imports from `shared/status.ts`).

- [ ] **Step 9: Register the source**

In `server/sources/index.ts` add after the Lark block:

```ts
import { appstoreSource, loadAppStoreAccounts } from './appstore';
// ...
  const appstoreDisabled = loaded.problems.appstore ?? null;
  const ascAccounts = appstoreDisabled ? [] : loadAppStoreAccounts(loaded.config.stores.accounts, loaded.configDir);
  sources.push({ source: appstoreSource, ctx: { ...base, config: { accounts: ascAccounts } }, intervalSec: loaded.config.polling.stores, disabled: appstoreDisabled });
```

- [ ] **Step 10: Verify live (needs a key)**

For one account: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → Generate (role Developer is enough to read). Download the `.p8` into `config/secrets/`, copy Key ID and Issuer ID into `stores.accounts[].appstore`. `bun run start` → expect `appstore: ok`. `/api/state` shows `states.appstore.snapshot.apps[]` with `live` and `inflight`. Compare a rejected app (if any) against App Store Connect to confirm the state string, and note whether any endpoint response contains the reviewer message text (spec §5.4 says it does not; if you find it does, open a follow-up, do not extend this task). Without a key yet, carry this to Task 21.

- [ ] **Step 11: Commit**

```bash
bun test
git add server/jwt.ts server/jwt.test.ts shared/status.ts server/sources/appstore.ts server/sources/appstore.test.ts server/sources/__fixtures__/asc-*.json server/sources/index.ts
git commit -m "feat(appstore): app store connect source with es256 jwt auth

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Google Play source

**Files:**
- Create: `server/sources/playstore.ts`, `server/sources/playstore.test.ts`, `server/sources/__fixtures__/play-tracks.json`
- Modify: `shared/status.ts` (Play statuses), `server/sources/index.ts`

**Interfaces:**
- Consumes: `signJwt`, `importPrivateKey` (Task 10); `StoreAccountConfig`, `PlayAppConfig` (Task 2); `PlaySnapshot`, `PlayApp`, `PlayRelease`, `NewEvent`.
- Produces: `PlayAccount { name, developerId, clientEmail, privateKeyPem, tokenUri, apps }`, `PlayConfig { accounts }`, `PLAY_API`, `PLAY_SCOPE`, `class PlayTokenCache { token(acc, fetchImpl, now?) }`, `parseTracks(raw): PlayRelease[]`, `readReleases(fetchImpl, token, packageName, accountName)`, `playConsoleUrl(acc, app)`, `fetchPlay(ctx)`, `diffPlay(prev, next)`, `playstoreSource`, `loadPlayAccounts(accounts, configDir, readFile?)`. In `shared/status.ts`: `PLAY_ATTENTION_STATUSES`.

The Play Developer API has no "list apps" call; packages come from config. Reading tracks needs a throw-away edit: `POST …/edits` → `GET …/edits/{id}/tracks` → `DELETE …/edits/{id}`.

- [ ] **Step 1: Extend shared/status.ts**

Append:

```ts
// ---- Google Play track release statuses ----
export const PLAY_ATTENTION_STATUSES: ReadonlySet<string> = new Set(['inProgress', 'halted']);
```

- [ ] **Step 2: Write the fixture**

`server/sources/__fixtures__/play-tracks.json`:

```json
{
  "kind": "androidpublisher#tracksListResponse",
  "tracks": [
    { "track": "production", "releases": [ { "name": "3.47.1", "versionCodes": ["347102"], "status": "completed" } ] },
    { "track": "beta", "releases": [ { "name": "3.47.2", "versionCodes": ["347201"], "status": "inProgress", "userFraction": 0.2 } ] },
    { "track": "internal", "releases": [] }
  ]
}
```

- [ ] **Step 3: Write the failing tests**

`server/sources/playstore.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import tracks from './__fixtures__/play-tracks.json';
import { PlayTokenCache, diffPlay, fetchPlay, loadPlayAccounts, parseTracks, playConsoleUrl } from './playstore';
import type { PlayAccount } from './playstore';
import type { SourceContext } from './types';
import type { PlayApp, PlaySnapshot } from '../../shared/types';

async function testAccount(): Promise<PlayAccount> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return { name: 'Acc', developerId: '999', clientEmail: 'sa@example.iam.gserviceaccount.com', privateKeyPem: pem, tokenUri: 'https://oauth2.googleapis.com/token', apps: [{ packageName: 'com.x.app', name: 'SGPOS' }] };
}
const fakeFetch = (handler: (url: string, init?: RequestInit) => Response): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;

describe('parseTracks', () => {
  test('flattens releases across tracks and drops empty tracks', () => {
    expect(parseTracks(tracks)).toEqual([
      { track: 'production', name: '3.47.1', versionCodes: ['347102'], status: 'completed', userFraction: null },
      { track: 'beta', name: '3.47.2', versionCodes: ['347201'], status: 'inProgress', userFraction: 0.2 },
    ]);
  });
  test('rejects an unexpected shape', () => {
    expect(() => parseTracks({})).toThrow('unexpected response shape');
  });
});

describe('PlayTokenCache', () => {
  test('exchanges a signed assertion for an access token and caches it', async () => {
    const acc = await testAccount();
    let posted: URLSearchParams | null = null;
    let calls = 0;
    const f = fakeFetch((url, init) => { calls++; expect(url).toBe(acc.tokenUri); posted = new URLSearchParams(String(init?.body)); return Response.json({ access_token: 'ya29.x', expires_in: 3600 }); });
    const cache = new PlayTokenCache();
    expect(await cache.token(acc, f, 1_000_000_000_000)).toBe('ya29.x');
    expect(posted!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = JSON.parse(atob(posted!.get('assertion')!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(claims).toMatchObject({ iss: acc.clientEmail, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: acc.tokenUri });
    await cache.token(acc, f, 1_000_000_000_000 + 1000);
    expect(calls).toBe(1);
  });
});

describe('fetchPlay', () => {
  test('creates an edit, reads tracks, deletes the edit', async () => {
    const acc = await testAccount();
    const seen: string[] = [];
    const f = fakeFetch((url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/token')) return Response.json({ access_token: 't', expires_in: 3600 });
      if (url.endsWith('/edits') && init?.method === 'POST') return Response.json({ id: 'edit1' });
      if (url.endsWith('/edits/edit1/tracks')) return Response.json(tracks);
      if (url.endsWith('/edits/edit1') && init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('nope', { status: 404 });
    });
    const ctx: SourceContext<{ accounts: PlayAccount[] }> = { config: { accounts: [acc] }, run: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }), fetch: f, log: () => {}, now: Date.now };
    const snap = await fetchPlay(ctx);
    expect(snap.apps).toHaveLength(1);
    expect(snap.apps[0]).toMatchObject({ account: 'Acc', packageName: 'com.x.app', name: 'SGPOS', url: 'https://play.google.com/console/u/0/developers/999/app-list' });
    expect(snap.apps[0]?.releases.map((r) => r.track)).toEqual(['production', 'beta']);
    expect(seen.some((s) => s.startsWith('DELETE ') && s.endsWith('/edits/edit1'))).toBe(true);
  });

  test('a 403 names the account', async () => {
    const acc = await testAccount();
    const f = fakeFetch((url) => (url.endsWith('/token') ? Response.json({ access_token: 't', expires_in: 3600 }) : new Response('{}', { status: 403 })));
    const ctx: SourceContext<{ accounts: PlayAccount[] }> = { config: { accounts: [acc] }, run: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }), fetch: f, log: () => {}, now: Date.now };
    await expect(fetchPlay(ctx)).rejects.toMatchObject({ hint: 'Play service account for account Acc rejected or not invited' });
  });
});

test('playConsoleUrl prefers the configured url', () => {
  const acc = { developerId: '999' } as PlayAccount;
  expect(playConsoleUrl(acc, { packageName: 'p', name: 'n', consoleUrl: 'https://c' })).toBe('https://c');
  expect(playConsoleUrl(acc, { packageName: 'p', name: 'n' })).toBe('https://play.google.com/console/u/0/developers/999/app-list');
});

const app = (releases: PlayApp['releases']): PlayApp => ({ account: 'Acc', packageName: 'com.x.app', name: 'SGPOS', releases, url: 'u' });
const snap = (...apps: PlayApp[]): PlaySnapshot => ({ apps });

describe('diffPlay', () => {
  const prod = { track: 'production', name: '3.47.1', versionCodes: ['347102'], status: 'completed', userFraction: null };
  test('first snapshot produces nothing', () => {
    expect(diffPlay(null, snap(app([prod])))).toEqual([]);
  });
  test('a rollout change is normal, a halt is high, no change is nothing', () => {
    const rolling = { track: 'production', name: '3.47.2', versionCodes: ['347201'], status: 'inProgress', userFraction: 0.2 };
    expect(diffPlay(snap(app([prod])), snap(app([rolling])))).toEqual([
      { source: 'playstore', kind: 'store.state_changed', priority: 'normal', itemId: 'Acc/com.x.app/production', title: 'SGPOS Android production 3.47.2: In progress 20%', url: 'u' },
    ]);
    expect(diffPlay(snap(app([rolling])), snap(app([{ ...rolling, status: 'halted' }])))[0]?.priority).toBe('high');
    expect(diffPlay(snap(app([prod])), snap(app([prod])))).toEqual([]);
  });
});

test('loadPlayAccounts reads the service-account json', () => {
  const sa = JSON.stringify({ client_email: 'sa@x', private_key: 'PEM', token_uri: 'https://t' });
  const out = loadPlayAccounts([{ name: 'A', play: { serviceAccountFile: 'secrets/p.json', developerId: '1', apps: [{ packageName: 'p', name: 'n' }] } }, { name: 'B' }], 'C:/repo/config', () => sa);
  expect(out).toEqual([{ name: 'A', developerId: '1', clientEmail: 'sa@x', privateKeyPem: 'PEM', tokenUri: 'https://t', apps: [{ packageName: 'p', name: 'n' }] }]);
});
```

- [ ] **Step 4: Run the tests to confirm they fail**

Run: `bun test server/sources/playstore.test.ts` → Expected: FAIL, "Cannot find module './playstore'".

- [ ] **Step 5: Write server/sources/playstore.ts**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { humanState } from '../../shared/status';
import type { NewEvent, PlayApp, PlayRelease, PlaySnapshot } from '../../shared/types';
import type { PlayAppConfig, StoreAccountConfig } from '../config';
import { importPrivateKey, signJwt } from '../jwt';
import { SourceError } from './types';
import type { Source, SourceContext } from './types';

export interface PlayAccount {
  name: string;
  developerId: string;
  clientEmail: string;
  privateKeyPem: string;
  tokenUri: string;
  apps: PlayAppConfig[];
}
export interface PlayConfig {
  accounts: PlayAccount[];
}

export const PLAY_API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
export const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export class PlayTokenCache {
  private cache = new Map<string, { token: string; expMs: number }>();

  async token(acc: PlayAccount, fetchImpl: typeof fetch, now: number = Date.now()): Promise<string> {
    const hit = this.cache.get(acc.clientEmail);
    if (hit && hit.expMs - 60_000 > now) return hit.token;
    const key = await importPrivateKey(acc.privateKeyPem, 'RS256');
    const iat = Math.floor(now / 1000);
    const assertion = await signJwt({ alg: 'RS256', payload: { iss: acc.clientEmail, scope: PLAY_SCOPE, aud: acc.tokenUri, iat, exp: iat + 3600 }, key });
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    const res = await fetchImpl(acc.tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new SourceError(`Google token exchange for ${acc.name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`, `Play service account for account ${acc.name} rejected or not invited`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new SourceError(`Google token exchange for ${acc.name}: no access_token`);
    this.cache.set(acc.clientEmail, { token: json.access_token, expMs: now + (json.expires_in ?? 3600) * 1000 });
    return json.access_token;
  }
}

interface RawTrack { track: string; releases?: Array<{ name?: string; versionCodes?: string[]; status?: string; userFraction?: number }> }

export function parseTracks(raw: unknown): PlayRelease[] {
  const list = (raw as { tracks?: unknown }).tracks;
  if (!Array.isArray(list)) throw new SourceError('Google Play tracks: unexpected response shape');
  return (list as RawTrack[]).flatMap((t) =>
    (t.releases ?? []).map((r) => ({
      track: t.track,
      name: r.name ?? null,
      versionCodes: r.versionCodes ?? [],
      status: r.status ?? 'statusUnspecified',
      userFraction: typeof r.userFraction === 'number' ? r.userFraction : null,
    })),
  );
}

async function playFetch(fetchImpl: typeof fetch, token: string, url: string, accountName: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetchImpl(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) } });
  if (res.status === 401 || res.status === 403) throw new SourceError(`Google Play ${url}: HTTP ${res.status}`, `Play service account for account ${accountName} rejected or not invited`);
  if (!res.ok) throw new SourceError(`Google Play ${url} (${accountName}): HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

export async function readReleases(fetchImpl: typeof fetch, token: string, packageName: string, accountName: string): Promise<PlayRelease[]> {
  const base = `${PLAY_API}/${encodeURIComponent(packageName)}/edits`;
  const edit = (await (await playFetch(fetchImpl, token, base, accountName, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).json()) as { id?: string };
  if (!edit.id) throw new SourceError(`Google Play edits.insert for ${packageName}: no edit id`);
  try {
    return parseTracks(await (await playFetch(fetchImpl, token, `${base}/${edit.id}/tracks`, accountName)).json());
  } finally {
    await fetchImpl(`${base}/${edit.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
}

export const playConsoleUrl = (acc: PlayAccount, app: PlayAppConfig): string =>
  app.consoleUrl ?? `https://play.google.com/console/u/0/developers/${acc.developerId}/app-list`;

const tokens = new PlayTokenCache();

export async function fetchPlay(ctx: SourceContext<PlayConfig>): Promise<PlaySnapshot> {
  const apps: PlayApp[] = [];
  for (const acc of ctx.config.accounts) {
    const token = await tokens.token(acc, ctx.fetch, ctx.now());
    for (const app of acc.apps) {
      const releases = await readReleases(ctx.fetch, token, app.packageName, acc.name);
      apps.push({ account: acc.name, packageName: app.packageName, name: app.name, releases, url: playConsoleUrl(acc, app) });
    }
  }
  return { apps };
}

const releaseKey = (r: PlayRelease) => `${r.name ?? ''}|${r.versionCodes.join(',')}|${r.status}|${r.userFraction ?? ''}`;

export function diffPlay(prev: PlaySnapshot | null, next: PlaySnapshot): NewEvent[] {
  if (!prev) return [];
  const before = new Map<string, PlayRelease>();
  for (const a of prev.apps) for (const r of a.releases) before.set(`${a.account}/${a.packageName}/${r.track}`, r);
  const events: NewEvent[] = [];
  for (const app of next.apps) {
    for (const r of app.releases) {
      const id = `${app.account}/${app.packageName}/${r.track}`;
      const p = before.get(id);
      if (!p || releaseKey(p) === releaseKey(r)) continue;
      const pct = r.userFraction != null ? ` ${Math.round(r.userFraction * 100)}%` : '';
      events.push({
        source: 'playstore',
        kind: 'store.state_changed',
        priority: r.status === 'halted' ? 'high' : 'normal',
        itemId: id,
        title: `${app.name} Android ${r.track} ${r.name ?? r.versionCodes.join(',')}: ${humanState(r.status)}${pct}`,
        url: app.url,
      });
    }
  }
  return events;
}

export const playstoreSource: Source<PlaySnapshot, PlayConfig> = {
  id: 'playstore',
  defaultIntervalSec: 600,
  fetch: fetchPlay,
  diff: diffPlay,
};

export function loadPlayAccounts(
  accounts: StoreAccountConfig[],
  configDir: string,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): PlayAccount[] {
  return accounts
    .filter((a): a is StoreAccountConfig & { play: NonNullable<StoreAccountConfig['play']> } => !!a.play)
    .map((a) => {
      const sa = JSON.parse(readFile(resolve(configDir, a.play.serviceAccountFile))) as { client_email?: string; private_key?: string; token_uri?: string };
      if (!sa.client_email || !sa.private_key) throw new Error(`service account file for ${a.name} lacks client_email/private_key`);
      return { name: a.name, developerId: a.play.developerId, clientEmail: sa.client_email, privateKeyPem: sa.private_key, tokenUri: sa.token_uri ?? 'https://oauth2.googleapis.com/token', apps: a.play.apps };
    });
}
```

- [ ] **Step 6: Run the tests**

Run: `bun test server/sources/playstore.test.ts` → Expected: 9 pass.

- [ ] **Step 7: Register the source**

In `server/sources/index.ts` add after the App Store block:

```ts
import { loadPlayAccounts, playstoreSource } from './playstore';
// ...
  const playDisabled = loaded.problems.playstore ?? null;
  const playAccounts = playDisabled ? [] : loadPlayAccounts(loaded.config.stores.accounts, loaded.configDir);
  sources.push({ source: playstoreSource, ctx: { ...base, config: { accounts: playAccounts } }, intervalSec: loaded.config.polling.stores, disabled: playDisabled });
```

- [ ] **Step 8: Verify live (needs a service account)**

Per account: Google Cloud Console → create a service account → JSON key into `config/secrets/`; Play Console → Users and permissions → Invite new users → the service-account email, with "View app information" on the apps to watch. Fill `stores.accounts[].play` with `serviceAccountFile`, `developerId` (the number in the Play Console URL) and each app's `packageName`, display `name` and optional `consoleUrl`. `bun run start` → expect `playstore: ok`; `/api/state` shows `releases[]` per package. Without credentials yet, carry to Task 21.

- [ ] **Step 9: Commit**

```bash
bun test
git add shared/status.ts server/sources/playstore.ts server/sources/playstore.test.ts server/sources/__fixtures__/play-tracks.json server/sources/index.ts
git commit -m "feat(playstore): google play track source with service-account auth

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Live check script

**Files:**
- Create: `server/check.ts`, `server/check.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `buildSources`, `describeError`, all snapshot types.
- Produces: `summarize(id, snapshot): string`, `formatTable(rows: string[][]): string`; running `bun run check` prints one row per source and exits 1 if any row is ERROR.

- [ ] **Step 1: Write the failing tests**

`server/check.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { formatTable, summarize } from './check';

test('summarize gives a one-line count per source', () => {
  expect(summarize('github', { login: 'j', incoming: [1, 2], mine: [3] })).toBe('2 incoming, 1 mine');
  expect(summarize('codemagic', { apps: [{ builds: [1, 2] }, { builds: [] }] })).toBe('2 apps, 2 builds');
  expect(summarize('lark', { tasks: { total: 5 }, issues: { counts: { OPEN: 4, CLOSED: 1 } }, feedback: { records: [1] } })).toBe('5 tasks, 5 issues, 1 feedback');
  expect(summarize('appstore', { apps: [1] })).toBe('1 apps');
  expect(summarize('playstore', { apps: [1, 2] })).toBe('2 apps');
});

test('formatTable pads columns', () => {
  expect(formatTable([['a', 'OK', 'x'], ['long', 'ERROR', 'y']])).toBe('a     OK     x\nlong  ERROR  y');
});
```

- [ ] **Step 2: Write server/check.ts**

```ts
import { resolve } from 'node:path';
import type { AppStoreSnapshot, CodemagicSnapshot, GithubSnapshot, LarkSnapshot, PlaySnapshot, SourceId } from '../shared/types';
import { loadConfig } from './config';
import { buildSources } from './sources/index';
import { describeError } from './sources/types';

export function summarize(id: SourceId, snapshot: unknown): string {
  switch (id) {
    case 'github': {
      const s = snapshot as GithubSnapshot;
      return `${s.incoming.length} incoming, ${s.mine.length} mine`;
    }
    case 'codemagic': {
      const s = snapshot as CodemagicSnapshot;
      return `${s.apps.length} apps, ${s.apps.reduce((n, a) => n + a.builds.length, 0)} builds`;
    }
    case 'lark': {
      const s = snapshot as LarkSnapshot;
      const issues = Object.values(s.issues.counts).reduce((a, b) => a + b, 0);
      return `${s.tasks.total} tasks, ${issues} issues, ${s.feedback.records.length} feedback`;
    }
    case 'appstore':
      return `${(snapshot as AppStoreSnapshot).apps.length} apps`;
    case 'playstore':
      return `${(snapshot as PlaySnapshot).apps.length} apps`;
  }
}

export function formatTable(rows: string[][]): string {
  const widths = rows.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ')).join('\n');
}

async function main(): Promise<number> {
  const loaded = loadConfig(resolve(import.meta.dir, '..'));
  const { sources } = await buildSources(loaded, { log: () => {}, getSnapshot: () => null });
  const rows: string[][] = [];
  let failed = false;
  for (const reg of sources) {
    const id = reg.source.id;
    if (reg.disabled) {
      rows.push([id, 'DISABLED', reg.disabled]);
      continue;
    }
    const t0 = Date.now();
    try {
      const snap: unknown = await reg.source.fetch(reg.ctx);
      rows.push([id, 'OK', `${Date.now() - t0} ms · ${summarize(id, snap)}`]);
    } catch (err) {
      failed = true;
      rows.push([id, 'ERROR', describeError(err)]);
    }
  }
  console.log(formatTable(rows));
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
```

- [ ] **Step 3: Run the tests and the script**

Run: `bun test server/check.test.ts` → Expected: 2 pass.
Run: `bun run check` → a five-row table. With placeholder config, expect `github OK …`, others `DISABLED …`; nothing may crash.

- [ ] **Step 4: Commit**

```bash
git add server/check.ts server/check.test.ts
git commit -m "feat(server): bun run check prints one live row per source

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Needs-attention rules

**Files:**
- Create: `shared/attention.ts`, `shared/attention.test.ts`

**Interfaces:**
- Consumes: `SourceStates`, `AttentionChip`, `PublicConfig` (Task 1); `isBuildRunning`, `isBuildFailed`, `APPSTORE_ATTENTION_STATES`, `APPSTORE_REJECTED_STATES`, `PLAY_ATTENTION_STATUSES`, `humanState` (Tasks 8–11).
- Produces: `computeAttention(states, config: Pick<PublicConfig, 'pendingLaunchStatus' | 'showIssueStatuses'>, now: number): AttentionChip[]`, `parseDays(hoursSince: string): number | null`, `emptyStates(): SourceStates`.

Rules and order are spec §4.2, one chip per row of that table.

- [ ] **Step 1: Write the failing tests**

`shared/attention.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { computeAttention, emptyStates, parseDays } from './attention';
import type { SourceStates } from './types';

const cfg = { pendingLaunchStatus: 'PENDING TO LAUNCH', showIssueStatuses: ['OPEN', 'CHECKING'] };
const NOW = Date.parse('2026-09-17T02:00:00Z');
const withSnapshot = <K extends keyof SourceStates>(states: SourceStates, key: K, snapshot: NonNullable<SourceStates[K]['snapshot']>): SourceStates =>
  ({ ...states, [key]: { ...states[key], snapshot, fetchedAt: NOW } });

const pr = (over: Record<string, unknown>) => ({ id: 'x', number: 1, title: 't', url: 'u', isDraft: false, createdAt: '', updatedAt: '', authorLogin: 'a', authorAvatarUrl: '', repo: 'o/r', reviewDecision: null, ci: null, ...over });

describe('computeAttention', () => {
  test('empty states produce no chips', () => {
    expect(computeAttention(emptyStates(), cfg, NOW)).toEqual([]);
  });

  test('pull requests: non-draft incoming and my PRs needing changes', () => {
    const states = withSnapshot(emptyStates(), 'github', {
      login: 'j',
      incoming: [pr({ id: '1' }), pr({ id: '2', isDraft: true }), pr({ id: '3' })],
      mine: [pr({ id: '4', reviewDecision: 'CHANGES_REQUESTED' }), pr({ id: '5', ci: 'FAILURE' }), pr({ id: '6' })],
    });
    const chips = computeAttention(states, cfg, NOW);
    expect(chips.map((c) => [c.id, c.text, c.tone, c.target])).toEqual([
      ['prs-incoming', '2 PRs await your review', 'amber', 'prs'],
      ['prs-mine', '2 of your PRs need changes', 'amber', 'prs'],
    ]);
  });

  test('builds: failures in the last 24 h and running builds', () => {
    const build = (id: string, status: string, finishedAt: string | null) => ({ id, appId: 'a', workflowId: 'w', workflowName: 'ios-release', branch: 'main', status, startedAt: null, finishedAt, durationSec: null, startedBy: null, url: 'u', artifacts: [] });
    const states = withSnapshot(emptyStates(), 'codemagic', {
      apps: [{ id: 'a', name: 'SGPOS', workflows: [], builds: [build('1', 'failed', '2026-09-17T01:00:00Z'), build('2', 'failed', '2026-09-15T01:00:00Z'), build('3', 'building', null)] }],
    });
    const chips = computeAttention(states, cfg, NOW);
    expect(chips.map((c) => [c.id, c.text, c.detail, c.tone, c.pulse])).toEqual([
      ['builds-failed', '1 build failed', 'SGPOS · ios-release', 'red', false],
      ['builds-running', '1 building', null, 'grey', true],
    ]);
  });

  test('lark: open issues with oldest age, checking count, pending launch tasks', () => {
    const rec = (id: string, fields: Record<string, string>) => ({ recordId: id, url: 'u', fields });
    const states = withSnapshot(emptyStates(), 'lark', {
      tasks: { groups: [{ status: 'PENDING TO LAUNCH', records: [rec('t1', {}), rec('t2', {})] }, { status: 'IN PROGRESS', records: [rec('t3', {})] }], total: 3 },
      issues: {
        groups: [
          { status: 'OPEN', records: [rec('i1', { hoursSince: '24 hours | 1 days' }), rec('i2', { hoursSince: '1237 hours | 51.5 days' })] },
          { status: 'CHECKING', records: [rec('i3', { hoursSince: '217 hours | 9 days' })] },
        ],
        counts: { OPEN: 2, CHECKING: 1 },
      },
      feedback: { records: [] },
    });
    expect(computeAttention(states, cfg, NOW).map((c) => [c.id, c.text, c.detail, c.tone])).toEqual([
      ['issues-open', '2 open issues', 'oldest 51.5 d', 'amber'],
      ['issues-checking', '1 checking', null, 'grey'],
      ['tasks-pending', '2 pending to launch', null, 'blue'],
    ]);
  });

  test('stores: one chip per iOS app in an attention state and per Android rollout', () => {
    let states = withSnapshot(emptyStates(), 'appstore', {
      apps: [
        { account: 'A', appId: '1', name: 'SGPOS', bundleId: 'b', live: { version: '1', state: 'READY_FOR_SALE' }, inflight: { version: '2', state: 'REJECTED' }, url: 'u' },
        { account: 'A', appId: '2', name: 'Shop', bundleId: 'b', live: { version: '1', state: 'READY_FOR_SALE' }, inflight: { version: '2', state: 'WAITING_FOR_REVIEW' }, url: 'u' },
        { account: 'A', appId: '3', name: 'Quiet', bundleId: 'b', live: { version: '1', state: 'READY_FOR_SALE' }, inflight: null, url: 'u' },
      ],
    });
    states = withSnapshot(states, 'playstore', {
      apps: [{ account: 'A', packageName: 'p', name: 'SGPOS', url: 'u', releases: [
        { track: 'production', name: '1', versionCodes: [], status: 'completed', userFraction: null },
        { track: 'beta', name: '2', versionCodes: [], status: 'inProgress', userFraction: 0.2 },
      ] }],
    });
    expect(computeAttention(states, cfg, NOW).map((c) => [c.id, c.text, c.detail, c.tone])).toEqual([
      ['ios-A-1', 'SGPOS iOS', 'Rejected', 'red'],
      ['ios-A-2', 'Shop iOS', 'Waiting for Review', 'amber'],
      ['android-A-p-beta', 'SGPOS Android', 'beta 20% rollout', 'blue'],
    ]);
  });
});

test('parseDays reads the days figure, falls back to hours', () => {
  expect(parseDays('1237 hours | 51.5 days')).toBe(51.5);
  expect(parseDays('6 hours')).toBe(0.25);
  expect(parseDays('')).toBeNull();
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `bun test shared/attention.test.ts` → Expected: FAIL, "Cannot find module './attention'".

- [ ] **Step 3: Write shared/attention.ts**

```ts
import { APPSTORE_ATTENTION_STATES, APPSTORE_REJECTED_STATES, PLAY_ATTENTION_STATUSES, humanState, isBuildFailed, isBuildRunning } from './status';
import { SOURCE_IDS } from './types';
import type { AttentionChip, PublicConfig, SourceStates } from './types';

export function emptyStates(): SourceStates {
  const out: Record<string, unknown> = {};
  for (const id of SOURCE_IDS) out[id] = { snapshot: null, fetchedAt: null, error: null, errorAt: null, disabled: null };
  return out as SourceStates;
}

/** "1237 hours | 51.5 days" -> 51.5; "6 hours" -> 0.25; anything else -> null. */
export function parseDays(hoursSince: string): number | null {
  const days = /([\d.]+)\s*days?/i.exec(hoursSince);
  if (days) return Number(days[1]);
  const hours = /([\d.]+)\s*hours?/i.exec(hoursSince);
  return hours ? Number(hours[1]) / 24 : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const DAY_MS = 24 * 3600 * 1000;

export function computeAttention(states: SourceStates, config: Pick<PublicConfig, 'pendingLaunchStatus' | 'showIssueStatuses'>, now: number): AttentionChip[] {
  const chips: AttentionChip[] = [];
  const chip = (c: Omit<AttentionChip, 'detail' | 'pulse'> & Partial<Pick<AttentionChip, 'detail' | 'pulse'>>) =>
    chips.push({ detail: null, pulse: false, ...c });

  const gh = states.github.snapshot;
  if (gh) {
    const incoming = gh.incoming.filter((p) => !p.isDraft).length;
    if (incoming) chip({ id: 'prs-incoming', text: `${plural(incoming, 'PR')} await your review`, tone: 'amber', target: 'prs' });
    const mine = gh.mine.filter((p) => p.reviewDecision === 'CHANGES_REQUESTED' || p.ci === 'FAILURE' || p.ci === 'ERROR').length;
    if (mine) chip({ id: 'prs-mine', text: `${mine} of your PRs need${mine === 1 ? 's' : ''} changes`, tone: 'amber', target: 'prs' });
  }

  const cm = states.codemagic.snapshot;
  if (cm) {
    const all = cm.apps.flatMap((app) => app.builds.map((b) => ({ app, b })));
    const failed = all.filter(({ b }) => isBuildFailed(b.status) && b.finishedAt && now - Date.parse(b.finishedAt) < DAY_MS);
    if (failed.length) {
      const one = failed.length === 1 ? failed[0] : null;
      chip({ id: 'builds-failed', text: `${plural(failed.length, 'build')} failed`, detail: one ? `${one.app.name} · ${one.b.workflowName}` : null, tone: 'red', target: 'builds' });
    }
    const running = all.filter(({ b }) => isBuildRunning(b.status)).length;
    if (running) chip({ id: 'builds-running', text: `${running} building`, tone: 'grey', target: 'builds', pulse: true });
  }

  const lark = states.lark.snapshot;
  if (lark) {
    const [openStatus, checkingStatus] = config.showIssueStatuses;
    const open = lark.issues.groups.find((g) => g.status === openStatus);
    if (open && open.records.length) {
      const oldest = Math.max(...open.records.map((r) => parseDays(r.fields.hoursSince ?? '') ?? 0));
      chip({ id: 'issues-open', text: `${plural(open.records.length, 'open issue')}`, detail: oldest > 0 ? `oldest ${oldest} d` : null, tone: 'amber', target: 'issues' });
    }
    const checking = lark.issues.groups.find((g) => g.status === checkingStatus);
    if (checking && checking.records.length) chip({ id: 'issues-checking', text: `${checking.records.length} checking`, tone: 'grey', target: 'issues' });
    const pending = lark.tasks.groups.find((g) => g.status === config.pendingLaunchStatus);
    if (pending && pending.records.length) chip({ id: 'tasks-pending', text: `${pending.records.length} pending to launch`, tone: 'blue', target: 'tasks' });
  }

  const asc = states.appstore.snapshot;
  if (asc) {
    for (const app of asc.apps) {
      const v = app.inflight && APPSTORE_ATTENTION_STATES.has(app.inflight.state) ? app.inflight : null;
      if (!v) continue;
      chip({ id: `ios-${app.account}-${app.appId}`, text: `${app.name} iOS`, detail: humanState(v.state), tone: APPSTORE_REJECTED_STATES.has(v.state) ? 'red' : 'amber', target: 'stores' });
    }
  }

  const play = states.playstore.snapshot;
  if (play) {
    for (const app of play.apps) {
      for (const r of app.releases) {
        if (!PLAY_ATTENTION_STATUSES.has(r.status)) continue;
        const detail = r.status === 'halted' ? `${r.track} halted` : `${r.track} ${Math.round((r.userFraction ?? 0) * 100)}% rollout`;
        chip({ id: `android-${app.account}-${app.packageName}-${r.track}`, text: `${app.name} Android`, detail, tone: r.status === 'halted' ? 'red' : 'blue', target: 'stores' });
      }
    }
  }

  return chips;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test shared/attention.test.ts` → Expected: 6 pass. `bun run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add shared/attention.ts shared/attention.test.ts
git commit -m "feat(shared): needs-attention chip rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Web scaffold, state, API client and panel chrome

**Files:**
- Create: `bunfig.toml`, `web/index.html`, `web/vite.config.ts`, `web/test/setup.ts`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/api.ts`, `web/src/state.ts`, `web/src/state.test.ts`, `web/src/time.ts`, `web/src/time.test.ts`, `web/src/freshness.ts`, `web/src/freshness.test.ts`, `web/src/icons.tsx`, `web/src/panels/Panel.tsx`

**Interfaces:**
- Consumes: `StateResponse`, `SseMessage`, `Event`, `SourceStates`, `SourceState`, `PublicConfig`, `PanelId`, `SourceId` (Task 1); `emptyStates` (Task 13).
- Produces: `state.ts`: `DashboardState`, `Action`, `initialState`, `reducer`, `panelForEvent(e): PanelId | null`, `unreadByPanel(events): Record<PanelId, Event[]>`, `unreadItems(events, panel): Map<string, number[]>` (itemId → event ids). `api.ts`: `fetchState()`, `openEvents(onMessage, onStatus): () => void`, `markSeen(body)`, `refreshSource(id)`, `triggerBuild(input)`, `artifactUrl(buildId, index)`. `time.ts`: `relativeTime(when, now)`, `formatDuration(sec)`, `formatClock(ms)`, `formatDay(ms)`. `freshness.ts`: `freshness(state, intervalSec, now): { tone; label }`. `Panel.tsx`: `<Panel id title count unread state intervalSec now onRefresh onMarkAllSeen openUrl headerRight>children</Panel>`. `icons.tsx`: `IconLogo, IconRefresh, IconSettings, IconExternal, IconPlay, IconDownload, IconChevronRight, IconChevronDown, IconClose, IconCheck`, each `({ size?: number })`.

- [ ] **Step 1: Test setup for components**

`bunfig.toml`:

```toml
[test]
preload = ["./web/test/setup.ts"]
```

`web/test/setup.ts`:

```ts
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Server tests share this preload. Happy DOM would also replace Bun's fetch family with its own
// implementation; keep the native ones so server tests (Response.json, streamed bodies) still run against Bun.
if (typeof document === 'undefined') {
  const native = { fetch, Response, Request, Headers, URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder, ReadableStream, WritableStream, TransformStream, Blob };
  GlobalRegistrator.register();
  Object.assign(globalThis, native);
}
```

Run `bun test` → everything from Tasks 1–13 still passes.

- [ ] **Step 2: Vite config and HTML shell**

`web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:6600', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Write the failing tests for time, freshness and state**

`web/src/time.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { formatClock, formatDay, formatDuration, relativeTime } from './time';

const NOW = Date.parse('2026-09-17T01:41:00Z');

test('relativeTime picks the largest sensible unit', () => {
  expect(relativeTime(NOW - 20_000, NOW)).toBe('just now');
  expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 min');
  expect(relativeTime('2026-09-16T23:41:00Z', NOW)).toBe('2 h');
  expect(relativeTime(NOW - 3 * 86_400_000, NOW)).toBe('3 d');
  expect(relativeTime(null, NOW)).toBe('never');
});

test('formatDuration', () => {
  expect(formatDuration(45)).toBe('45 s');
  expect(formatDuration(18 * 60 + 12)).toBe('18 min');
  expect(formatDuration(3720)).toBe('1 h 02 min');
  expect(formatDuration(null)).toBe('');
});

test('formatClock and formatDay use local time', () => {
  const d = new Date(2026, 8, 17, 9, 41).getTime();
  expect(formatClock(d)).toBe('09:41');
  expect(formatDay(d)).toBe('Thu 17 Sep · 09:41');
});
```

`web/src/freshness.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { freshness } from './freshness';

const NOW = 1_000_000_000;
const base = { snapshot: null, fetchedAt: null, error: null, errorAt: null, disabled: null };

test('freshness tones', () => {
  expect(freshness({ ...base, disabled: 'no token' }, 60, NOW)).toEqual({ tone: 'grey', label: 'off' });
  expect(freshness(base, 60, NOW)).toEqual({ tone: 'grey', label: 'waiting' });
  expect(freshness({ ...base, fetchedAt: NOW - 30_000 }, 60, NOW)).toEqual({ tone: 'green', label: '30 s' });
  expect(freshness({ ...base, fetchedAt: NOW - 5 * 60_000 }, 60, NOW)).toEqual({ tone: 'amber', label: 'stale 5 min' });
  expect(freshness({ ...base, fetchedAt: NOW - 30_000, error: 'boom', errorAt: NOW }, 60, NOW)).toEqual({ tone: 'red', label: 'error' });
});
```

`web/src/state.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { initialState, panelForEvent, reducer, unreadByPanel, unreadItems } from './state';
import type { Event, StateResponse } from '../../shared/types';
import { emptyStates } from '../../shared/attention';

const ev = (id: number, kind: string, itemId = `i${id}`): Event => ({ id, source: 'github', kind, priority: 'high', itemId, title: 't', url: null, createdAt: id, seen: false });
const loaded: StateResponse = {
  states: emptyStates(),
  events: [ev(1, 'pr.review_requested')],
  config: { intervals: { github: 60, codemagic: 120, lark: 120, appstore: 600, playstore: 600 }, larkDomain: 'd', accounts: [], pendingLaunchStatus: 'P', collapsedStatuses: [], showIssueStatuses: ['OPEN', 'CHECKING'] },
};

describe('reducer', () => {
  test('loaded replaces states, events and config', () => {
    const s = reducer(initialState, { type: 'loaded', payload: loaded });
    expect(s.loaded).toBe(true);
    expect(s.events).toHaveLength(1);
    expect(s.config?.larkDomain).toBe('d');
  });

  test('sse patches one source, appends new events and keeps the disabled flag', () => {
    const start = reducer(initialState, { type: 'loaded', payload: { ...loaded, states: { ...loaded.states, github: { ...loaded.states.github, disabled: 'x' } } } });
    const s = reducer(start, { type: 'sse', now: 5, payload: { source: 'github', state: { snapshot: { login: 'j', incoming: [], mine: [] }, fetchedAt: 4, error: null, errorAt: null, disabled: null }, events: [ev(1, 'pr.review_requested'), ev(2, 'pr.ci_failed')] } });
    expect(s.states.github.fetchedAt).toBe(4);
    expect(s.states.github.disabled).toBe('x');
    expect(s.events.map((e) => e.id)).toEqual([1, 2]);
    expect(s.lastMessageAt).toBe(5);
  });

  test('seen and seenSource drop events', () => {
    const start = reducer(initialState, { type: 'loaded', payload: { ...loaded, events: [ev(1, 'a'), ev(2, 'b'), { ...ev(3, 'c'), source: 'lark' }] } });
    expect(reducer(start, { type: 'seen', ids: [1] }).events.map((e) => e.id)).toEqual([2, 3]);
    expect(reducer(start, { type: 'seenSource', source: 'github' }).events.map((e) => e.id)).toEqual([3]);
  });
});

describe('unread helpers', () => {
  test('panelForEvent maps kinds to panels', () => {
    expect(panelForEvent(ev(1, 'pr.review_requested'))).toBe('prs');
    expect(panelForEvent(ev(1, 'build.failed'))).toBe('builds');
    expect(panelForEvent(ev(1, 'issue.opened'))).toBe('issues');
    expect(panelForEvent(ev(1, 'feedback.new'))).toBe('feedback');
    expect(panelForEvent(ev(1, 'store.state_changed'))).toBe('stores');
    expect(panelForEvent(ev(1, 'weird'))).toBeNull();
  });
  test('unreadByPanel and unreadItems', () => {
    const events = [ev(1, 'pr.review_requested', 'a'), ev(2, 'pr.ci_failed', 'a'), ev(3, 'build.failed', 'b')];
    expect(unreadByPanel(events).prs.map((e) => e.id)).toEqual([1, 2]);
    expect(unreadByPanel(events).tasks).toEqual([]);
    expect([...unreadItems(events, 'prs').entries()]).toEqual([['a', [1, 2]]]);
  });
});
```

Run: `bun test web/src` → Expected: FAIL, modules not found.

- [ ] **Step 4: Write time.ts, freshness.ts, state.ts**

`web/src/time.ts`:

```ts
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeTime(when: string | number | null, now: number): string {
  if (when == null || when === '') return 'never';
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, now - t);
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h`;
  return `${Math.floor(diff / DAY)} d`;
}

export function formatDuration(sec: number | null): string {
  if (sec == null) return '';
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const formatClock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export function formatDay(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short' });
  const month = d.toLocaleDateString('en-GB', { month: 'short' });
  return `${day} ${d.getDate()} ${month} · ${formatClock(ms)}`;
}
```

`web/src/freshness.ts`:

```ts
import type { SourceState, Tone } from '../../shared/types';
import { relativeTime } from './time';

export type FreshTone = Tone | 'green';

/** Header dot and panel label: green within 2× the interval, amber when older, red on error, grey when off or not yet fetched (spec §4.1). */
export function freshness(state: SourceState, intervalSec: number, now: number): { tone: FreshTone; label: string } {
  if (state.disabled) return { tone: 'grey', label: 'off' };
  if (state.error) return { tone: 'red', label: 'error' };
  if (state.fetchedAt == null) return { tone: 'grey', label: 'waiting' };
  const age = now - state.fetchedAt;
  if (age > 2 * intervalSec * 1000) return { tone: 'amber', label: `stale ${relativeTime(state.fetchedAt, now)}` };
  return { tone: 'green', label: age < 60_000 ? `${Math.floor(age / 1000)} s` : relativeTime(state.fetchedAt, now) };
}
```

`web/src/state.ts`:

```ts
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
      const { source, state: incoming, events } = action.payload;
      const prev = state.states[source];
      return {
        ...state,
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
```

Run: `bun test web/src` → Expected: all pass (time 3, freshness 1, state 5).

- [ ] **Step 5: Write api.ts**

`web/src/api.ts`:

```ts
import type { SourceId, SseMessage, StateResponse } from '../../shared/types';

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
  await fetch('/api/events/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export async function refreshSource(id: SourceId): Promise<void> {
  await json(await fetch(`/api/sources/${id}/refresh`, { method: 'POST' }));
}

export async function triggerBuild(input: { appId: string; workflowId: string; branch: string }): Promise<{ buildId: string }> {
  return json<{ buildId: string }>(await fetch('/api/codemagic/builds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
}

export const artifactUrl = (buildId: string, index: number): string => `/api/codemagic/artifacts/${encodeURIComponent(buildId)}/${index}`;
```

- [ ] **Step 6: Write icons.tsx**

`web/src/icons.tsx` (stroke SVGs from the mockup; every icon takes `size`, defaults 16):

```tsx
import type { ReactNode } from 'react';

interface P { size?: number }
const Svg = ({ size = 16, children, fill = 'none' }: P & { children: ReactNode; fill?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconLogo = ({ size = 22 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="11" width="8" height="10" rx="1.5" /><rect x="3" y="14" width="8" height="7" rx="1.5" />
  </svg>
);
export const IconRefresh = (p: P) => <Svg {...p}><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></Svg>;
export const IconSettings = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Svg>
);
export const IconExternal = (p: P) => <Svg {...p}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" /></Svg>;
export const IconPlay = (p: P) => <Svg {...p} fill="currentColor"><path d="M7 4v16l13-8z" stroke="none" /></Svg>;
export const IconDownload = (p: P) => <Svg {...p}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></Svg>;
export const IconChevronRight = (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
export const IconChevronDown = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="m5 12 5 5L20 7" /></Svg>;
```

- [ ] **Step 7: Write styles.css (tokens and class set from spec §4.5 and the mockup)**

`web/src/styles.css`:

```css
:root {
  --bg: #f3f4f6; --surface: #ffffff; --surface2: #f7f8fa; --border: #e2e5ea; --border2: #eceef2;
  --text: #171b22; --muted: #6a7383; --faint: #98a0ad;
  --accent: #3557d6; --accent-soft: #e8edfb;
  --green: #1f9d55; --green-soft: #e3f5ea; --amber: #c9720a; --amber-soft: #fdf0dc;
  --red: #d63b3b; --red-soft: #fce8e8; --blue: #2f6fed; --blue-soft: #e6eefc; --grey-soft: #eef0f3;
  --row-py: 10px; --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg: #0e1013; --surface: #16191f; --surface2: #1b1f26; --border: #272c36; --border2: #21252e;
  --text: #e7e9ee; --muted: #9aa3b2; --faint: #6c7584;
  --accent: #8aa0f7; --accent-soft: #1d2540;
  --green: #3fbf75; --green-soft: #12301f; --amber: #e39a3a; --amber-soft: #332612;
  --red: #ef6b6b; --red-soft: #3a1717; --blue: #6f9cf7; --blue-soft: #172440; --grey-soft: #232833;
  --shadow: none;
  color-scheme: dark;
}
:root[data-density="compact"] { --row-py: 5px; }

html { font-size: 16px; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif; line-height: 1.4; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.mono { font-family: "IBM Plex Mono", Consolas, "Courier New", monospace; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }

.header { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 56px; padding: 0 24px; background: var(--surface); border-bottom: 1px solid var(--border); }
.header-left, .header-mid, .header-right { display: flex; align-items: center; gap: 12px; }
.header-mid { gap: 20px; }
.brand { font-weight: 600; font-size: 1rem; }
.fresh { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8125rem; color: var(--muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.dot.green { background: var(--green); } .dot.amber { background: var(--amber); } .dot.red { background: var(--red); } .dot.grey { background: var(--faint); } .dot.blue { background: var(--blue); }
.pulse { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

.strip { display: flex; align-items: center; gap: 10px; padding: 14px 24px 6px; overflow-x: auto; }
.strip-label { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em; color: var(--muted); margin-right: 6px; white-space: nowrap; }
.chip { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: 6px; font-size: 0.8125rem; font-weight: 500; white-space: nowrap; color: var(--text); background: var(--grey-soft); }
.chip.red { background: var(--red-soft); } .chip.amber { background: var(--amber-soft); } .chip.blue { background: var(--blue-soft); }
.chip .mono { font-weight: 400; color: var(--muted); }
.chip:hover { filter: brightness(0.97); }

.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; padding: 14px 24px 32px; align-items: start; }
@media (max-width: 1199px) { .grid { grid-template-columns: minmax(0, 1fr); } }

.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow); display: flex; flex-direction: column; min-width: 0; scroll-margin-top: 70px; }
.panel-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border2); }
.panel-h h2 { margin: 0; font-size: 0.9375rem; font-weight: 600; letter-spacing: 0.01em; }
.panel-h-left, .panel-h-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
.count { font-size: 0.75rem; color: var(--muted); background: var(--grey-soft); border-radius: 999px; padding: 1px 8px; font-weight: 500; white-space: nowrap; }
.unread { font-size: 0.6875rem; color: #fff; background: var(--accent); border-radius: 999px; padding: 1px 6px; font-weight: 600; min-width: 10px; text-align: center; }
.iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); }
.iconbtn:hover { color: var(--text); background: var(--surface2); }
.iconbtn.sm { width: 26px; height: 26px; border-color: transparent; }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 6px; font-size: 0.8125rem; font-weight: 500; border: 1px solid var(--border); background: var(--surface); color: var(--text); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn:disabled { opacity: 0.5; cursor: default; }
.stale { display: flex; gap: 8px; align-items: center; padding: 6px 16px; font-size: 0.75rem; color: var(--amber); background: var(--amber-soft); border-bottom: 1px solid var(--border2); }
.stale.red { color: var(--red); background: var(--red-soft); }
.note { padding: 16px; font-size: 0.875rem; color: var(--muted); }

.tabs { display: flex; gap: 4px; padding: 10px 16px 0; }
.tab { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 6px; font-size: 0.8125rem; color: var(--muted); }
.tab.on { background: var(--grey-soft); color: var(--text); font-weight: 500; }

.rows { display: flex; flex-direction: column; }
.row { display: flex; align-items: center; gap: 12px; padding: var(--row-py) 16px; border-bottom: 1px solid var(--border2); font-size: 0.875rem; min-width: 0; text-align: left; width: 100%; box-sizing: border-box; }
.row:last-child { border-bottom: 0; }
.row.new { background: var(--surface2); }
.row.click { cursor: pointer; }
.row.click:hover { background: var(--surface2); }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.newdot, .nodot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.newdot { background: var(--accent); }
.tag { display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 7px; border-radius: 4px; font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; }
.tag.high, .tag.warn { background: var(--amber-soft); color: var(--amber); }
.tag.normal, .tag.run { background: var(--blue-soft); color: var(--blue); }
.tag.feature, .tag.ok { background: var(--green-soft); color: var(--green); }
.tag.chore, .tag.plain { background: var(--grey-soft); color: var(--muted); }
.tag.qe { background: var(--accent-soft); color: var(--accent); }
.tag.fail { background: var(--red-soft); color: var(--red); }
.meta { font-size: 0.75rem; color: var(--muted); white-space: nowrap; }
.meta.clip { overflow: hidden; text-overflow: ellipsis; }
.group { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: var(--surface2); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; color: var(--muted); border-bottom: 1px solid var(--border2); width: 100%; box-sizing: border-box; text-align: left; }
.group .right { margin-left: auto; font-weight: 400; letter-spacing: 0; }
.avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex: none; background: var(--grey-soft); }
.bar { width: 72px; height: 6px; border-radius: 3px; background: var(--grey-soft); overflow: hidden; flex: none; }
.bar i { display: block; height: 100%; background: var(--green); }
.cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ver { display: flex; align-items: center; gap: 8px; font-size: 0.8125rem; flex-wrap: wrap; }
.stores { display: grid; grid-template-columns: 180px minmax(0, 1fr) minmax(0, 1fr); gap: 0 16px; padding: var(--row-py) 16px; border-bottom: 1px solid var(--border2); align-items: start; font-size: 0.875rem; }
.stores:last-child { border-bottom: 0; }
.sub { font-size: 0.75rem; color: var(--muted); }
.sub.head { font-weight: 600; letter-spacing: 0.04em; }

.backdrop { position: fixed; inset: 0; background: rgba(23, 27, 34, 0.45); z-index: 20; display: flex; }
.drawer { margin-left: auto; width: 400px; max-width: 100vw; height: 100%; background: var(--surface); border-left: 1px solid var(--border); box-shadow: -8px 0 24px rgba(16, 24, 40, 0.06); display: flex; flex-direction: column; overflow-y: auto; }
.drawer-h { display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 20px; border-bottom: 1px solid var(--border2); font-weight: 600; font-size: 1rem; flex: none; }
.drawer-body { display: flex; flex-direction: column; gap: 28px; padding: 20px; }
.section { display: flex; flex-direction: column; gap: 10px; }
.h { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em; color: var(--muted); }
.radio { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; text-align: left; width: 100%; box-sizing: border-box; }
.radio.on { border-color: var(--accent); background: var(--accent-soft); }
.rd { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--faint); flex: none; margin-top: 2px; box-sizing: border-box; }
.radio.on .rd { border: 5px solid var(--accent); }
.radio-title { font-size: 0.9375rem; font-weight: 500; }
.radio-desc { font-size: 0.8125rem; color: var(--muted); }
.seg { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.seg button { flex: 1; text-align: center; padding: 8px 0; font-size: 0.875rem; color: var(--muted); border-right: 1px solid var(--border); }
.seg button:last-child { border-right: 0; }
.seg button.on { background: var(--grey-soft); color: var(--text); font-weight: 500; }
.field { display: flex; flex-direction: column; gap: 6px; }
.lbl { font-size: 0.8125rem; font-weight: 500; }
.field select, .field input { height: 36px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; font-size: 0.875rem; }
.hint { font-size: 0.75rem; color: var(--faint); }
.dlg { margin: auto; width: 440px; max-width: calc(100vw - 32px); background: var(--surface); border-radius: 10px; box-shadow: 0 16px 48px rgba(16, 24, 40, 0.24); display: flex; flex-direction: column; }
.dlg-h { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border2); font-weight: 600; font-size: 1rem; }
.dlg-body { display: flex; flex-direction: column; gap: 14px; padding: 18px 20px; }
.dlg-f { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--border2); background: var(--surface2); border-radius: 0 0 10px 10px; }
.error { font-size: 0.8125rem; color: var(--red); }
.ok { font-size: 0.8125rem; color: var(--green); display: inline-flex; align-items: center; gap: 6px; }
```

- [ ] **Step 8: Write Panel.tsx**

`web/src/panels/Panel.tsx`:

```tsx
import type { ReactNode } from 'react';
import type { PanelId, SourceState } from '../../../shared/types';
import { freshness } from '../freshness';
import { IconExternal, IconRefresh } from '../icons';
import { formatClock } from '../time';

export interface PanelProps {
  id: PanelId;
  title: string;
  count?: ReactNode;
  unread: number;
  /** One state per backing source; the panel shows the worst freshness. */
  state: SourceState | SourceState[];
  intervalSec: number;
  now: number;
  onRefresh?: () => void;
  onMarkAllSeen?: () => void;
  openUrl?: string;
  headerRight?: ReactNode;
  children: ReactNode;
}

export function Panel(props: PanelProps) {
  const states = Array.isArray(props.state) ? props.state : [props.state];
  const disabled = states.every((s) => s.disabled) ? states.map((s) => s.disabled).filter(Boolean).join('; ') : null;
  const errored = states.find((s) => s.error);
  const fresh = states.map((s) => freshness(s, props.intervalSec, props.now)).sort((a, b) => rank(b.tone) - rank(a.tone))[0]!;
  return (
    <section className="panel" id={props.id} aria-labelledby={`${props.id}-title`}>
      <div className="panel-h">
        <div className="panel-h-left">
          <h2 id={`${props.id}-title`}>{props.title}</h2>
          {props.count != null && <span className="count">{props.count}</span>}
          {props.unread > 0 && (
            <button className="unread" title="Mark all seen" onClick={props.onMarkAllSeen}>{props.unread}</button>
          )}
        </div>
        <div className="panel-h-right">
          {props.headerRight}
          <span className={`meta mono ${fresh.tone === 'amber' ? 'amber' : ''}`} style={fresh.tone === 'amber' ? { color: 'var(--amber)' } : undefined}>{fresh.label}</span>
          {props.onRefresh && !disabled && (
            <button className="iconbtn sm" title="Refresh" onClick={props.onRefresh}><IconRefresh size={14} /></button>
          )}
          {props.openUrl && (
            <a className="iconbtn sm" href={props.openUrl} target="_blank" rel="noreferrer" title="Open in source"><IconExternal size={14} /></a>
          )}
        </div>
      </div>
      {errored && !disabled && (
        <div className={`stale ${errored.fetchedAt == null ? 'red' : ''}`}>
          {errored.fetchedAt == null ? 'No data yet' : `Stale since ${formatClock(errored.fetchedAt)}`} · {errored.error}
        </div>
      )}
      {disabled ? <div className="note">Off: {disabled}</div> : props.children}
    </section>
  );
}

const rank = (t: string) => ({ red: 3, amber: 2, grey: 1, green: 0 })[t] ?? 0;
```

- [ ] **Step 9: Write App.tsx and main.tsx (header + six panel shells)**

`web/src/App.tsx`:

```tsx
import { useEffect, useReducer, useRef, useState } from 'react';
import { SOURCE_IDS } from '../../shared/types';
import type { PanelId, SourceId } from '../../shared/types';
import { fetchState, markSeen, openEvents, refreshSource } from './api';
import { freshness } from './freshness';
import { IconLogo, IconRefresh, IconSettings } from './icons';
import { Panel } from './panels/Panel';
import { initialState, reducer, unreadByPanel } from './state';
import { formatDay } from './time';

const SOURCE_LABEL: Record<SourceId, string> = { github: 'GitHub', codemagic: 'Codemagic', lark: 'Lark', appstore: 'App Store', playstore: 'Play' };

export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function scrollToPanel(id: PanelId): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const now = useNow();
  const wasOffline = useRef(false);

  const load = () => fetchState().then((p) => dispatch({ type: 'loaded', payload: p })).catch((e: Error) => dispatch({ type: 'error', message: e.message }));

  useEffect(() => {
    void load();
    return openEvents(
      (m) => dispatch({ type: 'sse', payload: m, now: Date.now() }),
      (s) => {
        dispatch({ type: 'connection', status: s });
        if (s === 'live' && wasOffline.current) void load(); // reconnect: catch up on anything missed (spec §8)
        wasOffline.current = s === 'offline';
      },
    );
  }, []);

  const seeIds = (ids: number[]) => { if (ids.length) { dispatch({ type: 'seen', ids }); void markSeen({ ids }); } };
  const seeSource = (source: SourceId) => { dispatch({ type: 'seenSource', source }); void markSeen({ source }); };
  const intervals = state.config?.intervals ?? { github: 60, codemagic: 120, lark: 120, appstore: 600, playstore: 600 };
  const unread = unreadByPanel(state.events);

  return (
    <>
      <header className="header">
        <div className="header-left">
          <span style={{ color: 'var(--accent)', display: 'inline-flex' }}><IconLogo /></span>
          <span className="brand">Dashboard</span>
          <span className="mono muted" style={{ fontSize: '0.8125rem' }}>{formatDay(now)}</span>
          {state.connection !== 'live' && <span className="tag warn">{state.connection === 'offline' ? 'reconnecting…' : 'connecting…'}</span>}
        </div>
        <div className="header-mid">
          {SOURCE_IDS.map((id) => {
            const f = freshness(state.states[id], intervals[id], now);
            const s = state.states[id];
            return (
              <span key={id} className="fresh" title={s.error ?? s.disabled ?? (s.fetchedAt ? `last poll ${new Date(s.fetchedAt).toLocaleTimeString()}` : 'no data yet')}>
                <i className={`dot ${f.tone}`} />{SOURCE_LABEL[id]} <span className="mono faint">{f.label}</span>
              </span>
            );
          })}
        </div>
        <div className="header-right">
          <button className="iconbtn" title="Refresh all" onClick={() => SOURCE_IDS.forEach((id) => { if (!state.states[id].disabled) void refreshSource(id); })}><IconRefresh /></button>
          <button className="iconbtn" title="Settings" onClick={() => { /* Task 15 opens the drawer */ }}><IconSettings /></button>
        </div>
      </header>

      {state.error && <div className="stale red" role="alert">Could not load state: {state.error}</div>}

      <main className="grid">
        <Panel id="prs" title="Pull Requests" unread={unread.prs.length} state={state.states.github} intervalSec={intervals.github} now={now} onRefresh={() => void refreshSource('github')} onMarkAllSeen={() => seeSource('github')}>
          <div className="note">Pull requests arrive in Task 17.</div>
        </Panel>
        <Panel id="builds" title="Builds" unread={unread.builds.length} state={state.states.codemagic} intervalSec={intervals.codemagic} now={now} onRefresh={() => void refreshSource('codemagic')} onMarkAllSeen={() => seeSource('codemagic')}>
          <div className="note">Builds arrive in Task 17.</div>
        </Panel>
        <Panel id="tasks" title="Tasks" unread={0} state={state.states.lark} intervalSec={intervals.lark} now={now} onRefresh={() => void refreshSource('lark')}>
          <div className="note">Tasks arrive in Task 18.</div>
        </Panel>
        <Panel id="issues" title="Issues" unread={unread.issues.length} state={state.states.lark} intervalSec={intervals.lark} now={now} onRefresh={() => void refreshSource('lark')} onMarkAllSeen={() => seeIds(unread.issues.map((e) => e.id))}>
          <div className="note">Issues arrive in Task 18.</div>
        </Panel>
        <Panel id="feedback" title="Merchant Feedback" unread={unread.feedback.length} state={state.states.lark} intervalSec={intervals.lark} now={now} onRefresh={() => void refreshSource('lark')} onMarkAllSeen={() => seeIds(unread.feedback.map((e) => e.id))}>
          <div className="note">Feedback arrives in Task 18.</div>
        </Panel>
        <Panel id="stores" title="Stores" unread={unread.stores.length} state={[state.states.appstore, state.states.playstore]} intervalSec={intervals.appstore} now={now} onRefresh={() => { void refreshSource('appstore'); void refreshSource('playstore'); }} onMarkAllSeen={() => seeIds(unread.stores.map((e) => e.id))}>
          <div className="note">Stores arrive in Task 19.</div>
        </Panel>
      </main>
    </>
  );
}
```

`web/src/main.tsx`:

```tsx
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 10: Build, run, look**

```bash
bun run typecheck
bun run build
bun run start
```

Open `http://127.0.0.1:6600`. Expected: header with five freshness dots (GitHub green after its first poll, others grey/off with reasons on hover), the connecting tag disappears once SSE says hello, six panels with the interim notes; the GitHub panel's age label ticks. Alternatively `bun run dev` and open `http://127.0.0.1:5173` for hot reload (API proxied to 6600). Stop the servers.

- [ ] **Step 11: Commit**

```bash
bun test
git add bunfig.toml web/ 
git commit -m "feat(web): vite/react scaffold, state reducer, api client and panel chrome

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Settings drawer, appearance and alert modes

**Files:**
- Create: `web/src/settings/useSettings.ts`, `web/src/settings/useSettings.test.ts`, `web/src/settings/SettingsDrawer.tsx`, `web/src/notify.ts`, `web/src/notify.test.ts`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Produces: `Settings { alertMode: 'toast'|'badge'|'off'; theme: 'light'|'dark'|'auto'; fontSize: 'small'|'medium'|'large'; density: 'comfortable'|'compact' }`, `DEFAULT_SETTINGS`, `FONT_PX`, `loadSettings(storage)`, `saveSettings(storage, s)`, `resolveTheme(theme, prefersDark)`, `applyAppearance(root, settings, prefersDark)`, `useSettings(): [Settings, (patch) => void]`; `SettingsDrawer` props `{ open, onClose, settings, onChange, permission, onRequestPermission, config }`; `notify.ts`: `notifyHighEvents(events, mode, onClick, ctor?)`, `updateTitle(unread, mode)`, `requestPermission()`, `currentPermission()`.

- [ ] **Step 1: Write the failing tests**

`web/src/settings/useSettings.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, applyAppearance, loadSettings, resolveTheme, saveSettings } from './useSettings';

const memStorage = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

test('loadSettings falls back to defaults on garbage or missing storage', () => {
  expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  const s = memStorage();
  s.setItem('dashboard.settings', '{"alertMode":"loud","theme":"dark","fontSize":3}');
  expect(loadSettings(s)).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
});

test('saveSettings round-trips', () => {
  const s = memStorage();
  saveSettings(s, { ...DEFAULT_SETTINGS, density: 'compact' });
  expect(loadSettings(s).density).toBe('compact');
});

test('resolveTheme', () => {
  expect(resolveTheme('auto', true)).toBe('dark');
  expect(resolveTheme('auto', false)).toBe('light');
  expect(resolveTheme('light', true)).toBe('light');
});

test('applyAppearance stamps the root element', () => {
  const root = document.createElement('html');
  applyAppearance(root, { alertMode: 'off', theme: 'auto', fontSize: 'large', density: 'compact' }, true);
  expect(root.dataset.theme).toBe('dark');
  expect(root.dataset.density).toBe('compact');
  expect(root.style.fontSize).toBe('18px');
});
```

`web/src/notify.test.ts`:

```ts
import { expect, mock, test } from 'bun:test';
import { notifyHighEvents, updateTitle } from './notify';
import type { Event } from '../../shared/types';

const ev = (id: number, priority: 'high' | 'normal'): Event => ({ id, source: 'github', kind: 'pr.review_requested', priority, itemId: `i${id}`, title: `T${id}`, url: null, createdAt: 0, seen: false });

test('updateTitle shows the unread count unless alerts are off', () => {
  updateTitle(3, 'badge'); expect(document.title).toBe('(3) Dashboard');
  updateTitle(3, 'off'); expect(document.title).toBe('Dashboard');
  updateTitle(0, 'toast'); expect(document.title).toBe('Dashboard');
});

test('notifyHighEvents fires one notification per high event in toast mode only', () => {
  const created: string[] = [];
  class FakeNotification { static permission = 'granted'; onclick: (() => void) | null = null; constructor(title: string) { created.push(title); } close() {} }
  const onClick = mock(() => {});
  notifyHighEvents([ev(1, 'high'), ev(2, 'normal'), ev(3, 'high')], 'toast', onClick, FakeNotification as unknown as typeof Notification);
  expect(created).toEqual(['T1', 'T3']);
  created.length = 0;
  notifyHighEvents([ev(1, 'high')], 'badge', onClick, FakeNotification as unknown as typeof Notification);
  expect(created).toEqual([]);
  FakeNotification.permission = 'denied';
  notifyHighEvents([ev(1, 'high')], 'toast', onClick, FakeNotification as unknown as typeof Notification);
  expect(created).toEqual([]);
});
```

Run: `bun test web/src/settings web/src/notify.test.ts` → Expected: FAIL, modules not found.

- [ ] **Step 2: Write useSettings.ts**

```ts
import { useEffect, useState } from 'react';

export type AlertMode = 'toast' | 'badge' | 'off';
export type Theme = 'light' | 'dark' | 'auto';
export type FontSize = 'small' | 'medium' | 'large';
export type Density = 'comfortable' | 'compact';
export interface Settings { alertMode: AlertMode; theme: Theme; fontSize: FontSize; density: Density }

export const DEFAULT_SETTINGS: Settings = { alertMode: 'badge', theme: 'auto', fontSize: 'medium', density: 'comfortable' };
export const FONT_PX: Record<FontSize, number> = { small: 14, medium: 16, large: 18 };
const KEY = 'dashboard.settings';
const ALLOWED: { [K in keyof Settings]: readonly Settings[K][] } = {
  alertMode: ['toast', 'badge', 'off'], theme: ['light', 'dark', 'auto'], fontSize: ['small', 'medium', 'large'], density: ['comfortable', 'compact'],
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadSettings(storage: StorageLike | null): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!storage) return out;
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? '{}') as Record<string, unknown>;
    for (const key of Object.keys(ALLOWED) as (keyof Settings)[]) {
      const v = raw[key];
      if (typeof v === 'string' && (ALLOWED[key] as readonly string[]).includes(v)) (out as Record<string, string>)[key] = v;
    }
  } catch {
    /* corrupt storage: defaults */
  }
  return out;
}

export function saveSettings(storage: StorageLike | null, s: Settings): void {
  try { storage?.setItem(KEY, JSON.stringify(s)); } catch { /* private mode etc. */ }
}

export const resolveTheme = (theme: Theme, prefersDark: boolean): 'light' | 'dark' => (theme === 'auto' ? (prefersDark ? 'dark' : 'light') : theme);

export function applyAppearance(root: HTMLElement, s: Settings, prefersDark: boolean): void {
  root.dataset.theme = resolveTheme(s.theme, prefersDark);
  root.dataset.density = s.density;
  root.style.fontSize = `${FONT_PX[s.fontSize]}px`;
}

function safeStorage(): StorageLike | null {
  try { return window.localStorage; } catch { return null; }
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(() => loadSettings(safeStorage()));
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => applyAppearance(document.documentElement, settings, mq.matches);
    apply();
    saveSettings(safeStorage(), settings);
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);
  return [settings, (patch) => setSettings((s) => ({ ...s, ...patch }))];
}
```

- [ ] **Step 3: Write notify.ts**

```ts
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

export function updateTitle(unread: number, mode: AlertMode): void {
  document.title = mode === 'off' || unread === 0 ? 'Dashboard' : `(${unread}) Dashboard`;
}
```

Run: `bun test web/src/settings web/src/notify.test.ts` → Expected: 6 pass.

- [ ] **Step 4: Write SettingsDrawer.tsx**

```tsx
import type { PublicConfig } from '../../../shared/types';
import { IconCheck, IconClose } from '../icons';
import type { AlertMode, Density, FontSize, Settings, Theme } from './useSettings';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  permission: NotificationPermission | 'unsupported';
  onRequestPermission: () => void;
  config: PublicConfig | null;
}

const ALERTS: { value: AlertMode; title: string; desc: string }[] = [
  { value: 'toast', title: 'Windows toast', desc: 'Native notification for high-priority events: review requests, failed builds, new open issues, store rejections. Everything else badges.' },
  { value: 'badge', title: 'In-page badges only', desc: 'Unread counts on panels and in the tab title. No notifications.' },
  { value: 'off', title: 'Off', desc: 'Show current data only, no unread state.' },
];

function Seg<T extends string>({ value, options, onPick }: { value: T; options: { v: T; label: string }[]; onPick: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.v} role="radio" aria-checked={o.v === value} className={o.v === value ? 'on' : ''} onClick={() => onPick(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

export function SettingsDrawer({ open, onClose, settings, onChange, permission, onRequestPermission, config }: Props) {
  if (!open) return null;
  return (
    <div className="backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-h">Settings<button className="iconbtn" onClick={onClose} title="Close"><IconClose /></button></div>
        <div className="drawer-body">
          <div className="section">
            <span className="h">ALERTS</span>
            {ALERTS.map((a) => (
              <button key={a.value} className={`radio ${settings.alertMode === a.value ? 'on' : ''}`} onClick={() => onChange({ alertMode: a.value })}>
                <i className="rd" />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span className="radio-title">{a.title}</span>
                  <span className="radio-desc">{a.desc}</span>
                  {a.value === 'toast' && settings.alertMode === 'toast' && (
                    permission === 'granted' ? <span className="ok" style={{ marginTop: 6 }}><IconCheck size={12} />Notification permission granted</span>
                    : permission === 'unsupported' ? <span className="error" style={{ marginTop: 6 }}>This browser has no Notification API.</span>
                    : <span style={{ marginTop: 6 }}><span className="btn" role="button" onClick={(e) => { e.stopPropagation(); onRequestPermission(); }}>Grant permission</span></span>
                  )}
                </span>
              </button>
            ))}
          </div>

          <div className="section" style={{ gap: 18 }}>
            <span className="h">APPEARANCE</span>
            <div className="field">
              <span className="lbl">Theme</span>
              <Seg<Theme> value={settings.theme} options={[{ v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }, { v: 'auto', label: 'Auto' }]} onPick={(theme) => onChange({ theme })} />
              <span className="hint">Auto follows the Windows light/dark setting.</span>
            </div>
            <div className="field">
              <span className="lbl">Font size</span>
              <Seg<FontSize> value={settings.fontSize} options={[{ v: 'small', label: 'Small' }, { v: 'medium', label: 'Medium' }, { v: 'large', label: 'Large' }]} onPick={(fontSize) => onChange({ fontSize })} />
            </div>
            <div className="field">
              <span className="lbl">Density</span>
              <Seg<Density> value={settings.density} options={[{ v: 'comfortable', label: 'Comfortable' }, { v: 'compact', label: 'Compact' }]} onPick={(density) => onChange({ density })} />
            </div>
          </div>

          <div className="section">
            <span className="h">SOURCES</span>
            {config && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.8125rem', color: 'var(--muted)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>GitHub</span><span className="mono">every {config.intervals.github} s</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Codemagic</span><span className="mono">{config.intervals.codemagic} s · 30 s while building</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Lark Base · 3 views</span><span className="mono">every {config.intervals.lark} s</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>App Store · Play · {config.accounts.length} accounts</span><span className="mono">every {config.intervals.appstore} s</span></div>
              </div>
            )}
            <span className="hint">Intervals and keys are set in config/dashboard.config.json.</span>
          </div>
        </div>
      </aside>
    </div>
  );
}
```

- [ ] **Step 5: Wire settings, notifications and the title badge into App.tsx**

In `App.tsx` add imports and state:

```tsx
import { currentPermission, notifyHighEvents, requestPermission, updateTitle } from './notify';
import { SettingsDrawer } from './settings/SettingsDrawer';
import { useSettings } from './settings/useSettings';
// inside App():
  const [settings, patchSettings] = useSettings();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [permission, setPermission] = useState(currentPermission());
  const seenEventIds = useRef(new Set<number>());

  useEffect(() => { updateTitle(state.events.length, settings.alertMode); }, [state.events.length, settings.alertMode]);

  // Toasts fire once per event, only for events that arrived over SSE after load.
  useEffect(() => {
    if (!state.loaded) return;
    const fresh = state.events.filter((e) => !seenEventIds.current.has(e.id));
    for (const e of state.events) seenEventIds.current.add(e.id);
    if (state.lastMessageAt == null) return; // initial load: badges only, no toast flood
    notifyHighEvents(fresh, settings.alertMode, (e) => {
      const panel = panelForEvent(e);
      if (panel) scrollToPanel(panel);
      seeIds([e.id]);
    });
  }, [state.events, state.loaded, state.lastMessageAt, settings.alertMode]);
```

Import `panelForEvent` from `./state`. Replace the settings button's `onClick` with `() => setDrawerOpen(true)` and render, after `</main>`:

```tsx
      <SettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} settings={settings} onChange={patchSettings} permission={permission}
        onRequestPermission={() => void requestPermission().then(setPermission)} config={state.config} />
```

Alert mode `off` must hide unread state (spec §6): compute `const showUnread = settings.alertMode !== 'off';` and pass `unread={showUnread ? unread.prs.length : 0}` (and likewise for each panel).

- [ ] **Step 6: Verify in the browser**

`bun run build && bun run start`, open the page: gear opens the drawer; Theme Dark flips colours instantly; Font size Large scales everything; Density Compact tightens rows; reload keeps all three. In Toast mode, "Grant permission" shows the browser prompt; after granting, the green check appears. Tab title reads `(N) Dashboard` when there are unseen events and plain `Dashboard` with alerts Off.

- [ ] **Step 7: Commit**

```bash
bun test && bun run typecheck
git add web/src
git commit -m "feat(web): settings drawer with alert mode and appearance, native notifications

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: Needs-attention strip

**Files:**
- Create: `web/src/panels/ActionStrip.tsx`, `web/src/panels/ActionStrip.test.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `computeAttention` (Task 13), `AttentionChip`, `PanelId`.
- Produces: `<ActionStrip chips onNavigate />`.

- [ ] **Step 1: Write the failing component test**

`web/src/panels/ActionStrip.test.tsx`:

```tsx
import { expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ActionStrip } from './ActionStrip';
import type { AttentionChip } from '../../../shared/types';

const chips: AttentionChip[] = [
  { id: 'builds-failed', text: '1 build failed', detail: 'SGPOS · ios-release', tone: 'red', target: 'builds', pulse: false },
  { id: 'builds-running', text: '1 building', detail: null, tone: 'grey', target: 'builds', pulse: true },
];

test('renders chips with detail and navigates on click', () => {
  const onNavigate = mock(() => {});
  render(<ActionStrip chips={chips} onNavigate={onNavigate} />);
  expect(screen.getByText('1 build failed')).toBeTruthy();
  expect(screen.getByText('SGPOS · ios-release')).toBeTruthy();
  fireEvent.click(screen.getByText('1 build failed'));
  expect(onNavigate).toHaveBeenCalledWith('builds');
  cleanup();
});

test('empty state', () => {
  render(<ActionStrip chips={[]} onNavigate={() => {}} />);
  expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
  cleanup();
});
```

Run: `bun test web/src/panels/ActionStrip.test.tsx` → Expected: FAIL, module not found.

- [ ] **Step 2: Write ActionStrip.tsx**

```tsx
import type { AttentionChip, PanelId } from '../../../shared/types';

export function ActionStrip({ chips, onNavigate }: { chips: AttentionChip[]; onNavigate: (panel: PanelId) => void }) {
  return (
    <section className="strip" aria-label="Needs attention">
      <span className="strip-label">NEEDS ATTENTION</span>
      {chips.length === 0 && <span className="meta">Nothing needs you right now.</span>}
      {chips.map((c) => (
        <button key={c.id} className={`chip ${c.tone}`} onClick={() => onNavigate(c.target)}>
          <i className={`dot ${c.tone === 'grey' && c.pulse ? 'blue' : c.tone} ${c.pulse ? 'pulse' : ''}`} />
          {c.text}
          {c.detail && <span className="mono">{c.detail}</span>}
        </button>
      ))}
    </section>
  );
}
```

Run the test → 2 pass.

- [ ] **Step 3: Mount it in App.tsx**

```tsx
import { computeAttention } from '../../shared/attention';
import { ActionStrip } from './panels/ActionStrip';
// inside App(), after `unread`:
  const chips = state.config ? computeAttention(state.states, state.config, now) : [];
// in JSX, between the header and <main>:
      <ActionStrip chips={chips} onNavigate={scrollToPanel} />
```

- [ ] **Step 4: Verify and commit**

`bun run build && bun run start`: with real GitHub data the strip shows "N PRs await your review" if any; clicking scrolls to the Pull Requests panel.

```bash
bun test && bun run typecheck
git add web/src
git commit -m "feat(web): needs-attention strip

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: Pull Requests and Builds panels with the Start-build dialog

**Files:**
- Create: `web/src/panels/PullRequests.tsx`, `web/src/panels/Builds.tsx`, `web/src/panels/Builds.test.ts`, `web/src/panels/StartBuildDialog.tsx`, `web/src/panels/open.ts`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `unreadItems` (Task 14), `relativeTime`, `formatDuration`, `artifactUrl`, `triggerBuild` (Task 14), `isBuildRunning`, `isBuildFailed` (Task 8), icons.
- Produces: `openItem(url, ids, onSee)` in `open.ts`; `<PullRequests snapshot events onSee now />`; `<Builds snapshot events onSee now />` plus `latestPerWorkflow(app): Build[]`; `<StartBuildDialog snapshot onClose onStarted />`.

- [ ] **Step 1: Write open.ts**

```ts
/** Row click: mark the row's unseen events seen, then open the item in a new tab. */
export function openItem(url: string | null, ids: number[], onSee: (ids: number[]) => void): void {
  if (ids.length) onSee(ids);
  if (url) window.open(url, '_blank', 'noopener');
}
```

- [ ] **Step 2: Write PullRequests.tsx**

```tsx
import { useState } from 'react';
import type { CiState, Event, GithubSnapshot, PullRequest } from '../../../shared/types';
import { unreadItems } from '../state';
import { relativeTime } from '../time';
import { openItem } from './open';

interface Props { snapshot: GithubSnapshot | null; events: Event[]; onSee: (ids: number[]) => void; now: number }

function DecisionTag({ pr }: { pr: PullRequest }) {
  if (pr.isDraft) return <span className="tag plain">Draft</span>;
  if (pr.reviewDecision === 'APPROVED') return <span className="tag ok">Approved</span>;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return <span className="tag fail">Changes requested</span>;
  return <span className="tag warn">Review required</span>;
}

function CiDot({ ci }: { ci: CiState }) {
  if (ci == null) return <i className="dot grey" title="No CI" />;
  if (ci === 'SUCCESS') return <i className="dot green" title="CI passing" />;
  if (ci === 'PENDING' || ci === 'EXPECTED') return <i className="dot blue pulse" title="CI running" />;
  return <i className="dot red" title="CI failing" />;
}

export function PullRequests({ snapshot, events, onSee, now }: Props) {
  const [tab, setTab] = useState<'incoming' | 'mine'>('incoming');
  if (!snapshot) return <div className="note">Waiting for the first GitHub poll…</div>;
  const unread = unreadItems(events, 'prs');
  const list = snapshot[tab];
  return (
    <>
      <div className="tabs" role="tablist">
        {(['incoming', 'mine'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {t === 'incoming' ? 'Review requested' : 'Mine'} <span className="count">{snapshot[t].length}</span>
          </button>
        ))}
      </div>
      <div className="rows" role="list" style={{ paddingTop: 6 }}>
        {list.length === 0 && <div className="note">{tab === 'incoming' ? 'No PRs waiting for your review.' : 'No open PRs of yours.'}</div>}
        {list.map((pr) => {
          const ids = unread.get(pr.id) ?? [];
          return (
            <button key={pr.id} role="listitem" className={`row click ${ids.length ? 'new' : ''}`} onClick={() => openItem(pr.url, ids, onSee)}>
              <i className={ids.length ? 'newdot' : 'nodot'} />
              {pr.authorAvatarUrl ? <img className="avatar" src={pr.authorAvatarUrl} alt="" /> : <span className="avatar" />}
              <span className="meta mono">{pr.repo.split('/')[1] ?? pr.repo} #{pr.number}</span>
              <span className="title" title={pr.title}>{pr.title}</span>
              <span className="meta">{pr.authorLogin} · {relativeTime(pr.createdAt, now)}</span>
              <CiDot ci={pr.ci} />
              <DecisionTag pr={pr} />
            </button>
          );
        })}
      </div>
    </>
  );
}
```

- [ ] **Step 3: Write the failing Builds helper test**

`web/src/panels/Builds.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { latestPerWorkflow, statusClass } from './Builds';
import type { Build, CodemagicApp } from '../../../shared/types';

const b = (id: string, workflowId: string, status: string): Build => ({ id, appId: 'a', workflowId, workflowName: workflowId, branch: 'main', status, startedAt: null, finishedAt: null, durationSec: null, startedBy: null, url: '', artifacts: [] });
const app: CodemagicApp = { id: 'a', name: 'A', workflows: [], builds: [b('1', 'ios', 'building'), b('2', 'android', 'finished'), b('3', 'ios', 'failed')] };

test('latestPerWorkflow keeps the first (newest) build of each workflow in order', () => {
  expect(latestPerWorkflow(app).map((x) => x.id)).toEqual(['1', '2']);
});

test('statusClass maps build statuses to tag classes', () => {
  expect(statusClass('building')).toBe('run');
  expect(statusClass('failed')).toBe('fail');
  expect(statusClass('timeout')).toBe('fail');
  expect(statusClass('finished')).toBe('ok');
  expect(statusClass('warning')).toBe('warn');
  expect(statusClass('canceled')).toBe('plain');
});
```

- [ ] **Step 4: Write Builds.tsx**

```tsx
import { useState } from 'react';
import { isBuildFailed, isBuildRunning } from '../../../shared/status';
import type { Build, CodemagicApp, CodemagicSnapshot, Event } from '../../../shared/types';
import { artifactUrl } from '../api';
import { IconDownload, IconExternal } from '../icons';
import { unreadItems } from '../state';
import { formatDuration, relativeTime } from '../time';
import { openItem } from './open';

interface Props { snapshot: CodemagicSnapshot | null; events: Event[]; onSee: (ids: number[]) => void; now: number }

export function latestPerWorkflow(app: CodemagicApp): Build[] {
  const seen = new Set<string>();
  return app.builds.filter((b) => (seen.has(b.workflowId) ? false : (seen.add(b.workflowId), true)));
}

export function statusClass(status: string): 'run' | 'fail' | 'ok' | 'warn' | 'plain' {
  if (isBuildRunning(status)) return 'run';
  if (isBuildFailed(status)) return 'fail';
  if (status === 'finished') return 'ok';
  if (status === 'warning') return 'warn';
  return 'plain';
}

function BuildRow({ app, b, ids, onSee, now }: { app: CodemagicApp; b: Build; ids: number[]; onSee: Props['onSee']; now: number }) {
  const cls = statusClass(b.status);
  return (
    <div className={`row click ${ids.length ? 'new' : ''}`} role="listitem" onClick={() => openItem(b.url, ids, onSee)}>
      <i className={ids.length ? 'newdot' : 'nodot'} />
      <span className={`tag ${cls}`}>{cls === 'run' && <i className="dot blue pulse" />}{b.status.toUpperCase()}</span>
      <span className="title"><span style={{ fontWeight: 500 }}>{b.workflowName}</span> <span className="meta mono">{b.branch}</span></span>
      {b.artifacts.map((a, i) => (
        <a key={a.url} className="meta" href={artifactUrl(b.id, i)} onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)' }} title={`Download ${a.name}`}>
          <IconDownload size={12} />{a.name}{a.size != null && ` · ${Math.round(a.size / 1_048_576)} MB`}
        </a>
      ))}
      <span className="meta">
        {b.startedAt ? (isBuildRunning(b.status) ? `started ${relativeTime(b.startedAt, now)} ago` : `${relativeTime(b.finishedAt ?? b.startedAt, now)} ago`) : ''}
        {b.durationSec != null && ` · ${formatDuration(b.durationSec)}`}
        {b.startedBy && ` · ${b.startedBy}`}
      </span>
      <a className="iconbtn sm" href={b.url} target="_blank" rel="noreferrer" title={`Open in Codemagic (${app.name})`} onClick={(e) => e.stopPropagation()}><IconExternal size={14} /></a>
    </div>
  );
}

export function Builds({ snapshot, events, onSee, now }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!snapshot) return <div className="note">Waiting for the first Codemagic poll…</div>;
  if (snapshot.apps.length === 0) return <div className="note">No Codemagic apps visible to this token.</div>;
  const unread = unreadItems(events, 'builds');
  return (
    <div className="rows" role="list">
      {snapshot.apps.map((app) => {
        const all = expanded[app.id];
        const shown = all ? app.builds : latestPerWorkflow(app);
        return (
          <div key={app.id}>
            <div className="group">
              {app.name.toUpperCase()}
              {app.builds.length > shown.length || all ? (
                <button className="right" onClick={() => setExpanded((e) => ({ ...e, [app.id]: !all }))}>{all ? 'show latest per workflow' : `show all ${app.builds.length}`}</button>
              ) : null}
            </div>
            {shown.length === 0 && <div className="note">No builds yet.</div>}
            {shown.map((b) => <BuildRow key={b.id} app={app} b={b} ids={unread.get(b.id) ?? []} onSee={onSee} now={now} />)}
          </div>
        );
      })}
    </div>
  );
}
```

Run: `bun test web/src/panels/Builds.test.ts` → 2 pass.

- [ ] **Step 5: Write StartBuildDialog.tsx**

```tsx
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
```

- [ ] **Step 6: Mount both panels in App.tsx**

Replace the two interim notes:

```tsx
import { Builds } from './panels/Builds';
import { PullRequests } from './panels/PullRequests';
import { StartBuildDialog } from './panels/StartBuildDialog';
import { IconPlay } from './icons';
// state:
  const [buildDialog, setBuildDialog] = useState(false);
  const [buildNotice, setBuildNotice] = useState<string | null>(null);
  const onBuildStarted = (id: string) => { setBuildNotice(`Build ${id.slice(0, 8)} started`); setTimeout(() => setBuildNotice(null), 6000); };
// panels:
        <Panel id="prs" title="Pull Requests" count={state.states.github.snapshot ? state.states.github.snapshot.incoming.length + state.states.github.snapshot.mine.length : undefined}
          unread={showUnread ? unread.prs.length : 0} state={state.states.github} intervalSec={intervals.github} now={now}
          onRefresh={() => void refreshSource('github')} onMarkAllSeen={() => seeSource('github')} openUrl="https://github.com/pulls/review-requested">
          <PullRequests snapshot={state.states.github.snapshot} events={state.events} onSee={seeIds} now={now} />
        </Panel>
        <Panel id="builds" title="Builds" count={state.states.codemagic.snapshot ? `${state.states.codemagic.snapshot.apps.length} apps` : undefined}
          unread={showUnread ? unread.builds.length : 0} state={state.states.codemagic} intervalSec={intervals.codemagic} now={now}
          onRefresh={() => void refreshSource('codemagic')} onMarkAllSeen={() => seeSource('codemagic')} openUrl="https://codemagic.io/apps"
          headerRight={<>
            {buildNotice && <span className="ok">{buildNotice}</span>}
            <button className="btn primary" disabled={!state.states.codemagic.snapshot} onClick={() => setBuildDialog(true)}><IconPlay size={12} />Start build</button>
          </>}>
          <Builds snapshot={state.states.codemagic.snapshot} events={state.events} onSee={seeIds} now={now} />
        </Panel>
// after </main>:
      {buildDialog && state.states.codemagic.snapshot && (
        <StartBuildDialog snapshot={state.states.codemagic.snapshot} onClose={() => setBuildDialog(false)} onStarted={onBuildStarted} />
      )}
```

- [ ] **Step 7: Verify and commit**

`bun run build && bun run start`: PR rows open on GitHub in a new tab and their "new" dot clears; the Builds panel groups by app; with the token set, Start build → pick app, workflow, branch → a real build appears within 30 s with the pulsing BUILDING tag; artifact links download through `/api/codemagic/artifacts/…`.

```bash
bun test && bun run typecheck
git add web/src
git commit -m "feat(web): pull requests and builds panels with start-build dialog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: Tasks, Issues and Merchant Feedback panels

**Files:**
- Create: `web/src/panels/larkFormat.ts`, `web/src/panels/larkFormat.test.ts`, `web/src/panels/Tasks.tsx`, `web/src/panels/Issues.tsx`, `web/src/panels/Feedback.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `LarkSnapshot`, `LarkRecord`, `PublicConfig`, `Event`; `parseDays` (Task 13); `humanState` (Task 10); `unreadItems`, `openItem`.
- Produces: `larkFormat.ts`: `progressPercent(v): number | null`, `ageClass(hoursSince): 'fail' | 'warn' | 'plain'`, `ageLabel(hoursSince)`, `typeClass(type)`, `priorityClass(priority)`, `shortCategory(category)`, `categoryClass(category)`, `shortDate(value)`, `otherCounts(counts, shown): string`. Components `<Tasks snapshot config />`, `<Issues snapshot events onSee config />`, `<Feedback snapshot events onSee />`.

- [ ] **Step 1: Write the failing helper tests**

`web/src/panels/larkFormat.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { ageClass, ageLabel, categoryClass, otherCounts, priorityClass, progressPercent, shortCategory, shortDate, typeClass } from './larkFormat';

test('progressPercent accepts fractions and percentages', () => {
  expect(progressPercent('0.92')).toBe(92);
  expect(progressPercent('45')).toBe(45);
  expect(progressPercent('1')).toBe(100);
  expect(progressPercent('')).toBeNull();
});

test('age tags: red over 3 days, amber over 1 day', () => {
  expect(ageClass('1237 hours | 51.5 days')).toBe('fail');
  expect(ageClass('69 hours | 2.9 days')).toBe('warn');
  expect(ageClass('6 hours | 0.2 days')).toBe('plain');
  expect(ageLabel('69 hours | 2.9 days')).toBe('2.9 d');
  expect(ageLabel('n/a')).toBe('n/a');
});

test('type and priority classes', () => {
  expect(typeClass('FEATURE')).toBe('feature');
  expect(typeClass('CHORE')).toBe('chore');
  expect(typeClass('QE')).toBe('qe');
  expect(typeClass('BUG')).toBe('plain');
  expect(priorityClass('High')).toBe('high');
  expect(priorityClass('Normal')).toBe('normal');
  expect(priorityClass('Low')).toBe('plain');
});

test('categories drop the leading channel segment', () => {
  expect(shortCategory('MOBILE > SGPOS > GENERAL')).toBe('SGPOS · GENERAL');
  expect(shortCategory('ERP > SHOPPING APP > APP LAYOUT')).toBe('SHOPPING APP · APP LAYOUT');
  expect(shortCategory('SGPOS')).toBe('SGPOS');
  expect(categoryClass('MOBILE > SGPOS > NEW REQUEST')).toBe('qe');
  expect(categoryClass('MOBILE > SGPOS > GENERAL')).toBe('feature');
  expect(categoryClass('MOBILE > SHOPPING APP > GENERAL')).toBe('warn');
  expect(categoryClass('OTHER')).toBe('plain');
});

test('shortDate handles both Lark date renderings', () => {
  expect(shortDate('10/09/2026')).toBe('10/09');
  expect(shortDate('2026/09/10 09:22')).toBe('10/09');
  expect(shortDate('yesterday')).toBe('yesterday');
});

test('otherCounts lists statuses that are not shown', () => {
  expect(otherCounts({ OPEN: 4, CHECKING: 1, RESOLVED: 324, CLOSED: 127 }, ['OPEN', 'CHECKING'])).toBe('Resolved 324 · Closed 127');
});
```

- [ ] **Step 2: Write larkFormat.ts**

```ts
import { parseDays } from '../../../shared/attention';
import { humanState } from '../../../shared/status';

export function progressPercent(v: string): number | null {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n <= 1 ? n * 100 : n)));
}

export function ageClass(hoursSince: string): 'fail' | 'warn' | 'plain' {
  const d = parseDays(hoursSince);
  if (d == null) return 'plain';
  return d > 3 ? 'fail' : d > 1 ? 'warn' : 'plain';
}
export function ageLabel(hoursSince: string): string {
  const d = parseDays(hoursSince);
  return d == null ? hoursSince : `${Math.round(d * 10) / 10} d`;
}

export function typeClass(type: string): 'feature' | 'chore' | 'qe' | 'plain' {
  const t = type.trim().toLowerCase();
  return t === 'feature' || t === 'chore' || t === 'qe' ? t : 'plain';
}
export function priorityClass(priority: string): 'high' | 'normal' | 'plain' {
  const p = priority.trim().toLowerCase();
  return p === 'high' ? 'high' : p === 'normal' ? 'normal' : 'plain';
}

export function shortCategory(category: string): string {
  const parts = category.split('>').map((s) => s.trim()).filter(Boolean);
  return (parts.length >= 3 ? parts.slice(1) : parts).join(' · ');
}
export function categoryClass(category: string): 'qe' | 'feature' | 'warn' | 'plain' {
  const c = category.toUpperCase();
  if (c.includes('NEW REQUEST')) return 'qe';
  if (c.includes('SGPOS')) return 'feature';
  if (c.includes('SHOPPING APP')) return 'warn';
  return 'plain';
}

export function shortDate(value: string): string {
  const dmy = /^(\d{2})\/(\d{2})\/\d{4}$/.exec(value);
  if (dmy) return `${dmy[1]}/${dmy[2]}`;
  const ymd = /^\d{4}\/(\d{2})\/(\d{2})/.exec(value);
  if (ymd) return `${ymd[2]}/${ymd[1]}`;
  return value;
}

export function otherCounts(counts: Record<string, number>, shown: string[]): string {
  return Object.entries(counts)
    .filter(([status]) => !shown.includes(status))
    .map(([status, n]) => `${humanState(status)} ${n}`)
    .join(' · ');
}
```

Run: `bun test web/src/panels/larkFormat.test.ts` → 6 pass.

- [ ] **Step 3: Write Tasks.tsx**

```tsx
import { useState } from 'react';
import type { LarkRecord, LarkSnapshot, PublicConfig } from '../../../shared/types';
import { IconChevronDown, IconChevronRight } from '../icons';
import { priorityClass, progressPercent, typeClass } from './larkFormat';

interface Props { snapshot: LarkSnapshot | null; config: PublicConfig }

function Others({ pic }: { pic: string }) {
  const names = pic.split(',').map((s) => s.trim()).filter(Boolean);
  return names.length > 1 ? <span className="meta" title={pic}>+{names.length - 1}</span> : null;
}

function TaskRow({ r }: { r: LarkRecord }) {
  const f = r.fields;
  const pct = progressPercent(f.progress ?? '');
  return (
    <a className="row click" href={r.url} target="_blank" rel="noreferrer" role="listitem">
      <span className="title" title={f.title}>{f.title}</span>
      <Others pic={f.pic ?? ''} />
      {f.type && <span className={`tag ${typeClass(f.type)}`}>{f.type}</span>}
      {f.priority && <span className={`tag ${priorityClass(f.priority)}`}>{f.priority}</span>}
      {pct != null && <span className="bar" title={`${pct}%`}><i style={{ width: `${pct}%` }} /></span>}
    </a>
  );
}

export function Tasks({ snapshot, config }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => Object.fromEntries(config.collapsedStatuses.map((s) => [s, true])));
  if (!snapshot) return <div className="note">Waiting for the first Lark poll…</div>;
  if (snapshot.tasks.groups.length === 0) return <div className="note">No tasks in your view.</div>;
  const dot = (status: string) => (status === config.pendingLaunchStatus ? 'amber' : config.collapsedStatuses.includes(status) ? 'green' : 'blue');
  return (
    <div className="rows" role="list">
      {snapshot.tasks.groups.map((g) => {
        const isCollapsed = !!collapsed[g.status];
        return (
          <div key={g.status}>
            <button className="group" onClick={() => setCollapsed((c) => ({ ...c, [g.status]: !isCollapsed }))} aria-expanded={!isCollapsed}>
              {isCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
              <i className={`dot ${dot(g.status)}`} />{g.status} <span className="count">{g.records.length}</span>
              {isCollapsed && <span className="right">collapsed</span>}
            </button>
            {!isCollapsed && g.records.map((r) => <TaskRow key={r.recordId} r={r} />)}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Write Issues.tsx**

```tsx
import { parseDays } from '../../../shared/attention';
import type { Event, LarkRecord, LarkSnapshot, PublicConfig } from '../../../shared/types';
import { unreadItems } from '../state';
import { ageClass, ageLabel, priorityClass } from './larkFormat';
import { openItem } from './open';

interface Props { snapshot: LarkSnapshot | null; events: Event[]; onSee: (ids: number[]) => void; config: PublicConfig }

const byOldest = (a: LarkRecord, b: LarkRecord) => (parseDays(b.fields.hoursSince ?? '') ?? 0) - (parseDays(a.fields.hoursSince ?? '') ?? 0);

export function Issues({ snapshot, events, onSee, config }: Props) {
  if (!snapshot) return <div className="note">Waiting for the first Lark poll…</div>;
  const unread = unreadItems(events, 'issues');
  if (snapshot.issues.groups.length === 0) return <div className="note">Nothing open. Every issue is resolved or closed.</div>;
  return (
    <div className="rows" role="list">
      {snapshot.issues.groups.map((g, gi) => (
        <div key={g.status}>
          <div className="group"><i className={`dot ${gi === 0 ? 'red' : 'amber'}`} />{g.status} <span className="count">{g.records.length}</span></div>
          {[...g.records].sort(byOldest).map((r) => {
            const f = r.fields;
            const ids = unread.get(r.recordId) ?? [];
            const age = f.hoursSince ?? '';
            return (
              <button key={r.recordId} role="listitem" className={`row click ${ids.length ? 'new' : ''}`} onClick={() => openItem(r.url, ids, onSee)}>
                <i className={ids.length ? 'newdot' : 'nodot'} />
                <span className="mono" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>{f.ticketId || r.recordId}</span>
                {age && <span className={`tag ${ageClass(age)}`} title={age}>{ageLabel(age)}</span>}
                {f.priority && <span className={`tag ${priorityClass(f.priority)}`}>{f.priority}</span>}
                <span className="meta clip" style={{ width: 130 }} title={f.store}>{f.store}</span>
                <span className="title muted" title={f.description}>{f.description}</span>
              </button>
            );
          })}
        </div>
      ))}
      {config.showIssueStatuses.length === 0 && null}
    </div>
  );
}
```

- [ ] **Step 5: Write Feedback.tsx**

```tsx
import type { Event, LarkSnapshot } from '../../../shared/types';
import { unreadItems } from '../state';
import { categoryClass, shortCategory, shortDate } from './larkFormat';
import { openItem } from './open';

interface Props { snapshot: LarkSnapshot | null; events: Event[]; onSee: (ids: number[]) => void }

export function Feedback({ snapshot, events, onSee }: Props) {
  if (!snapshot) return <div className="note">Waiting for the first Lark poll…</div>;
  const unread = unreadItems(events, 'feedback');
  if (snapshot.feedback.records.length === 0) return <div className="note">No feedback in your view.</div>;
  return (
    <div className="rows" role="list">
      {snapshot.feedback.records.map((r) => {
        const f = r.fields;
        const ids = unread.get(r.recordId) ?? [];
        return (
          <button key={r.recordId} role="listitem" className={`row click ${ids.length ? 'new' : ''}`} onClick={() => openItem(r.url, ids, onSee)}>
            <i className={ids.length ? 'newdot' : 'nodot'} />
            <span className="meta mono" title={f.reportedDate}>{shortDate(f.reportedDate ?? '')}</span>
            {f.category && <span className={`tag ${categoryClass(f.category)}`} title={f.category}>{shortCategory(f.category)}</span>}
            <span className="meta clip" style={{ width: 120 }} title={f.store}>{f.store}</span>
            <span className="title muted" title={f.text}>{f.text}</span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 6: Mount the three panels in App.tsx**

Replace the three interim notes (the `config` guard: these panels need `state.config`; render the note "Loading…" until it exists):

```tsx
import { Feedback } from './panels/Feedback';
import { Issues } from './panels/Issues';
import { Tasks } from './panels/Tasks';
import { otherCounts } from './panels/larkFormat';
// ...
  const lark = state.states.lark.snapshot;
  const larkUrl = state.config ? `https://${state.config.larkDomain}/base/` : undefined;
// panels:
        <Panel id="tasks" title="Tasks" count={lark ? `${lark.tasks.total} · Jenn view` : undefined} unread={0} state={state.states.lark} intervalSec={intervals.lark} now={now} onRefresh={() => void refreshSource('lark')}>
          {state.config ? <Tasks snapshot={lark} config={state.config} /> : <div className="note">Loading…</div>}
        </Panel>
        <Panel id="issues" title="Issues" count={lark ? `${lark.issues.groups.reduce((n, g) => n + g.records.length, 0)} active` : undefined}
          unread={showUnread ? unread.issues.length : 0} state={state.states.lark} intervalSec={intervals.lark} now={now}
          onRefresh={() => void refreshSource('lark')} onMarkAllSeen={() => seeIds(unread.issues.map((e) => e.id))}
          headerRight={lark && state.config ? <span className="meta">{otherCounts(lark.issues.counts, state.config.showIssueStatuses)}</span> : null}>
          {state.config ? <Issues snapshot={lark} events={state.events} onSee={seeIds} config={state.config} /> : <div className="note">Loading…</div>}
        </Panel>
        <Panel id="feedback" title="Merchant Feedback" count={lark ? `newest ${lark.feedback.records.length}` : undefined}
          unread={showUnread ? unread.feedback.length : 0} state={state.states.lark} intervalSec={intervals.lark} now={now}
          onRefresh={() => void refreshSource('lark')} onMarkAllSeen={() => seeIds(unread.feedback.map((e) => e.id))}>
          <Feedback snapshot={lark} events={state.events} onSee={seeIds} />
        </Panel>
```

(`larkUrl` is unused for now; delete it if the linter complains. Each row already deep-links to its record.)

- [ ] **Step 7: Verify and commit**

`bun run build && bun run start` with real Lark ids: Tasks shows your groups with PRODUCTION collapsed; Issues shows OPEN then CHECKING, oldest first, with red/amber age tags and "Resolved N · Closed N" in the header; Feedback shows the newest 30. Clicking any row opens that record in Lark.

```bash
bun test && bun run typecheck
git add web/src
git commit -m "feat(web): tasks, issues and merchant feedback panels

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 19: Stores panel

**Files:**
- Create: `web/src/panels/Stores.tsx`, `web/src/panels/Stores.test.ts`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `AppStoreSnapshot`, `PlaySnapshot`, `AppStoreApp`, `PlayApp`, `Event`; `APPSTORE_LIVE_STATES`, `APPSTORE_REJECTED_STATES`, `humanState` (Task 10); `unreadItems`, `openItem`.
- Produces: `joinStoreApps(appstore, playstore, accountOrder): StoreRow[]` with `StoreRow { account; name; ios: AppStoreApp | null; android: PlayApp | null }`, `iosStateClass(state)`, `playStatusClass(status)`, `<Stores appstore playstore events onSee accounts />`.

Rows join iOS and Android by `account` + app `name`, so the display `name` of each Play app in config must equal the App Store Connect app name.

- [ ] **Step 1: Write the failing test**

`web/src/panels/Stores.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { iosStateClass, joinStoreApps, playStatusClass } from './Stores';
import type { AppStoreApp, PlayApp } from '../../../shared/types';

const ios = (account: string, name: string): AppStoreApp => ({ account, appId: name, name, bundleId: 'b', live: null, inflight: null, url: 'u' });
const android = (account: string, name: string): PlayApp => ({ account, packageName: name, name, releases: [], url: 'u' });

test('joinStoreApps groups by account in config order and pairs by name', () => {
  const rows = joinStoreApps({ apps: [ios('B', 'Shop'), ios('A', 'SGPOS')] }, { apps: [android('A', 'SGPOS'), android('A', 'Only Android')] }, ['A', 'B']);
  expect(rows.map((r) => [r.account, r.name, !!r.ios, !!r.android])).toEqual([
    ['A', 'SGPOS', true, true],
    ['A', 'Only Android', false, true],
    ['B', 'Shop', true, false],
  ]);
});

test('joinStoreApps tolerates a missing snapshot', () => {
  expect(joinStoreApps(null, { apps: [android('A', 'X')] }, []).map((r) => r.name)).toEqual(['X']);
});

test('state classes', () => {
  expect(iosStateClass('READY_FOR_SALE')).toBe('ok');
  expect(iosStateClass('REJECTED')).toBe('fail');
  expect(iosStateClass('IN_REVIEW')).toBe('warn');
  expect(iosStateClass('PREPARE_FOR_SUBMISSION')).toBe('plain');
  expect(playStatusClass('completed')).toBe('ok');
  expect(playStatusClass('inProgress')).toBe('run');
  expect(playStatusClass('halted')).toBe('fail');
  expect(playStatusClass('draft')).toBe('plain');
});
```

- [ ] **Step 2: Write Stores.tsx**

```tsx
import { APPSTORE_LIVE_STATES, APPSTORE_REJECTED_STATES, humanState } from '../../../shared/status';
import type { AppStoreApp, AppStoreSnapshot, Event, PlayApp, PlaySnapshot } from '../../../shared/types';
import { unreadItems } from '../state';
import { openItem } from './open';

export interface StoreRow { account: string; name: string; ios: AppStoreApp | null; android: PlayApp | null }

export function joinStoreApps(appstore: AppStoreSnapshot | null, playstore: PlaySnapshot | null, accountOrder: string[]): StoreRow[] {
  const rows = new Map<string, StoreRow>();
  const key = (account: string, name: string) => `${account}::${name}`;
  for (const a of appstore?.apps ?? []) rows.set(key(a.account, a.name), { account: a.account, name: a.name, ios: a, android: null });
  for (const p of playstore?.apps ?? []) {
    const k = key(p.account, p.name);
    const existing = rows.get(k);
    if (existing) existing.android = p;
    else rows.set(k, { account: p.account, name: p.name, ios: null, android: p });
  }
  const rank = (account: string) => { const i = accountOrder.indexOf(account); return i === -1 ? accountOrder.length : i; };
  return [...rows.values()].sort((a, b) => rank(a.account) - rank(b.account) || a.account.localeCompare(b.account));
}

export function iosStateClass(state: string): 'ok' | 'fail' | 'warn' | 'plain' {
  if (APPSTORE_LIVE_STATES.has(state)) return 'ok';
  if (APPSTORE_REJECTED_STATES.has(state)) return 'fail';
  if (state === 'WAITING_FOR_REVIEW' || state === 'IN_REVIEW' || state === 'PENDING_DEVELOPER_RELEASE' || state === 'PENDING_APPLE_RELEASE') return 'warn';
  return 'plain';
}
export function playStatusClass(status: string): 'ok' | 'run' | 'fail' | 'plain' {
  return status === 'completed' ? 'ok' : status === 'inProgress' ? 'run' : status === 'halted' ? 'fail' : 'plain';
}

interface Props { appstore: AppStoreSnapshot | null; playstore: PlaySnapshot | null; events: Event[]; onSee: (ids: number[]) => void; accounts: string[] }

export function Stores({ appstore, playstore, events, onSee, accounts }: Props) {
  const rows = joinStoreApps(appstore, playstore, accounts);
  if (!appstore && !playstore) return <div className="note">Waiting for the first store poll…</div>;
  if (rows.length === 0) return <div className="note">No apps found for the configured accounts.</div>;
  const unread = unreadItems(events, 'stores');
  const idsFor = (r: StoreRow) => [
    ...(r.ios ? unread.get(`${r.ios.account}/${r.ios.appId}`) ?? [] : []),
    ...(r.android ? r.android.releases.flatMap((rel) => unread.get(`${r.android!.account}/${r.android!.packageName}/${rel.track}`) ?? []) : []),
  ];
  let lastAccount: string | null = null;
  return (
    <div className="rows" role="list">
      <div className="stores" style={{ paddingTop: 8, paddingBottom: 6 }}>
        <span className="sub head">APP</span><span className="sub head">iOS · APP STORE</span><span className="sub head">ANDROID · GOOGLE PLAY</span>
      </div>
      {rows.map((r) => {
        const header = r.account !== lastAccount ? <div className="group" key={`g-${r.account}`}>{r.account.toUpperCase()}</div> : null;
        lastAccount = r.account;
        const ids = idsFor(r);
        const production = r.android?.releases.find((rel) => rel.track === 'production') ?? null;
        const others = r.android?.releases.filter((rel) => rel !== production) ?? [];
        return (
          <div key={`${r.account}/${r.name}`}>
            {header}
            <div className={`stores ${ids.length ? 'new' : ''}`} role="listitem">
              <div className="cell">
                <span style={{ fontWeight: 500, display: 'inline-flex', gap: 8, alignItems: 'center' }}>{ids.length ? <i className="newdot" /> : null}{r.name}</span>
                <span className="sub mono">{r.ios?.bundleId ?? r.android?.packageName}</span>
              </div>
              <div className="cell">
                {!r.ios && <span className="sub">not on this account</span>}
                {r.ios?.live && <span className="ver"><span className="mono">{r.ios.live.version}</span><span className={`tag ${iosStateClass(r.ios.live.state)}`}>{humanState(r.ios.live.state)}</span></span>}
                {r.ios?.inflight && (
                  <span className="ver">
                    <span className="mono">{r.ios.inflight.version}</span>
                    <span className={`tag ${iosStateClass(r.ios.inflight.state)}`}>{humanState(r.ios.inflight.state)}</span>
                    {APPSTORE_REJECTED_STATES.has(r.ios.inflight.state) && <a className="sub" href={r.ios.url} target="_blank" rel="noreferrer" onClick={() => onSee(ids)}>open App Review</a>}
                  </span>
                )}
                {r.ios && !r.ios.live && !r.ios.inflight && <span className="sub">no iOS versions</span>}
                {r.ios && <a className="sub" href={r.ios.url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openItem(r.ios!.url, ids, onSee); }}>App Store Connect</a>}
              </div>
              <div className="cell">
                {!r.android && <span className="sub">not on this account</span>}
                {production && <span className="ver"><span className="mono">{production.name ?? ''} ({production.versionCodes.join(', ')})</span><span className={`tag ${playStatusClass(production.status)}`}>{production.status === 'inProgress' ? `${Math.round((production.userFraction ?? 0) * 100)}% rollout` : humanState(production.status)}</span></span>}
                {others.map((rel) => (
                  <span className="ver" key={rel.track}><span className="sub">{rel.track}</span><span className="mono">{rel.name ?? ''} ({rel.versionCodes.join(', ')})</span><span className={`tag ${playStatusClass(rel.status)}`}>{rel.status === 'inProgress' ? `${Math.round((rel.userFraction ?? 0) * 100)}% rollout` : humanState(rel.status)}</span></span>
                ))}
                {r.android && r.android.releases.length === 0 && <span className="sub">no releases</span>}
                {r.android && <a className="sub" href={r.android.url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); openItem(r.android!.url, ids, onSee); }}>Play Console</a>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

Add to `styles.css`: `.stores.new { background: var(--surface2); }`.

Run: `bun test web/src/panels/Stores.test.ts` → 3 pass.

- [ ] **Step 3: Mount in App.tsx**

```tsx
import { Stores } from './panels/Stores';
// replace the interim note:
        <Panel id="stores" title="Stores" count={state.config ? `${state.config.accounts.length} accounts` : undefined}
          unread={showUnread ? unread.stores.length : 0} state={[state.states.appstore, state.states.playstore]} intervalSec={intervals.appstore} now={now}
          onRefresh={() => { void refreshSource('appstore'); void refreshSource('playstore'); }} onMarkAllSeen={() => seeIds(unread.stores.map((e) => e.id))}>
          <Stores appstore={state.states.appstore.snapshot} playstore={state.states.playstore.snapshot} events={state.events} onSee={seeIds} accounts={state.config?.accounts ?? []} />
        </Panel>
```

- [ ] **Step 4: Verify and commit**

`bun run build && bun run start` with at least one account configured: one section per account, rows pairing iOS and Android by name, a rejected in-flight version shows the red tag and the "open App Review" link.

```bash
bun test && bun run typecheck
git add web/src
git commit -m "feat(web): stores panel across developer accounts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 20: Synthetic-event route, list-panel component test and end-to-end smoke run

**Files:**
- Create: `web/src/panels/Issues.test.tsx`
- Modify: `server/app.ts` (dev route), `server/app.test.ts`, `server/index.ts`

**Interfaces:**
- Produces: `AppDeps.devEmit?: boolean`; `POST /api/dev/emit` (only when `DASHBOARD_DEV=1`) with body `{ source, kind, priority?, itemId?, title?, url? }` → stores one event and broadcasts it over SSE. Used only to exercise alerts by hand.

- [ ] **Step 1: Write the failing route tests**

Append to `server/app.test.ts`:

```ts
import { SseHub } from './sse';
import type { SSEStreamingApi } from 'hono/streaming';

describe('POST /api/dev/emit', () => {
  const body = JSON.stringify({ source: 'github', kind: 'pr.review_requested', title: 'Synthetic' });
  const headers = { 'content-type': 'application/json' };

  test('is absent unless devEmit is on', async () => {
    expect((await app.request('/api/dev/emit', { method: 'POST', body, headers })).status).toBe(404);
  });

  test('stores a high event and broadcasts it', async () => {
    const hub = new SseHub();
    const writes: string[] = [];
    hub.add({ writeSSE: async (m: { data: string }) => { writes.push(m.data); } } as unknown as SSEStreamingApi);
    const dev = createApp({ store, scheduler: new Scheduler([], store, () => {}), hub, publicConfig, disabled: {}, devEmit: true });
    const res = await dev.request('/api/dev/emit', { method: 'POST', body, headers });
    expect(res.status).toBe(200);
    expect((await res.json()).priority).toBe('high');
    expect(store.unseenEvents()).toHaveLength(1);
    expect(JSON.parse(writes[0]!).events[0].title).toBe('Synthetic');
  });
});
```

Run: `bun test server/app.test.ts` → the two new tests FAIL (404 on both).

- [ ] **Step 2: Add the route**

In `server/app.ts`, add `devEmit?: boolean;` to `AppDeps`, import `NewEvent` from `../shared/types`, and before `return app;`:

```ts
  if (deps.devEmit) {
    app.post('/api/dev/emit', async (c) => {
      const body = (await c.req.json().catch(() => null)) as Partial<NewEvent> | null;
      if (!body || typeof body.source !== 'string' || !isSourceId(body.source) || typeof body.kind !== 'string') {
        return c.json({ error: 'source and kind are required' }, 400);
      }
      const source = body.source;
      const [event] = deps.store.addEvents(
        [{
          source,
          kind: body.kind,
          priority: body.priority === 'normal' ? 'normal' : 'high',
          itemId: String(body.itemId ?? `dev-${Date.now()}`),
          title: String(body.title ?? `Synthetic ${body.kind}`),
          url: typeof body.url === 'string' ? body.url : null,
        }],
        Date.now(),
      );
      await deps.hub.broadcast({ source, state: deps.store.allStates(deps.disabled)[source], events: event ? [event] : [] });
      return c.json(event);
    });
  }
```

In `server/index.ts`, pass `devEmit: process.env.DASHBOARD_DEV === '1'` into `createApp` and, when true, `log('DASHBOARD_DEV=1: POST /api/dev/emit is enabled')`.

Run: `bun test server/app.test.ts` → 9 pass.

- [ ] **Step 3: Write the failing Issues component test**

`web/src/panels/Issues.test.tsx`:

```tsx
import { afterEach, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Issues } from './Issues';
import type { Event, LarkSnapshot, PublicConfig } from '../../../shared/types';

afterEach(cleanup);

const config: PublicConfig = {
  intervals: { github: 60, codemagic: 120, lark: 120, appstore: 600, playstore: 600 },
  larkDomain: 'd', accounts: [], pendingLaunchStatus: 'P', collapsedStatuses: [], showIssueStatuses: ['OPEN', 'CHECKING'],
};
const rec = (id: string, ticket: string, hours: string, description: string) => ({
  recordId: id, url: `https://lark/${id}`,
  fields: { ticketId: ticket, hoursSince: hours, priority: 'Normal', store: 'Store', description, status: 'OPEN' },
});
const snapshot: LarkSnapshot = {
  tasks: { groups: [], total: 0 },
  issues: { groups: [{ status: 'OPEN', records: [rec('r1', '#G001', '24 hours | 1 days', 'Overselling'), rec('r2', '#G002', '1237 hours | 51.5 days', 'Auction')] }], counts: { OPEN: 2 } },
  feedback: { records: [] },
};
const events: Event[] = [{ id: 7, source: 'lark', kind: 'issue.opened', priority: 'high', itemId: 'r1', title: 'New issue', url: 'https://lark/r1', createdAt: 0, seen: false }];

test('sorts oldest first, highlights the unread row and marks it seen on click', () => {
  const onSee = mock(() => {});
  const open = mock(() => null);
  const originalOpen = window.open;
  window.open = open as unknown as typeof window.open;
  try {
    render(<Issues snapshot={snapshot} events={events} onSee={onSee} config={config} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('#G002');
    expect(rows[0]?.className).not.toContain('new');
    expect(rows[1]?.className).toContain('new');
    fireEvent.click(rows[1]!);
    expect(onSee).toHaveBeenCalledWith([7]);
    expect(open).toHaveBeenCalledWith('https://lark/r1', '_blank', 'noopener');
  } finally {
    window.open = originalOpen;
  }
});

test('shows the waiting note before the first poll', () => {
  render(<Issues snapshot={null} events={[]} onSee={() => {}} config={config} />);
  expect(screen.getByText(/Waiting for the first Lark poll/)).toBeTruthy();
});
```

Run: `bun test web/src/panels/Issues.test.tsx` → 2 pass (the component exists since Task 18; if a selector fails, fix the test's expectation to the rendered markup, not the component).

- [ ] **Step 4: Smoke run (spec §9 manual list)**

Build and start with the dev route on. PowerShell:

```powershell
bun run build
$env:DASHBOARD_DEV = '1'; bun run start
```

Then, with `http://127.0.0.1:6600` open in Edge or Chrome, work through each line and tick it off:

1. Page paints all six panels from cache well under a second (DevTools → Network → `/api/state` is the only blocking request).
2. Settings → Alerts → Windows toast → Grant permission → the green "permission granted" line appears.
3. Fire a synthetic high event (PowerShell):

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:6600/api/dev/emit -ContentType 'application/json' -Body '{"source":"github","kind":"pr.review_requested","priority":"high","itemId":"dev-1","title":"Synthetic review request","url":"https://github.com/pulls"}'
```

   Expected: a Windows toast titled "Synthetic review request"; the tab title becomes `(1) Dashboard`; the Pull Requests panel shows an unread badge. Clicking the toast focuses the tab and clears the badge.
4. Switch to In-page badges, fire the same command again: no toast, badge increments, title updates. Click the badge → marked seen. Switch to Off: badge and title count disappear; switch back to Badge: they return (events are still unseen server-side).
5. Appearance: Dark, Large, Compact → reload → all three persist. Auto follows the Windows theme toggle.
6. Panel failure: stop the network (or temporarily rename `config/secrets/.env` and restart) → the Builds panel header turns amber with "Stale since HH:MM · …" and last data remains; the header dot for Codemagic is red with the reason on hover. Restore and confirm it recovers within one interval or on Refresh.
7. Builds → Start build → app, workflow, branch → Start. The build appears with a pulsing BUILDING tag and the panel ticks every 30 s until it finishes; a build.finished/failed event badges the panel.
8. Click an artifact link on a finished build → the file downloads (name and size correct).
9. Click a PR row, a task row, an issue row, a feedback row and a store cell → each opens the right page in a new tab and clears its unread dot.

Anything that fails here is a bug in an earlier task: fix it there (with a regression test where the failure was in logic), re-run `bun test`, and repeat the affected line.

- [ ] **Step 5: Commit**

```bash
bun test && bun run typecheck
git add server/app.ts server/app.test.ts server/index.ts web/src/panels/Issues.test.tsx
git commit -m "feat: dev emit route for alert testing, issues panel component test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 21: Setup guide, real configuration and final live check

**Files:**
- Create: `README.md`
- Modify: `config/dashboard.config.json` (real ids), `config/secrets/*` (never committed), `docs/superpowers/specs/2026-09-17-personal-dashboard-design.md` (status line)

**Interfaces:** none new. This task turns the placeholder configuration into the real one and records how to do it again.

- [ ] **Step 1: Write README.md**

```markdown
# Personal Dashboard

One local page for the daily round: pull requests to review, Codemagic builds, Lark tasks, merchant issues and feedback, and App Store / Play Store release state across three developer accounts. Runs as a single Bun process on this PC; nothing is hosted anywhere.

Design spec: `docs/superpowers/specs/2026-09-17-personal-dashboard-design.md`. Approved mockup: https://claude.ai/artifact/XGdR5PzrLSg7j6r1GBbuWP

## Prerequisites

- Bun 1.3+ (`bun --version`)
- GitHub CLI logged in as `jennsg` (`gh auth status`)
- lark-cli 1.0.49+ logged in (`lark-cli auth status`, or `lark-cli auth login`)
- A Codemagic API token, one App Store Connect API key per Apple developer account, one Google Play service account per Play developer account (steps below)

## First-time setup

1. `bun install`
2. `cp config/dashboard.config.example.json config/dashboard.config.json`
3. Fill in the sections below, then `bun run check` until every row says OK.

### Lark Base

Open each "Jenn" view in Lark and copy its URL: `https://<domain>/base/<baseToken>?table=<tableId>&view=<viewId>`.

- `lark.domain` — the host part (e.g. `yourcompany.larksuite.com`)
- `lark.baseToken` — the `basc…` segment
- `lark.tables.tasks|issues|feedback.tableId` / `viewId` — from the three URLs (R&D Task, Issue Tracker, Merchant Feedback)

Confirm the field names the dashboard maps (they are the column headers; the `status` field is the one each view groups by):

```bash
lark-cli base +field-list --base-token <baseToken> --table-id <tableId> --format json --as user
```

Edit `fields.*` in each table block if a header differs from the example. `tasks.pendingLaunchStatus`, `tasks.collapsedStatuses` and `issues.showStatuses` must match the exact option text in Lark.

### Codemagic

Codemagic → Teams → Personal Account → Integrations → Codemagic API → copy the token. Create `config/secrets/.env`:

```
CODEMAGIC_API_TOKEN=your-token
```

Set `codemagic.enabled` to `false` to switch the panel off instead.

### App Store Connect (per Apple account)

App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → Generate API Key (role: Developer is enough). Download the `.p8` once into `config/secrets/`. Add to `stores.accounts[]`:

```json
{ "name": "Account name", "appstore": { "issuerId": "<Issuer ID>", "keyId": "<Key ID>", "keyFile": "secrets/AuthKey_<Key ID>.p8" } }
```

### Google Play (per Play account)

1. Google Cloud Console → IAM & Admin → Service Accounts → Create → Keys → Add key (JSON). Save it as `config/secrets/play-<account>.json`.
2. Play Console → Users and permissions → Invite new users → the service-account email → grant "View app information and download bulk reports" on the apps to watch.
3. Add `play` to the same account entry:

```json
"play": {
  "serviceAccountFile": "secrets/play-<account>.json",
  "developerId": "<the number in the Play Console URL>",
  "apps": [ { "packageName": "com.example.app", "name": "Same name as in App Store Connect", "consoleUrl": "https://play.google.com/console/u/0/developers/<developerId>/app/<consoleAppId>/tracks/production" } ]
}
```

The Play `name` must equal the App Store Connect app name so both columns land on the same row. `consoleUrl` is optional; without it the cell links to the account's app list.

## Running

| Command | What it does |
|---|---|
| `bun run dev` | Server with reload on :6600 and Vite with hot reload on :5173 (open the Vite URL) |
| `bun run build` then `bun run start` | Production: builds the UI, serves everything on http://127.0.0.1:6600 |
| `bun run check` | Calls every configured source once and prints OK / ERROR / DISABLED per source |
| `bun test` | Unit, API and component tests |
| `bun run typecheck` | TypeScript across server, shared and web |

Run all commands from the repository root (static files resolve against the working directory).

## Settings

Gear icon, top right. Alerts: Windows toast (native notification for high-priority events; needs one-time permission), in-page badges only, or off. Appearance: theme light / dark / auto, font size small / medium / large, density comfortable / compact. Stored per browser.

## When something goes amber or red

The header dot and the panel label say why. Common fixes:

- "run `gh auth login`" or "gh active account is X" → `gh auth login` / `gh auth switch --user jennsg`, then Refresh.
- "run `lark-cli auth login`" → the user token expired; log in again.
- "Codemagic token rejected" → regenerate the token and update `config/secrets/.env`, restart.
- "App Store key for account X rejected" → the key was revoked or the Issuer/Key ID is wrong for that account.
- "Play service account for account X rejected or not invited" → invite the service-account email in that Play Console and grant app access.
- "lark config still has placeholder ids" → finish the Lark section above.

Poll intervals are in `config/dashboard.config.json` → `polling` (seconds). Backoff doubles after each failed poll, up to 10 minutes; Refresh resets it.

## Testing alerts by hand

Start with `DASHBOARD_DEV=1` (PowerShell: `$env:DASHBOARD_DEV='1'; bun run start`) and post a synthetic event:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:6600/api/dev/emit -ContentType 'application/json' -Body '{"source":"github","kind":"pr.review_requested","priority":"high","title":"Synthetic"}'
```

## Not in this version

Writing back to Lark, server-side toasts when no tab is open, store ratings and crash data, the `mobileapp-sitegiant` GitHub account, auto-start at login, phone access. See spec §10.
```

- [ ] **Step 2: Fill the real configuration**

Follow the README with the real Lark URLs, Codemagic token, one App Store key per account and one Play service account per account. Complete every "carry to Task 21" item left from Tasks 8–11: real Codemagic fixtures (Task 8 Step 8), the real lark-cli envelope and field names (Task 9 Step 8), App Store live check (Task 10 Step 10), Play live check (Task 11 Step 8). Re-run the affected test files after each fixture swap.

- [ ] **Step 3: Live check**

```bash
bun run check
```

Expected: five rows, all `OK`, e.g.

```
github     OK  812 ms · 3 incoming, 2 mine
codemagic  OK  1450 ms · 2 apps, 17 builds
lark       OK  3100 ms · 218 tasks, 456 issues, 30 feedback
appstore   OK  2200 ms · 4 apps
playstore  OK  1900 ms · 4 apps
```

Any ERROR row: the message names the account or the auth step; fix and re-run. Do not proceed with a DISABLED row unless that source is intentionally off.

- [ ] **Step 4: Run the smoke list once more against real data**

`bun run build && bun run start`, then Task 20 Step 4 lines 1, 5, 7, 8 and 9 with real data (toast/badge lines were covered synthetically). Confirm the Stores panel pairs every app's iOS and Android columns; if a row is split in two, the Play `name` in config does not match the App Store Connect name.

- [ ] **Step 5: Mark the spec implemented and commit**

Change the spec's `Status:` line to `Status: implemented 2026-MM-DD (see README.md for setup)` with today's date.

```bash
bun test && bun run typecheck
git add README.md config/dashboard.config.json docs/superpowers/specs/2026-09-17-personal-dashboard-design.md server/sources/__fixtures__
git status   # config/secrets/ and data/ must NOT appear
git commit -m "docs: setup guide; real dashboard configuration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

`git status` must show nothing under `config/secrets/` other than `.gitkeep`; if a key file shows up, stop and fix `.gitignore` before committing.
