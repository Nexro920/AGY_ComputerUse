# AGY Chrome Use Routing & Guardrails

## Priority Browser Routing
- When the user provides a URL (`http://`, `https://`, `localhost:...`), a domain/host+port (e.g., `github.com`, `127.0.0.1:8080`), or asks to open, read, inspect, click, type, scroll, or interact with a web page or active Chrome tab—and has **not** explicitly specified another browser tool or plugin—**prioritize `agy-chrome-use`** (`cua_exec`, `cua_status`, `cua_reset`) over the built-in `browser` subagent and `chrome-devtools`.
- Normalize bare domains to `https://<domain>` (or `http://` for `localhost` / local IPs) when calling `cua.goto(...)`.
- Exceptions:
  - The user explicitly asks to use `chrome-devtools`, `browser` subagent, `curl`, or `search_web`.
  - The user only asks a general factual question or wants static API/CLI work without opening Chrome.

## First-Use Authorization
- On the very first call, if `cua_exec` reports `AUTHORIZATION_REQUIRED`, prompt the user directly in the conversation (preferring the interactive `ask_question` confirmation card when available) explaining clearly in plain language that `agy-chrome-use` will connect to Chrome (prioritizing an open Chrome window via CDP, or opening a managed Chrome window) and perform clicking, typing, and scrolling, and that this is a one-time approval remembered for future sessions. Once confirmed, immediately call `cua_authorize` (`{"confirm": true}`) and continue the task. Subsequent sessions and calls will proceed without prompting again.

## Execution Discipline & Human Handoff
- **Batch & Clean Release**: Batch related steps (`goto`, `snapshot`, `click`, `type`, `scroll`, `waitFor`, `screenshot`) inside a single `cua_exec` script instead of making one tool call per action. As soon as your browser actions for the current turn are finished, call `cua_reset` with `{"scope": "control"}` so HUD overlays disappear immediately (while keeping managed windows open and keeping `chrome://inspect/#remote-debugging` authorized across turns).
- Load the `cua-repl` skill for the full `cua.*` SDK reference before writing complex scripts.
- **Human handoff**: Stop immediately, call `cua_reset` with `{"scope": "control"}` (which immediately hides HUD overlays for human interaction while preserving `managed-profile` windows and keeping an authorized `chrome://inspect/#remote-debugging` session from re-prompting on resume), and clearly tell the user what manual step is needed in Chrome whenever encountering:
  - CAPTCHAs / anti-bot challenges,
  - Login password entry or 2FA/SMS/MFA prompts requiring user credentials, or
  - Payment, deletion, or other sensitive confirmations.
  Once the user confirms they completed the step, resume with `cua_exec`.
- If a page requires the user's personal logged-in session and `cua_status` shows `managed-profile`, mention briefly that they can either sign in once in the managed Chrome window (persisted across sessions) or enable `chrome://inspect/#remote-debugging` in their main Chrome window.
