# AGY Chrome Use Routing & Guardrails

## Priority Browser Routing
- When the user provides a URL (`http://`, `https://`, `localhost:...`) or asks to open, read, click, type, scroll, or interact with a web page—and has **not** explicitly specified another browser tool or plugin—**prioritize `agy-chrome-use`** (`cua_exec`, `cua_status`, `cua_reset`) over the built-in `browser` subagent and `chrome-devtools`.
- Exceptions:
  - The user explicitly asks to use `chrome-devtools`, `browser` subagent, `curl`, or `search_web`.
  - The user only asks a general factual question or wants static API/CLI work without opening Chrome.

## First-Use Authorization
- On the very first call, if `cua_exec` reports `AUTHORIZATION_REQUIRED`, prompt the user directly in the conversation (preferring the interactive `ask_question` confirmation card when available) to authorize `agy-chrome-use` to connect to Chrome (preferring an already-open Chrome window over CDP, or launching a managed Chrome window) and click/type/scroll on pages. Once confirmed, immediately call `cua_authorize` (`{"confirm": true}`) and continue the task. Subsequent sessions and calls will proceed without prompting again.

## Execution Discipline
- Batch related steps (`goto`, `snapshot`, `click`, `type`, `scroll`, `waitFor`, `screenshot`) inside a single `cua_exec` script instead of making one tool call per action.
- Load the `cua-repl` skill for the full `cua.*` SDK reference before writing complex scripts.
- Stop and hand control back to the user whenever encountering CAPTCHAs, 2FA/login prompts requiring user credentials, or sensitive financial/destructive confirmations.
- When a browser task finishes (or when handing control back to the user), call `cua_reset` with `{"scope": "browser"}` if you want to immediately clear Chrome's CDP control banner (`Stop` hook also automatically releases control when the turn ends).
