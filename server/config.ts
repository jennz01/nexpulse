import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PublicConfig, SourceId } from '../shared/types';

const id = z.string().min(1);

const TaskFields = z.object({ title: id, status: id, pic: id, type: id, priority: id, progress: id });
const IssueFields = z.object({
  ticketId: id, reportedDate: id, hoursSince: id, priority: id, store: id, description: id, status: id,
  /** Optional columns shown in the row and detail dialog; `attachments` names the attachment column. */
  reportedBy: id.optional(), taggedPic: id.optional(), modulePic: id.optional(), attachments: id.optional(),
});
const FeedbackFields = z.object({
  reportedDate: id, category: id, store: id, text: id,
  /** Optional columns: `status` groups the panel, the rest show in the row and detail dialog. */
  rid: id.optional(), status: id.optional(), pic: id.optional(), reportedBy: id.optional(), taskLink: id.optional(), attachments: id.optional(),
});

const TasksTable = z.object({
  tableId: id,
  viewId: id,
  pendingLaunchStatus: z.string().default('PENDING TO LAUNCH'),
  collapsedStatuses: z.array(z.string()).default(['PRODUCTION']),
  /** Display order for the active task groups; unlisted statuses follow, collapsed ones come last. */
  groupOrder: z.array(z.string()).default([]),
  /** Share link of a Lark Base form that adds a row to this table; when set, the Tasks panel shows a "Create task" button that opens it. */
  createFormUrl: z.string().url().optional(),
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
  /** Status groups shown first, in this order; other statuses follow by first appearance. */
  groupOrder: z.array(z.string()).default([]),
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
  github: z.object({
    account: id,
    /** Repositories (owner/name) whose open PRs fill the panel's All tab; chosen from the Settings page. */
    repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/name')).max(50).default([]),
  }),
  codemagic: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  lark: z.object({
    domain: id,
    baseToken: id,
    tables: z.object({ tasks: TasksTable, issues: IssuesTable, feedback: FeedbackTable }),
  }),
  stores: z.object({ accounts: z.array(StoreAccount).default([]) }).default({ accounts: [] }),
});

export type DashboardConfig = z.infer<typeof ConfigSchema>;
/** `github.account` still blank or as shipped in the example config. The dashboard then accepts whichever account gh is signed in as and writes it back (AuthManager, index.ts). */
export const isUnsetGithubAccount = (account: string): boolean => account.trim() === '' || account === 'your-github-login';
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
  const larkIds = [config.lark.baseToken, ...Object.values(config.lark.tables).flatMap((t) => [t.tableId, t.viewId])];
  if (larkIds.some((v) => /XXXX/.test(v))) problems.lark = 'lark config still has placeholder ids (see README: Lark setup)';

  return problems;
}

/** A UTF-8 text file minus the byte order mark that Windows PowerShell 5.1 (`-Encoding utf8`) and some editors put first; JSON.parse rejects it. */
export function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
}

export function loadConfig(rootDir: string): LoadedConfig {
  const configDir = resolve(rootDir, 'config');
  const configPath = resolve(configDir, 'dashboard.config.json');
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${configPath}. Copy config/dashboard.config.example.json to config/dashboard.config.json and fill it in.`);
  }
  const parsed = ConfigSchema.safeParse(JSON.parse(readText(configPath)));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid dashboard.config.json:\n${lines.join('\n')}`);
  }
  const envPath = resolve(configDir, 'secrets', '.env');
  const secrets: Secrets = existsSync(envPath) ? parseEnvFile(readText(envPath)) : {};
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
    taskFormUrl: config.lark.tables.tasks.createFormUrl ?? null,
    feedbackGroupOrder: config.lark.tables.feedback.groupOrder,
    githubRepos: config.github.repos,
  };
}
