# agy-chrome-use

Stateful Chrome browser REPL plugin (`cua_exec`) for **Google Antigravity (AGY)**.

## Features

- **Foolproof Pre-Flight Check & One-Click Install**: Verifies Node.js (`>= 20`), `npm`, and Google Chrome before installing; refuses installation with clear diagnostics if missing, or installs missing prerequisites automatically on user confirmation / `-AutoInstall` / `--auto-install`, then installs dependencies, builds, registers the plugin, and verifies the MCP server handshake.
- **Automatic URL & Browser Routing**: Bundled `rules/AGENTS.md` and `skills/cua-repl/SKILL.md` instruct AGY to automatically invoke `agy-chrome-use` whenever you share a URL, domain, or ask to interact with a web page / active Chrome tab.
- **One-Time First-Use Authorization**: Prompts once for explicit approval on the first `cua_exec` call and saves it in `PLUGIN_DATA/auth.json` for all future sessions.
- **Open-Chrome-First Connection**:
  1. Attaches to an already-open Chrome window via CDP (`AGY_CHROME_CDP_URL`, default `http://127.0.0.1:9222`, or Chrome's built-in `chrome://inspect/#remote-debugging` channel).
  2. Falls back automatically to a visible persistent managed Chrome window (`PLUGIN_DATA/chrome-profile`) when remote debugging is not enabled.
- **Safe Human Handoff**: Automatically stops and hands control back to you (via `cua_reset({ scope: "control" })` without closing managed windows) whenever encountering login passwords, 2FA/MFA, CAPTCHAs, or sensitive payment/destructive confirmations.
- **Hardened Sandbox + Semantic Tree + Visual HUD**: Runs scripts in an isolated `worker_threads` + `node:vm` sandbox, masks `input[type="password"]` as `***`, checks Shadow DOM occlusion, blocks SSRF/unsafe redirects, and hides transient HUD overlays + releases CDP banner automatically at turn end.

---

## Quick Install (Zero-Clone One-Liner)

### Windows (PowerShell)

Interactive (checks environment first; asks before auto-installing missing Node.js / Chrome):

```powershell
irm https://raw.githubusercontent.com/Nexro920/AGY_ComputerUse/main/scripts/bootstrap.ps1 | iex
```

Unattended one-click auto-install (automatically installs missing Node.js LTS / Chrome via `winget` + builds + verifies):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Nexro920/AGY_ComputerUse/main/scripts/bootstrap.ps1))) -AutoInstall
```

### macOS / Linux (Bash)

Interactive:

```bash
curl -fsSL https://raw.githubusercontent.com/Nexro920/AGY_ComputerUse/main/scripts/bootstrap.sh | bash
```

Unattended one-click auto-install:

```bash
curl -fsSL https://raw.githubusercontent.com/Nexro920/AGY_ComputerUse/main/scripts/bootstrap.sh | bash -s -- --auto-install
```

---

## Install from Local Clone

```bash
git clone https://github.com/Nexro920/AGY_ComputerUse.git
cd AGY_ComputerUse
```

**Windows (PowerShell):**

```powershell
# Check environment only (no changes)
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -CheckOnly

# Install (checks environment first; prompts or refuses if prerequisites missing)
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1

# Install + auto-install missing Node.js / Chrome via winget
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -AutoInstall

# Uninstall (preserves auth & chrome-profile; add -PurgeData to delete all data)
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -Uninstall
```

**macOS / Linux (Bash):**

```bash
# Check environment only
bash ./scripts/install-local.sh --check-only

# Install (checks environment first; prompts or refuses if prerequisites missing)
bash ./scripts/install-local.sh

# Install + auto-install missing prerequisites (Homebrew / apt / dnf)
bash ./scripts/install-local.sh --auto-install

# Uninstall (add --purge-data to also delete auth & chrome-profile)
bash ./scripts/install-local.sh --uninstall
```

---

## How First Use Works

1. Send any browser prompt in AGY (e.g. `Open https://github.com and check trending`).
2. On the very first run, AGY will pause and ask you to approve one-time authorization. Confirm once, and it is persisted for future sessions.
3. By default, if Chrome remote debugging isn't enabled, AGY opens a visible **managed Chrome window** whose cookies/logins persist across sessions.
4. **Optional — Reuse your existing logged-in Chrome window**:
   - In Chrome 136+, open `chrome://inspect/#remote-debugging` and turn on remote debugging (click **Allow** on the first connection prompt), **or**
   - Launch a CDP-enabled Chrome window:
     - Windows: `powershell -ExecutionPolicy Bypass -File .\scripts\launch-chrome-debug.ps1`
     - macOS / Linux: `bash ./scripts/launch-chrome-debug.sh`
5. When a page requires passwords, 2FA, CAPTCHAs, or payments, AGY pauses and releases control so you can complete the step safely in Chrome, then continue by replying to AGY.

## Development & Tests

```bash
npm install
npm test
```
