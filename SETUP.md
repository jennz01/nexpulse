# Setup guide

This guide takes a fresh Windows PC from nothing to a dashboard that starts itself at every sign-in. It is written for someone who has never seen the project. If you only want the short version: install Git, clone the repo, run `scripts\setup.ps1`, then fill in the config it created.

## What you are installing

The dashboard is one local web app. A **Bun** server (`server/`) polls GitHub, Codemagic, Lark Base and the App Store / Google Play APIs on a timer, keeps the results in a small SQLite file under `data/`, and pushes changes to the browser over server-sent events. The page itself (`web/`) is **React**, built once with **Vite** into static files that the same Bun server serves at http://127.0.0.1:6600. There is no Next.js, no database server and no hosting: everything runs on your own PC, under your own logins, and nothing leaves it except the API calls to those services.

Two external command-line tools do the talking to GitHub and Lark, so the dashboard never stores those passwords:

| Tool | Used for | Installed by |
|---|---|---|
| GitHub CLI (`gh`) | pull requests you review and open | winget |
| lark-cli (`lark-cli`) | the R&D Task, Issue Tracker and Merchant Feedback tables, and issue attachments | npm (needs Node.js) |

## Requirements

| Requirement | Why | Notes |
|---|---|---|
| Windows 10 or 11 | the start-at-logon task uses Task Scheduler and PowerShell 5.1, both built in | the server itself also runs on macOS and Linux under Bun, but the startup scripts are Windows only |
| Git | to clone and update the repo | `winget install Git.Git` |
| Bun 1.3 or newer | runtime, package manager, test runner, SQLite | `winget install Oven-sh.Bun` |
| Node.js LTS with npm | only to install and run lark-cli | `winget install OpenJS.NodeJS.LTS` |
| GitHub CLI 2.40 or newer | GitHub source | `winget install GitHub.cli` |
| lark-cli 1.0.49 or newer | Lark source | `npm install -g @larksuite/cli` |
| winget | lets the setup script install the tools above | built into Windows 10 1709+ and Windows 11 |

Accounts and credentials, all optional except the first two:

| Account | Needed for | Where to get it |
|---|---|---|
| A GitHub account | Pull Requests panel | `gh auth login` during setup |
| A Lark account with access to the Base | Tasks, Issues, Merchant Feedback | `lark-cli auth login` during setup |
| Codemagic API token | Builds panel | Codemagic → Teams → Personal Account → Integrations → Codemagic API |
| App Store Connect API key (`.p8`) | Stores panel, iOS column | App Store Connect → Users and Access → Integrations → Team Keys |
| Google Play service account (JSON) | Stores panel, Android column | Google Cloud Console → IAM → Service Accounts, then invite it in Play Console |

## Quick start (automated)

1. Open **Windows PowerShell** (not as administrator; nothing here needs it).
2. Clone the repo and run the setup script:

   ```powershell
   git clone https://github.com/jennz01/my-dashboard.git
   cd my-dashboard
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1
   ```

   If Git is not installed yet, install it first with `winget install Git.Git`, open a new PowerShell window, and repeat.

3. Follow the prompts. The script:
   - checks for Git, Bun, GitHub CLI, Node.js and lark-cli and installs whatever is missing (winget for the tools, npm for lark-cli);
   - runs `bun install`;
   - creates `config\dashboard.config.json` from the example if you have none, and a `config\secrets\.env` template;
   - signs you in to GitHub and Lark when needed (each opens a browser window) and writes your GitHub login into the config;
   - builds the UI, runs `bun run check` to call every source once, and registers the start-at-logon task, which also starts the server right away.

4. Open http://127.0.0.1:6600. The Pull Requests panel already works. The Lark panels need the table ids from the next section, and Builds and Stores need their credentials; until then those rows read DISABLED in `bun run check`, which is expected.

Re-running the script is safe: every step checks before it changes anything. Two switches exist: `-NoStartup` does everything except the logon task, `-NoBuild` skips the UI build for a machine that will use `bun run dev` instead.

Already have Bun? `bun run setup` runs the same script.

## Configure

All settings live in `config\dashboard.config.json` (never committed) and `config\secrets\` (never committed). The README's "First-time setup" section describes every key; the short list:

1. **Lark Base** (`lark`): open each "Jenn" view in Lark and copy its URL, `https://<domain>/base/<baseToken>?table=<tableId>&view=<viewId>`. Put the domain, base token and the three table/view id pairs into `lark.domain`, `lark.baseToken` and `lark.tables.tasks|issues|feedback`. The `fields` blocks map the dashboard's names to your column headers; list your columns with `lark-cli base +field-list --base-token <baseToken> --table-id <tableId> --format json --as user` and change any header that differs. Optional columns (reporter, PIC, attachments, form link, feedback status grouping) are documented in the README.
2. **Codemagic**: paste the token into `config\secrets\.env` as `CODEMAGIC_API_TOKEN=...` (the setup script left a commented line for it), or set `codemagic.enabled` to `false`.
3. **Stores**: easiest from the running dashboard, Settings → Store accounts → Add account, which stores the key files under `config\secrets\` and updates the config for you.

After any config change: `bun run check` to confirm, then `bun run startup:restart` so the running server picks it up.

## Run at startup

`bun run startup:install` (the setup script already did this) registers a Windows scheduled task named **PersonalDashboard** for your user. At every sign-in, 15 seconds after logon, it runs the server hidden, restarts it if it exits, and never times out. It runs only while you are logged in, so `gh` and `lark-cli` keep using your logins. No admin rights are involved.

| Command | What it does |
|---|---|
| `bun run startup:status` | task state, last result, whether port 6600 is listening |
| `bun run startup:restart` | restart after `bun run build` or a config edit |
| `bun run startup:stop` | stop the server (frees port 6600 for `bun run dev`) |
| `bun run startup:uninstall` | remove the task |

Server output goes to `data\server.log`. If the page shows "reconnecting…" for more than a minute, check that log and `bun run startup:status`.

## Update to a newer version

```powershell
cd my-dashboard
git pull
bun install
bun run build
bun run startup:restart
```

## Manual steps (if the script cannot run)

```powershell
winget install Git.Git Oven-sh.Bun GitHub.cli OpenJS.NodeJS.LTS   # open a new window afterwards
npm install -g @larksuite/cli
git clone https://github.com/jennz01/my-dashboard.git
cd my-dashboard
bun install
copy config\dashboard.config.example.json config\dashboard.config.json   # then edit it
gh auth login
lark-cli auth login
bun run build
bun run check
bun run startup:install
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `running scripts is disabled on this system` | PowerShell's execution policy. Run the script exactly as shown, with `-ExecutionPolicy Bypass`; nothing is changed permanently. |
| `winget` is not recognised | Install "App Installer" from the Microsoft Store, or install the tools by hand (Manual steps). |
| A tool installs but the script says it is not on PATH | Close the terminal, open a new one, run the script again. |
| `bun run check` says `gh active account is X, expected Y` | The config's `github.account` must be the login `gh` is signed in as: edit the config, or open the dashboard's Settings → Connections and click Switch. |
| Lark rows say `run lark-cli auth login`, or a red bar says a session expired | Open Settings → Connections and click Re-authorize (or run `lark-cli auth login` / `gh auth login` yourself). Lark sessions renew themselves for about a week of regular use, then need this once. |
| Builds panel is off | Settings → Connections → Codemagic → Set token, or put `CODEMAGIC_API_TOKEN=` in `config\secrets\.env`. |
| `Failed to start server. Is port 6600 in use?` | Something else owns the port, usually a previous server. `bun run startup:status` shows the owner; `bun run startup:restart` replaces it. Change `server.port` in the config if you need another port. |
| Pull Requests panel is empty | Fine when nothing awaits you; `bun run check` shows the counts it found. |
| App Store or Play rows DISABLED | Expected until credentials are added under Settings → Store accounts. |

## Uninstall

`bun run startup:uninstall` removes the logon task. Delete the folder to remove everything else; the only files outside it are the tools you installed and the `gh` and `lark-cli` logins in your user profile.
