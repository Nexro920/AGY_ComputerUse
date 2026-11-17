#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-9222}"
if [[ "$(uname -s)" == "Darwin" ]]; then
  DEFAULT_PROFILE="${HOME}/Library/Application Support/Google/Chrome/AgyDebugProfile"
else
  DEFAULT_PROFILE="${XDG_CONFIG_HOME:-${HOME}/.config}/google-chrome-agy-debug"
fi
USER_DATA_DIR="${2:-${DEFAULT_PROFILE}}"

if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "Chrome CDP is already listening on http://127.0.0.1:${PORT}"
    exit 0
  fi
fi

CHROME_BIN=""
if [[ "$(uname -s)" == "Darwin" ]]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if [[ -x "${candidate}" ]]; then
      CHROME_BIN="${candidate}"
      break
    fi
  done
else
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      CHROME_BIN="$(command -v "${candidate}")"
      break
    fi
  done
fi

if [[ -z "${CHROME_BIN}" ]]; then
  echo "Chrome/Chromium binary not found in standard locations." >&2
  exit 1
fi

mkdir -p "${USER_DATA_DIR}"
nohup "${CHROME_BIN}" \
  --remote-debugging-port="${PORT}" \
  --user-data-dir="${USER_DATA_DIR}" \
  >/dev/null 2>&1 &

echo "Launched Chrome (${CHROME_BIN}) with CDP on http://127.0.0.1:${PORT} (profile: ${USER_DATA_DIR})"
