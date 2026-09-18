# NexPulse

One local page for the daily round: pull requests to review, Codemagic builds, Lark tasks, merchant issues and feedback, and App Store / Play Store release state across three developer accounts. Runs as a single Bun process on this PC; nothing is hosted anywhere.

Design spec: `docs/superpowers/specs/2026-09-17-personal-dashboard-design.md`. The visual mockups live on a private design canvas linked from the spec; nothing in this repo depends on them at build time.

**New here?** [SETUP.md](SETUP.md) walks through requirements, a one-shot install script and running at startup. In short:

```sh
git clone https://github.com/jennz01/nexpulse.git
cd nexpulse
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1   # from PowerShell
bash scripts/setup.sh                                                    # from Git Bash
```

The stack is Bun + Hono on the server and React + Vite on the web side (no Next.js); the sections below describe each setting in detail.

## Prerequisites

- Bun 1.3+ (`bun --version`)
- Node.js 16 or newer with npm (`node --version`), only to install and run lark-cli; the build and dev server run on Bun
- GitHub CLI (`gh`). Sign in from the dashboard's Settings → Connections or with `gh auth login`; the login it signs in as is saved to `github.account` in the config the first time (set it yourself only to pin a different account)
- lark-cli 1.0.49+. Once per PC it needs its app configuration (`lark-cli config init --brand lark`, with the team's App ID and App Secret, or `--new` for an app of your own); then sign in from Settings → Connections or with `lark-cli auth login`
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

The Merchant Feedback view must be sorted newest-first in Lark; the dashboard shows the view's first rows as the newest.

Confirm the field names the dashboard maps (they are the column headers; the `status` field is the one each view groups by):

```bash
lark-cli base +field-list --base-token <baseToken> --table-id <tableId> --format json --as user
```

Edit `fields.*` in each table block if a header differs from the example. `tasks.pendingLaunchStatus`, `tasks.collapsedStatuses` and `issues.showStatuses` must match the exact option text in Lark.

`tasks.createFormUrl` (optional) is the share link of a Lark Base form that adds a row to R&D Task (Base → the table → Form view → Share). When it is set, the Tasks panel shows a "Create task" button that opens the form in a new tab; remove the key to hide the button.

Optional columns feed the Issues and Merchant Feedback rows and their detail dialogs: `issues.fields.reportedBy`, `taggedPic`, `modulePic` and `attachments`; `feedback.fields.rid`, `status`, `pic`, `reportedBy`, `taskLink` and `attachments`. Each value is a column header; leave a key out and that detail simply does not show. Columns named here are fetched even when the Jenn view hides them. `feedback.groupOrder` lists the R&D statuses whose groups come first; other statuses follow in order of first appearance. Attachments are downloaded through lark-cli on first open and cached under `data/attachments/`. In the detail dialog they open in a viewer: images zoom and pan, MP4/WebM/MOV videos play in the browser's player, PDFs render in the browser's document viewer, and anything else offers a download. Only those types are served inline; other files always download.

### Codemagic

Codemagic → Teams → Personal Account → Integrations → Codemagic API → copy the token. Create `config/secrets/.env`:

```
CODEMAGIC_API_TOKEN=your-token
```

Set `codemagic.enabled` to `false` to switch the panel off instead.

### Store accounts: the easy way

Open the dashboard, go to **Settings → Store accounts → Add account**, and pick the `.p8` and service-account JSON files in the form. The dashboard writes them into `config/secrets/`, updates `dashboard.config.json` and starts polling immediately; "Test connection" tries the credentials before you save. Edit and Remove live in the same list. The two sections below describe where to get the keys and what the config looks like if you prefer to edit it by hand.

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

Until credentials are added, the App Store and Play rows of `bun run check` read DISABLED with the reason; that is expected.

Run all commands from the repository root (static files resolve against the working directory).

The sidebar switches between three pages, each with its own URL: Home (`#/`, pull requests and the Lark panels), Builds (`#/builds`, Codemagic) and Stores (`#/stores`, App Store Connect and Google Play). The collapse button at the bottom of the sidebar is remembered along with the appearance settings.

## Auto-start at login

`bun run build` once, then `bun run startup:install`. That registers a Windows scheduled task named **NexPulse** for your user: at every sign-in (15 s after logon) it pulls the latest code (`git pull --ff-only`, rebuilding if anything changed, skipped over local changes; `startup:install -NoUpdate` turns this off) and then runs `bun server/index.ts` with no window, restarts it if it exits, and never times out. Install also starts it right away, so http://127.0.0.1:6600 is up from then on. No admin rights are needed, and the task runs only while you are logged in, so `gh` and `lark-cli` keep using your logins.

| Command | What it does |
|---|---|
| `bun run startup:status` | Task state, last result, whether the server is listening |
| `bun run startup:restart` | Pull the latest code (fast-forward only), rebuild if anything changed, then start again; also picks up a hand-edited config. `-NoUpdate` restarts without pulling |
| `bun run update` | The same pull and rebuild without touching the task, for a PC that runs the server by hand |
| `bun run startup:stop` | Free port 6600 before `bun run dev`; the task comes back at next logon or with `startup:restart` |
| `bun run startup:uninstall` | Remove the task |

Server output goes to `data/server.log`; the previous session's log is kept as `data/server.prev.log`. A PowerShell window may flash for a moment at logon before it hides. The scripts live in `scripts/serve.ps1` (the supervisor) and `scripts/startup.ps1` (task management).
## Settings

Settings is the last item in the sidebar.

**Connections** shows the three logins the sources depend on and lets you fix them without a terminal. GitHub and Lark are the `gh` and `lark-cli` sign-ins on this PC: each row says who is signed in (and, for Lark, until when the session renews itself) with an Authorize / Re-authorize button that runs the CLI's own device-code sign-in for you: copy the one-time code, open the verification page, approve, and the panel refreshes on its own. If `gh` is signed in as a different account than `github.account`, a Switch button runs `gh auth switch`. Codemagic takes its API token here: Set token → paste → Test → Save writes it to `config/secrets/.env` and starts polling at once; Remove clears it. Status is re-checked every five minutes, when the window regains focus, and as soon as a poll fails with an authorization error. When a session has expired, a red bar under the header on every page says which panels stopped updating and offers Re-authorize; an amber bar warns when the Lark session ends within two days.

**Pull requests** picks the repositories behind the Pull Requests panel's **All** tab. The card lists every repository the signed-in `gh` account can see (owned, collaborator or organization member), newest push first, with its open PR count; tick up to 50 and Save. The selection is written to `github.repos` in the config and polled immediately, so on a shared team setup each person's dashboard shows their own repositories. Review requested and Mine are unaffected and always cover everything the account can see; a repository that is later renamed or lost only drops out of the All tab.

Alerts: Windows toast (native notification for high-priority events; needs one-time permission), in-page badges only, or off. Appearance: theme light / dark / auto, font size small / medium / large, density comfortable / compact. Stored per browser.

## Customizing the Home page

Click the sliders button next to "Refresh all" on Home to enter customize mode; outside it nothing can be dragged or resized. Drag a card by its header to reorder it; drag the corner handle to snap its width to ⅓, ½, ⅔ or full and its height to 80 px rows (a fixed height scrolls inside the card, Auto follows the content). The paint button opens width and height presets, eight tints and "Hide from Home". A panel list under the attention strip shows all six panels while customizing: click one to show or hide it on Home, which is also how Builds and Stores get onto Home. Hidden panels keep their own page. Done leaves the mode; Reset layout restores the original two-column page. The layout is saved in the browser next to the appearance settings, so it is per browser profile.

## When something goes amber or red

The header dot and the panel label say why. Common fixes:

- "run `gh auth login`" or "gh active account is X" → `gh auth login` / `gh auth switch --user <your account>`, then Refresh.
- "run `lark-cli auth login`" → the user token expired; log in again.
- "Codemagic token rejected" → regenerate the token and update `config/secrets/.env`, restart.
- "App Store key for account X rejected" → the key was revoked or the Issuer/Key ID is wrong for that account.
- "Play service account for account X rejected or not invited" → invite the service-account email in that Play Console and grant app access.
- "lark config still has placeholder ids" → finish the Lark section above.

Poll intervals are in `config/dashboard.config.json` → `polling` (seconds). Backoff doubles after each failed poll, up to 10 minutes; Refresh resets it.

## Testing alerts by hand

Start with `DASHBOARD_DEV=1` (PowerShell: `$env:DASHBOARD_DEV='1'; bun run start`) and post a synthetic event:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:6600/api/dev/emit -ContentType 'application/json' -Headers @{ 'x-requested-with' = 'dashboard' } -Body '{"source":"github","kind":"pr.review_requested","priority":"high","title":"Synthetic"}'
```

Every POST to the API must carry `x-requested-with: dashboard`; browsers block cross-site pages from adding it.

## Not in this version

Writing back to Lark, server-side toasts when no tab is open, store ratings and crash data, the `mobileapp-sitegiant` GitHub account, phone access. See spec §10.
