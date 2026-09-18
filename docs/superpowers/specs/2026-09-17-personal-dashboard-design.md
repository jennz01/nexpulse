# Personal Dashboard — Design Spec

Date: 2026-09-17
Status: implemented 2026-09-17 on branch feature/dashboard; Codemagic and Lark read live, App Store and Play await credentials (see README.md). Revised 2026-09-17: sidebar navigation with separate Builds and Stores pages (section 4.1).

## 1. Purpose

A single local web page that replaces six daily check-ins with one glance:

1. Pull requests waiting for my review, and the state of my own PRs (GitHub).
2. Codemagic build status, with the ability to start a build and download artifacts.
3. My R&D tasks from Lark Base.
4. Open merchant issues from the Lark Issue Tracker.
5. Merchant feedback from Lark Base.
6. App Store / Play Store release state for every app across three developer accounts, without switching accounts.

It runs on my Windows PC, reuses the `gh` and `lark-cli` logins already on the machine, and alerts me when something needs action.

## 2. Decisions

| Topic | Decision |
|---|---|
| Form factor | Local web app: one Bun process serving UI + API on `http://localhost:6600` |
| Stack | Bun runtime, Hono (HTTP), React + Vite (UI), Bun's built-in SQLite, TypeScript throughout |
| Architecture | Background poller per source, SQLite snapshot cache, diff-based events, Server-Sent Events to the browser |
| GitHub scope | Account `jennsg` only, every repo it can see |
| Codemagic | Show status, trigger builds, download artifacts |
| Lark Base | Read-only, via the existing private "Jenn" views on three tables; every row deep-links to the record |
| Stores | API keys for all three developer accounts; show release/review state and rejection state |
| Alerts | User setting: Windows toast (via browser Notification API) / in-page badges / off |
| Appearance | User setting: theme light/dark/auto, font size S/M/L, density comfortable/compact |
| Layout | Sidebar with three pages: Home ("needs attention" strip + Pull Requests, Tasks, Issues, Merchant Feedback), Builds, Stores. Revised 2026-09-17; v1 shipped as a single page with six panels |
| Visual direction | "Ops console": dense, neutral, one accent, monospace identifiers (section 4.5, approved mockup) |
| Port | 6600. (6666 was considered but browsers block ports 6665–6669 as unsafe.) |

## 3. Architecture

### 3.1 Runtime

One Bun process:

- Serves the built React app as static files and exposes a JSON API under `/api`.
- Runs one polling loop per source on its own interval.
- Persists snapshots, events and seen-markers in `data/dashboard.sqlite`.
- Pushes live updates to open tabs over SSE at `/api/events`.

No data leaves the PC except the outbound calls to GitHub, Lark, Codemagic, Apple and Google. The server binds to `127.0.0.1` only.

### 3.2 Project layout

```
personal-dashboard/
  package.json                Bun scripts: dev, build, start, check, test
  server/
    index.ts                  Hono app, routes, static serving
    scheduler.ts              per-source loops, intervals, backoff, forced refresh
    store.ts                  SQLite access: snapshots, events, retention
    sse.ts                    client registry + broadcast
    config.ts                 load + validate dashboard.config.json and secrets
    sources/
      types.ts                Source interface
      github.ts
      codemagic.ts
      lark.ts
      appstore.ts
      playstore.ts
  shared/
    types.ts                  Snapshot shapes, Event, AttentionChip; imported by server and web
    attention.ts              pure function: snapshots -> AttentionChip[]
  web/
    index.html, vite.config.ts
    public/fonts/           IBM Plex Sans + Mono woff2, self-hosted
    src/
      main.tsx, App.tsx
      api.ts                  fetch /api/state, SSE client, seen/refresh calls
      state.ts                client store fed by api.ts
      panels/
        ActionStrip.tsx
        PullRequests.tsx
        Builds.tsx            includes StartBuildDialog
        Tasks.tsx
        Issues.tsx
        Feedback.tsx
        Stores.tsx
      settings/
        SettingsDrawer.tsx    alerts + appearance
        useSettings.ts        localStorage-backed
      notify.ts               Notification API wrapper, badge/title updates
  config/
    dashboard.config.json     non-secret configuration (committed)
    dashboard.config.example.json
    secrets/                  gitignored: .env, *.p8, *.json service accounts
  data/                       gitignored: dashboard.sqlite
  docs/superpowers/specs/     this file
```

### 3.3 Source contract

Every module in `server/sources/` exports an object implementing:

```ts
interface Source<S> {
  id: 'github' | 'codemagic' | 'lark' | 'appstore' | 'playstore';
  fetch(ctx: SourceContext): Promise<S>;          // talk to the outside world
  diff(prev: S | null, next: S): Event[];         // what changed and matters
  defaultIntervalSec: number;
  fastIntervalSec?(snapshot: S): number | null;   // e.g. Codemagic while a build runs
}
```

`SourceContext` carries the validated config for that source, a logger, and a `run(cmd, args)` helper for spawning CLIs. Sources do not touch SQLite or SSE.

### 3.4 Data flow, one tick

1. Scheduler fires for source S.
2. `S.fetch()` runs.
   - Success: snapshot saved with `fetched_at`; `S.diff(prev, next)` runs; events saved with `seen = 0`; error fields cleared; interval reset to default (or the fast interval if `fastIntervalSec` returns one).
   - Failure: snapshot untouched; `error`, `error_at` recorded; next interval doubled, capped at 600 s.
3. Server broadcasts `{ source, snapshot, fetchedAt, error, events }` to all SSE clients.

Browser: on load, `GET /api/state` returns all snapshots + unseen events + public config. The page renders from that, then opens SSE and patches per message. Marking seen is `POST /api/events/seen`.

### 3.5 Persistence

```sql
CREATE TABLE snapshots (
  source     TEXT PRIMARY KEY,
  data       TEXT,                   -- JSON; NULL until the first successful fetch
  fetched_at INTEGER,                -- unix ms; NULL until the first successful fetch
  error      TEXT,
  error_at   INTEGER
);
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- see section 6
  priority   TEXT NOT NULL,          -- 'high' | 'normal'
  item_id    TEXT NOT NULL,          -- source-specific stable id
  title      TEXT NOT NULL,
  url        TEXT,
  created_at INTEGER NOT NULL,
  seen       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_unseen ON events(seen, created_at);
```

Events older than 30 days are deleted on startup.

### 3.6 API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | All snapshots, unseen events, public config (account names, intervals, Lark domain) |
| GET | `/api/events` | SSE stream |
| POST | `/api/events/seen` | Body `{ ids?: number[], source?: string }`; marks matching events seen |
| POST | `/api/sources/:id/refresh` | Force an immediate poll of one source |
| POST | `/api/codemagic/builds` | Body `{ appId, workflowId, branch }`; triggers a build, returns `{ buildId }` |
| GET | `/api/codemagic/artifacts/:buildId/:index` | Streams the artifact through the server with the token attached |
| GET | `/api/health` | Per-source last fetch, last error, next run |
| GET | `/api/stores/accounts` | Configured developer accounts without secrets (key id, issuer, file present, service-account email, Play apps) |
| POST | `/api/stores/accounts` | Body `StoreAccountInput`; validates, writes key files under `config/secrets/`, rewrites `stores.accounts` atomically, swaps the store sources in place and polls them |
| DELETE | `/api/stores/accounts/:name` | Removes the account; deletes its key files when no other account references them |
| POST | `/api/stores/test` | Same body; mints the tokens and fetches the App Store app list and each Play package's tracks without saving |

Every non-GET request must carry `x-requested-with: dashboard`; key material travels browser → server only.

## 4. UI

### 4.1 Layout

- **Sidebar** (left, 208 px; collapsible to a 56 px icon rail, and forced to the rail below 1200 px): Home, Builds, Stores. Each item shows the page's unread badge (alert mode permitting) and a dot in the worst tone of the attention chips that target that page. Settings and the collapse toggle sit at the bottom; the collapsed state is saved with the appearance settings.
- **Pages** are hash routes: `#/` Home, `#/builds`, `#/stores`. Home shows the needs-attention strip with every chip, then the Pull Requests, Tasks, Issues and Merchant Feedback panels in a two-column grid (one column when the content column is under 1000 px). Builds and Stores show the strip filtered to their own chips and one full-width panel each. A chip or toast whose target lives on another page switches to it first, then scrolls the panel into view.
- **Header** (top of the content column): page name, date, connection state, one freshness dot per source (green: fetched within 2× its interval; amber: stale; red: last poll errored) with tooltip showing last poll time and error, and a "refresh all" button.
- **Needs attention strip**: horizontally scrolling chips derived from snapshots (section 4.2). Empty state: "Nothing needs you right now."
- **Panels**: each panel header shows a count, an unread badge (alert mode permitting), a refresh icon, and an "open in source" link.

### 4.2 Needs-attention rules

`shared/attention.ts` is a pure function of the snapshots. Chips, in this order:

| Condition | Chip text | Click target |
|---|---|---|
| ≥ 1 non-draft PR with my review requested | "N PRs await your review" | Pull Requests panel |
| ≥ 1 of my PRs with review decision CHANGES_REQUESTED or CI rollup FAILURE/ERROR | "N of your PRs need changes" | Pull Requests panel |
| ≥ 1 build with status failed/timeout in last 24 h | "N builds failed" | Builds panel |
| ≥ 1 build running | "N building" | Builds panel |
| ≥ 1 issue in OPEN | "N open issues, oldest Xd" | Issues panel |
| ≥ 1 issue in CHECKING | "N checking" | Issues panel |
| ≥ 1 task in the configured "pending launch" status | "N pending to launch" | Tasks panel |
| Any iOS version in an attention state (section 5.4) | one chip per app: "SGPOS iOS: REJECTED" | Stores panel |
| Any Play release halted or in staged rollout | one chip per app: "SGPOS Android: 20% rollout" | Stores panel |

### 4.3 Panels

**Pull Requests**: two sub-lists, "Review requested" and "Mine", toggled by tabs inside the panel. Row: repo short name, `#number`, title, author avatar + login, age, CI dot (green/red/grey), and one status badge: Draft while the PR is a draft (a draft has no meaningful review decision), otherwise the review decision (Approved / Changes requested / Review required). Click opens the PR on GitHub in a new tab.

**Builds**: grouped by Codemagic app. Per app, the latest build per workflow with status badge, branch, duration, started-at, started-by. Expand to see the last 10 builds. Each row links to the Codemagic build page and lists artifact download links (served via the API proxy). A "Start build" button opens a dialog: app → workflow (from snapshot) → branch (text field, defaults to the workflow's most recent branch). Running builds show an animated status and poll at the fast interval. On its own page the panel is full width and lists every returned build per app as a table (status, workflow, branch, started, duration, started by, artifacts), so no expand toggle is needed there.

**Tasks**: mirrors the "Jenn" view of R&D Task. Grouped by the status field in the view's group order; the PRODUCTION group is collapsed by default, all others expanded. Row: task name, task type chip, priority chip (High = amber, Normal = blue), progress bar, other PICs if more than me. Click opens the record in Lark.

**Issues**: mirrors the "Jenn" view of Issue Tracker but shows only OPEN and CHECKING groups; RESOLVED/CLOSED counts appear in the header only. Within a group, sorted oldest first. Revised 2026-09-18 (mockup boards "Issues · rows and detail dialog" and "Merchant Feedback · grouped rows and detail dialog" on the canvas above): a row is a card with three lines: ticket ID, hours-since chip (amber > 24 h, red > 72 h), priority chip and the reported time on the right; the description collapsed to one paragraph and clamped to two lines; then ERP store / email, the reporter ("Reported By") and an attachment count. Click marks the row seen and opens a detail dialog (`RecordDialog`): every mapped field, the full description with its line breaks, the attachments (images inline, other files as typed cards, all served by `/api/lark/attachments/:table/:recordId/:token`, which downloads through lark-cli into `data/attachments/` once per file token), Close and "Open in Lark". Escape and the backdrop close it.

**Merchant Feedback**: newest 30 records from the "Jenn" view, grouped by R&D status (configured statuses first, then by first appearance). Row: RID, category chip, reported date on the right, the feedback clamped to two lines, then ERP store / email and reporter. Click opens the same detail dialog with category, R&D status, PIC and the linked R&D task, plus attachments when the column is mapped.

**Stores**: one section per developer account. Inside, a table: rows = apps, columns = iOS and Android. iOS cell: live version + state badge; below it, any in-flight version with its state badge. Android cell: production release name + version code + rollout state; beta/internal tracks in smaller text. Attention states are highlighted. Each cell links to the app's page in App Store Connect or Play Console.

### 4.4 Settings page

A sidebar page at `#/settings` (it replaced the header-gear drawer on 2026-09-17). Preferences are stored in `localStorage` (they describe this screen, not the data); store accounts are stored in the config file through the API in section 3.6.

**Connections** (added 2026-09-18): the `gh` and `lark-cli` sessions and the Codemagic token. `GET /api/auth/status` runs `gh api user` and `lark-cli auth status --verify` (cached 60 s; `?fresh=1` bypasses) and reports `ok`, `expired`, `missing`, `wrong-account` or `unknown` per provider, plus the Lark session's `refreshExpiresAt`. `POST /api/auth/:provider/login` starts a server-driven device-code sign-in: for GitHub, `gh auth login --web` without a TTY prints its one-time code and waits; for Lark, `lark-cli auth login --no-wait --json` returns a device code and verification URL (the user code is a query parameter), and a second `--device-code` call polls until approved. The Lark re-login requests the scopes the current token already holds, so it never narrows access; a first login asks for every domain. `GET`/`DELETE` on the same route report or cancel the flow (one per provider, 15-minute timeout, whole process tree killed on cancel). A finished GitHub sign-in rebuilds the GitHub source so one disabled at startup comes back; a finished Lark sign-in refreshes the Lark source. `POST /api/auth/github/switch` runs `gh auth switch --user <configured>`. The browser shows the code, a link to the verification page and polls every 2 s. `GET/PUT/DELETE /api/codemagic/token` and `POST /api/codemagic/token/test` manage `CODEMAGIC_API_TOKEN` in `config/secrets/.env` (tested against the Codemagic apps endpoint before saving) and swap the Codemagic source and actions in place. The client re-checks status every 5 minutes, on focus, and when a poll fails with an auth-looking error; a banner under the header on every page offers Re-authorize or Switch, and warns when the Lark session ends within 48 h.

**Alerts** (radio): Toast / Badge / Off. Toast mode shows a "grant permission" button until `Notification.permission === 'granted'`.

**Appearance**:

- Theme (radio): Light / Dark / Auto (follows `prefers-color-scheme`). Applied as `data-theme` on `<html>`; CSS variables define both palettes.
- Font size (radio): Small 14 px / Medium 16 px / Large 18 px, applied as root `font-size`; all sizes in the UI use `rem`.
- Density (radio): Comfortable / Compact, toggling row padding variables.
- Sidebar collapsed state, toggled from the sidebar itself.

**Polling**: read-only list of the configured intervals.

**Store accounts**: one card per developer account showing, per store, the key id and issuer or the service-account email, and a status line derived from the live source state (not set up / key file missing / off with reason / last error / waiting / OK with the number of apps that account contributed). "Add account" and "Edit" open a dialog: account name; App Store Connect (switchable) with Issuer ID, Key ID and a `.p8` file picker (the Key ID is pre-filled from an `AuthKey_<id>.p8` filename; when editing, no file means keep the stored key); Google Play (switchable) with a service-account JSON picker, Developer ID and a list of apps (package name, display name with the connected App Store app names as suggestions, optional console URL). "Test connection" calls `POST /api/stores/test` and shows per-store results, including per-package errors. Save writes through `POST /api/stores/accounts` and the page re-fetches state. "Remove" confirms, then calls `DELETE`. Secrets are never displayed after upload.

Server-side rules: key files are written only under `config/secrets/` with names derived from the Key ID (`AuthKey_<KEYID>.p8`) or the account name (`play-<slug>.json`); the `.p8` must be a PEM private key and the JSON a `service_account` key with `client_email` and `private_key`; the new config is validated against the schema before anything is written; the config file is replaced atomically (write temp, rename); after a change the App Store and Play sources are rebuilt from the fresh config, swapped into the scheduler and polled at once, so no restart is needed.

### 4.5 Visual design (approved mockup)

Direction: "ops console". Dense, neutral, one accent colour, monospace for identifiers, colour reserved for status. The approved mockup lives on a private design canvas at https://claude.ai/artifact/XGdR5PzrLSg7j6r1GBbuWP (its source boards were removed from the repo on 2026-09-18 before publishing it, because they carried real names and addresses). The implementation copies the mockup's values; it does not reinterpret them.

**Type**: IBM Plex Sans (400/500/600) for UI text, IBM Plex Mono (400/500) for ticket IDs, PR numbers, repo names, versions, build numbers and timestamps. Fallbacks: Segoe UI / system-ui and Consolas. Fonts are self-hosted from `web/public/fonts/` so the dashboard works offline; no Google Fonts request at runtime. Root font size is the Appearance setting (14 / 16 / 18 px); every other size is in `rem`: panel title 0.9375, row text 0.875, meta and chips 0.8125, tags and group headers 0.75 (group headers uppercase, letter-spacing 0.04em), tiny 0.6875.

**Colour tokens** (CSS variables on `<html>`, switched by `data-theme`):

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#f3f4f6` | `#0e1013` | page background |
| `--surface` | `#ffffff` | `#16191f` | panels, header |
| `--surface2` | `#f7f8fa` | `#1b1f26` | group headers, unread rows |
| `--border` / `--border2` | `#e2e5ea` / `#eceef2` | `#272c36` / `#21252e` | panel border / row dividers |
| `--text` / `--muted` / `--faint` | `#171b22` / `#6a7383` / `#98a0ad` | `#e7e9ee` / `#9aa3b2` / `#6c7584` | text hierarchy |
| `--accent` / `--accent-soft` | `#3557d6` / `#e8edfb` | `#8aa0f7` / `#1d2540` | links, primary button, unread badge and dot, QE tag |
| `--green` / `--green-soft` | `#1f9d55` / `#e3f5ea` | `#3fbf75` / `#12301f` | fresh, passing, finished, Ready for Sale, FEATURE tag |
| `--amber` / `--amber-soft` | `#c9720a` / `#fdf0dc` | `#e39a3a` / `#332612` | stale, review required, waiting/in review, High priority, 24–72 h |
| `--red` / `--red-soft` | `#d63b3b` / `#fce8e8` | `#ef6b6b` / `#3a1717` | error, failed, rejected, > 72 h |
| `--blue` / `--blue-soft` | `#2f6fed` / `#e6eefc` | `#6f9cf7` / `#172440` | building, rollout in progress, Normal priority |
| `--grey-soft` | `#eef0f3` | `#232833` | neutral tags (CHORE, Draft, counts), inactive chips |

Light theme has a 1 px soft shadow on panels (`0 1px 2px rgba(16,24,40,.06)`); dark theme has none.

**Shape and size**: panels 8 px radius with 1 px border; buttons, chips, icon buttons and inputs 6 px radius; tags 4 px; count badges pill. Header 56 px. Icon buttons 32 px (26 px inside panel headers). Primary button 30 px high. Chips 32 px high. Tags 20 px high. Row padding is the Density setting: 10 px vertical (comfortable) or 5 px (compact), always 16 px horizontal. Panel grid gap 20 px, page side padding 24 px.

**Row anatomy**: a 6 px unread dot (accent) at the row start, a fixed-width monospace identifier, a truncating single-line title that takes remaining space, then right-aligned meta and tags. Unread rows also get the `--surface2` background. Priority tags mirror Lark: High = amber, Normal = blue. Task type tags: FEATURE green, CHORE grey, QE accent.

**Icons**: inline stroke SVG on a 24 grid rendered at 12–16 px (refresh, settings, external link, play, download, chevrons, close). No emoji, no icon font.

**Header freshness dots**: 8 px, green when the last fetch is within 2× the source interval, amber when older (label "stale 9m"), red when the last poll errored; each carries a monospace age label.

**Needs-attention chips**: dot + text + optional monospace detail; red for failures and rejections, amber for things awaiting me, blue for informational counts, grey for low-priority state. A building chip's dot pulses (1.4 s opacity animation).

### 4.6 Home layout customizer (added 2026-09-18)

Mockup: https://claude.ai/artifact/MzeBoXEJeYpdj3dL5VnBfP

- **Grid**: six columns, 80 px rows, 20 px gap, `grid-auto-flow: row dense`. A card spans 2, 3, 4 or 6 columns (⅓ ½ ⅔ Full) and either the rows its content needs (Auto: the header-plus-body column is measured with a ResizeObserver and rounded up to whole rows) or a fixed 2–14 rows with the body scrolling inside. Under 1000 px of content width every card is full width in layout order.
- **Layout state** (`web/src/layout/layout.ts`): `{ version: 1, cards: [{ id, w, h, tint, hidden }] }` in display order, one entry per panel (prs, tasks, issues, feedback, builds, stores). Stored in `localStorage` under `dashboard.layout`; unknown ids are dropped and missing ones appended hidden on load. The default reproduces the two-column page with Builds and Stores hidden.
- **Customize mode**: entered from a sliders button beside "Refresh all" on Home; outside it nothing can be dragged or resized. The header then shows a CUSTOMIZING tag, "Reset layout" (back to the default) and "Done". The mode is per session; a reload starts in normal mode. Card bodies dim and ignore clicks while customizing. Each card gets a grip, a size label, a paint button (popover: width, height presets Auto/3/4/6/8, eight tints, "Hide from Home"), a hide button and a corner handle that snaps width and height live. Reorder uses native drag-and-drop: drop on a card to land before or after it (past the card's top-left to bottom-right diagonal counts as after), drop on the grid background to land last. A panel list under the attention strip shows all six panels as toggle chips (filled when shown, dashed when hidden); clicking one shows or hides it. Changes save immediately; locking only leaves the mode.
- **Tints**: none, blue, green, amber, red, purple, teal, pink. `data-tint` on the panel selects the `--th` (header band) and `--tb` (body wash) tokens, defined for light and dark in `styles.css`; the swatch colour is `--tint-<name>-d`.
- **Navigation**: a chip or toast for a panel that is shown on Home goes to Home; otherwise to the panel's own page as before. The sidebar badges are unchanged.

## 5. Sources

### 5.1 GitHub

- Mechanism: spawn `gh api graphql` with a query containing two `search` fields (`type: ISSUE`, `first: 50`):
  - `is:pr is:open review-requested:@me`
  - `is:pr is:open author:@me`
- Per PR: `number, title, url, isDraft, createdAt, updatedAt, author { login avatarUrl }, repository { nameWithOwner }, reviewDecision, commits(last:1) { nodes { commit { statusCheckRollup { state } } } }`.
- Snapshot: `{ incoming: PR[], mine: PR[], login: string }`.
- Startup check: `gh api user -q .login` must equal the configured account (`jennsg`); otherwise the source is disabled with the message "gh active account is X, expected jennsg (run `gh auth switch`)".
- Events: `pr.review_requested` (high) when a PR appears in `incoming`; `pr.review_decision` (normal) when one of mine changes to APPROVED or CHANGES_REQUESTED; `pr.ci_failed` (normal) when one of mine flips to FAILURE/ERROR.

### 5.2 Codemagic

- Mechanism: `fetch` to `https://api.codemagic.io` with header `x-auth-token` from `CODEMAGIC_API_TOKEN`.
  - `GET /apps` → app list with workflows.
  - `GET /builds?appId=…&limit=10` per app (parallel, max 4 at a time).
  - `POST /builds` `{ appId, workflowId, branch }` for triggers.
  - Artifact URLs from the build object are fetched server-side with the token and streamed to the browser.
- Snapshot: `{ apps: { id, name, workflows: {id,name}[], builds: Build[] }[] }` where `Build = { id, workflowId, workflowName, branch, status, startedAt, finishedAt, durationSec, startedBy, url, artifacts: { name, type, size }[] }`.
- Fast interval: 30 s while any build is in a non-terminal status; otherwise 120 s. After a trigger, the source is refreshed immediately.
- Events: `build.failed` (high) on transition to failed/timeout; `build.finished` (normal) on transition to finished. Canceled builds produce no event.

### 5.3 Lark Base

- Mechanism: one `lark-cli base +record-list --base-token <T> --table-id <id> --view-id <id> --as user --limit 500` per table, reading the saved "Jenn" view filter and sort. Pagination handled if the CLI returns a page token.
- Field mapping lives in config (section 7), populated during setup from `lark-cli base +field-list`. Logical fields:
  - tasks: `title, status, pic, type, priority, progress`
  - issues: `ticketId, reportedDate, hoursSince, priority, store, description, status`
  - feedback: `reportedDate, category, store, text`
- Snapshot: `{ tasks: { groups: { status, records }[] }, issues: { groups, counts }, feedback: { records } }` with each record carrying `recordId`, `url`, and the mapped fields as display strings.
- Deep link: `https://<larkDomain>/base/<baseToken>?table=<tableId>&view=<viewId>&record=<recordId>`.
- Events: `issue.opened` (high) when a record appears in the OPEN group; `feedback.new` (normal) when a new feedback record appears. Tasks emit no events in v1.

### 5.4 App Store Connect

- Auth: ES256 JWT signed with the account's `.p8`, `kid` = Key ID, `iss` = Issuer ID, `aud = appstoreconnect-v1`, 15-minute expiry, cached per account.
- Calls per account: `GET /v1/apps` then, per app, `GET /v1/apps/{id}/appStoreVersions?filter[platform]=IOS&limit=3` to obtain the live version (READY_FOR_SALE) and any in-flight version.
- Attention states: `WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE, REJECTED, METADATA_REJECTED, DEVELOPER_REJECTED, INVALID_BINARY`.
- Snapshot per app: `{ appId, name, bundleId, live: { version, state } | null, inflight: { version, state } | null, url }` where `url` is the App Store Connect app page.
- Known limitation: the API exposes the rejected state but not App Review's message text. The panel shows the state and a link to the app's review page. If during implementation an endpoint proves to return the message, it is shown inline; this is verified, not assumed.
- Events: `store.state_changed` for any live/in-flight state change; priority high when the new state is REJECTED, METADATA_REJECTED, DEVELOPER_REJECTED, INVALID_BINARY or PENDING_DEVELOPER_RELEASE; normal otherwise.

### 5.5 Google Play

- Auth: service-account JSON per account → RS256 JWT → OAuth2 access token, scope `https://www.googleapis.com/auth/androidpublisher`, cached until expiry.
- The publishing API has no "list apps" call, so package names are configured per account.
- Calls per package: `edits.insert` → `edits.tracks.list` → `edits.delete`. Tracks read: production, beta, alpha, internal.
- Snapshot per package: `{ packageName, name (from config), tracks: { track, releaseName, versionCodes, status, userFraction }[], url }` where `url` is the configured Play Console link for that app, falling back to the account's app list.
- Known limitation: Play's review state ("In review", "Rejected") is not exposed by the API. Cells show rollout status only, plus the console link.
- Events: `store.state_changed` when any track's release status or release name changes; priority high when status becomes `halted`, normal otherwise.

## 6. Events and alerts

| Kind | Priority | Source |
|---|---|---|
| `pr.review_requested` | high | github |
| `pr.review_decision` | normal | github |
| `pr.ci_failed` | normal | github |
| `build.failed` | high | codemagic |
| `build.finished` | normal | codemagic |
| `issue.opened` | high | lark |
| `feedback.new` | normal | lark |
| `store.state_changed` | high or normal (see 5.4, 5.5) | appstore, playstore |

Alert mode behaviour:

- **Toast**: high-priority events fire `new Notification(title, { body, tag: item_id })`; clicking focuses the tab and scrolls to the item, then marks it seen. Normal events badge only. Needs the tab open; events arriving while it is closed wait as unread badges.
- **Badge**: no notifications. Unread counts per panel header, total in `document.title` as `(N) Dashboard`, and a "new" highlight on unread rows. Clicking a row or the panel's "mark all seen" clears it.
- **Off**: events are still stored but the UI shows no unread state.

The first poll after a fresh database creates no events (there is no previous snapshot to diff against), so installing the dashboard does not produce a flood.

## 7. Configuration and secrets

`config/dashboard.config.json` (committed, no secrets):

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
        "appstore": { "issuerId": "…", "keyId": "…", "keyFile": "secrets/AuthKey_A.p8" },
        "play": {
          "serviceAccountFile": "secrets/play-a.json", "developerId": "1234567890",
          "apps": [ { "packageName": "com.example.app", "name": "SGPOS", "consoleUrl": "https://play.google.com/console/u/0/developers/…/app/…/tracks/production" } ]
        }
      }
    ]
  }
}
```

Field names shown for Lark are the ones visible in the current views and are confirmed against `+field-list` during setup; the status field name for tasks and issues is whatever the view groups by.

`config/secrets/.env`: `CODEMAGIC_API_TOKEN=…`. Key files are referenced by relative path from `config/`. `config/secrets/` and `data/` are gitignored. `dashboard.config.example.json` documents every key.

Startup validation: unknown keys, missing files and unreadable tables are reported per source; that source starts disabled with its message shown in the panel, and the rest of the dashboard runs.

## 8. Error handling

- Sources fail independently. On failure the panel header turns amber with "stale since HH:MM" and a one-line reason; last good data remains visible. Backoff doubles the interval up to 10 min; a manual refresh resets it.
- Auth hints: `gh` non-zero exit mentioning auth → "run `gh auth login`"; `lark-cli` errors mentioning token/permission/login → "run `lark-cli auth login`"; App Store 401 → "App Store key for account X rejected"; Play 401/403 → "Play service account for account X rejected or not invited"; Codemagic 401 → "Codemagic token rejected".
- CLI spawns time out at 60 s and count as failures.
- Build trigger failures return the Codemagic error text, shown inline in the dialog.
- SSE disconnects are retried by the browser with backoff; on reconnect the client re-fetches `/api/state`.

## 9. Testing

- **Unit** (`bun test`): each source has a `parse` step separated from network; tests feed fixture JSON (captured from real responses, secrets and personal data scrubbed) through `parse` and `diff`. Cases: first snapshot yields no events; new item yields event; state change yields event with correct priority; unchanged yields nothing. Scheduler backoff and fast-interval switching tested with fake timers.
- **API**: Hono route tests via `app.request()` against an in-memory SQLite: `/api/state` shape, `seen` marking, trigger route validation.
- **UI**: `shared/attention.ts` tested as a pure function for every chip rule; component tests for ActionStrip and one list panel (render, unread highlight, click marks seen).
- **Live check**: `bun run check` calls every configured source once and prints a table of OK / error per source. Used after setup and whenever a key changes.
- Manual smoke list before calling v1 done: page loads from cache under 1 s; toast fires for a synthetic high event; theme/font/density persist across reload; build trigger starts a real build; artifact downloads.

## 10. Out of scope for v1 (possible later)

- Writing back to Lark (status changes, comments).
- Server-side Windows toasts when no tab is open.
- Store ratings/reviews and crash vitals.
- PRs for the `mobileapp-sitegiant` account or team review requests.
- Auto-start at Windows login (a Task Scheduler entry running `bun run start`).
- Access from a phone.

## 11. Inputs needed at setup

- The three Lark table URLs for the "Jenn" views of R&D Task, Issue Tracker and Merchant Feedback (they contain base token, table id, view id).
- Codemagic API token.
- Per developer account: App Store Connect API key (`.p8`, Key ID, Issuer ID); Google Play service-account JSON invited to that Play Console account, plus the package names and console URLs to watch.
