# agy-chrome-use

Stateful Chrome browser REPL plugin (`cua_exec`) for **Google Antigravity (AGY)**.

## Features

- **Persistent REPL (`cua_exec`)**: Executes multi-step async JavaScript in a sandboxed `node:vm` context with persistent `state` and `cua.*` helpers, compressing multi-turn browser interactions into a single tool call.
- **Open-Chrome-First Connection**:
  1. Probes `AGY_CHROME_CDP_URL` (default `http://127.0.0.1:9222`) and Playwright's `chrome` remote-debugging channel to attach to an already-open Chrome window.
  2. Falls back cleanly to launching a visible Chrome window with a persistent managed profile (`PLUGIN_DATA/chrome-profile`) when remote debugging is not enabled.
- **One-Time First-Use Authorization**: Prompts for explicit user approval on the very first `cua_exec` call and persists authorization in `PLUGIN_DATA/auth.json` so subsequent sessions run without re-prompting.
- **Semantic Tree + Visual HUD**: Extracts a pruned interactive element tree with `[e1]` refs and bounding boxes (masking `input[type="password"]`), drives real pointer/keyboard/wheel events, and renders a non-intrusive Shadow DOM cursor/highlight/ripple HUD.
- **AGY Priority Routing**: Bundled `rules/AGENTS.md` and `skills/cua-repl/SKILL.md` instruct AGY to prioritize `agy-chrome-use` whenever a user shares a URL without specifying another browser plugin.

## Build & Test

```powershell
npm install
npm test
```

## Install into AGY (Local Plugin Directory)

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1
```

To uninstall on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1 -Uninstall
```

macOS / Linux (Bash):

```bash
bash ./scripts/install-local.sh
# Uninstall: bash ./scripts/install-local.sh --uninstall
```

## Optional: Launch Chrome with CDP Enabled

If you want `agy-chrome-use` to attach directly to your open Chrome window on port `9222`:

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-chrome-debug.ps1
```

macOS / Linux (Bash):

```bash
bash ./scripts/launch-chrome-debug.sh
```

Or enable Chrome's built-in remote debugging toggle at `chrome://inspect/#remote-debugging`.
