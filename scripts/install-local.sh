#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/agy-chrome-use"
SETUP_SCRIPT="${SCRIPT_DIR}/setup.mjs"

UNINSTALL=0
PURGE_DATA=0
CHECK_ONLY=0
AUTO_INSTALL=0
NO_VERIFY=0

for arg in "$@"; do
  case "${arg}" in
    --uninstall|-u) UNINSTALL=1 ;;
    --purge-data) PURGE_DATA=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    --auto-install) AUTO_INSTALL=1 ;;
    --no-verify) NO_VERIFY=1 ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 1
      ;;
  esac
done

get_node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

find_chrome_bin() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    for c in \
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "${HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
      "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
      if [[ -x "${c}" ]]; then
        echo "${c}"
        return
      fi
    done
  else
    for bin in google-chrome google-chrome-stable chromium chromium-browser; do
      if command -v "${bin}" >/dev/null 2>&1; then
        command -v "${bin}"
        return
      fi
    done
  fi
  echo ""
}

if [[ "${UNINSTALL}" -eq 1 ]]; then
  NODE_MAJOR="$(get_node_major)"
  if [[ "${NODE_MAJOR}" -ge 20 ]] && [[ -f "${SETUP_SCRIPT}" ]]; then
    ARGS=("${SETUP_SCRIPT}" "--uninstall" "--runtime-root" "${PLUGIN_ROOT}")
    if [[ "${PURGE_DATA}" -eq 1 ]]; then ARGS+=("--purge-data"); fi
    exec node "${ARGS[@]}"
  fi
  if [[ -L "${TARGET_DIR}" ]]; then
    rm -f "${TARGET_DIR}"
    echo "Removed plugin symlink at ${TARGET_DIR}"
  elif [[ -d "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
    echo "Removed plugin directory at ${TARGET_DIR}"
  else
    echo "Plugin directory not found at ${TARGET_DIR}"
  fi
  exit 0
fi

NODE_MAJOR="$(get_node_major)"
HAS_NPM=0
if command -v npm >/dev/null 2>&1; then HAS_NPM=1; fi
CHROME_BIN="$(find_chrome_bin)"

if [[ "${NODE_MAJOR}" -lt 20 || "${HAS_NPM}" -ne 1 || -z "${CHROME_BIN}" ]]; then
  echo "=== AGY Chrome Use Pre-Flight Check ==="
  if [[ "${NODE_MAJOR}" -ge 20 ]]; then
    echo "Node.js (>=20): [OK] $(node -v)"
  elif command -v node >/dev/null 2>&1; then
    echo "Node.js (>=20): [FAIL] $(node -v) is too old"
  else
    echo "Node.js (>=20): [FAIL] not installed"
  fi
  if [[ "${HAS_NPM}" -eq 1 ]]; then
    echo "npm:            [OK]"
  else
    echo "npm:            [FAIL] not installed"
  fi
  if [[ -n "${CHROME_BIN}" ]]; then
    echo "Google Chrome:  [OK] ${CHROME_BIN}"
  else
    echo "Google Chrome:  [FAIL] not installed"
  fi

  if [[ "${CHECK_ONLY}" -eq 1 ]]; then
    echo ""
    echo "[REFUSED] Environment check failed. Install prerequisites or run with --auto-install." >&2
    exit 1
  fi

  if [[ "${AUTO_INSTALL}" -ne 1 && -r /dev/tty ]]; then
    printf "Environment requirements are not met. Attempt automatic installation now? [y/N] "
    read -r ANS </dev/tty || ANS=""
    if [[ "${ANS}" =~ ^([yY]|[yY][eE][sS])$ ]]; then
      AUTO_INSTALL=1
    fi
  fi

  if [[ "${AUTO_INSTALL}" -ne 1 ]]; then
    echo ""
    echo "[REFUSED] Installation aborted because required environment is missing." >&2
    echo "Re-run with --auto-install or install Node.js >= 20 (https://nodejs.org/) and Google Chrome (https://www.google.com/chrome/)." >&2
    exit 1
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "[ERROR] Homebrew is required for --auto-install on macOS. Install from https://brew.sh or install Node.js >= 20 and Chrome manually." >&2
      exit 1
    fi
    if [[ "${NODE_MAJOR}" -lt 20 || "${HAS_NPM}" -ne 1 ]]; then
      brew install node
    fi
    if [[ -z "${CHROME_BIN}" ]]; then
      brew install --cask google-chrome
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    SUDO=""
    if [[ "$(id -u)" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
    if [[ "${NODE_MAJOR}" -lt 20 || "${HAS_NPM}" -ne 1 ]]; then
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | ${SUDO} -E bash -
      fi
      ${SUDO} apt-get update
      ${SUDO} apt-get install -y nodejs
    fi
    if [[ -z "${CHROME_BIN}" ]]; then
      ${SUDO} apt-get update
      ${SUDO} apt-get install -y chromium || ${SUDO} apt-get install -y chromium-browser
    fi
  elif command -v dnf >/dev/null 2>&1; then
    SUDO=""
    if [[ "$(id -u)" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
    if [[ "${NODE_MAJOR}" -lt 20 || "${HAS_NPM}" -ne 1 ]]; then
      ${SUDO} dnf install -y nodejs
    fi
    if [[ -z "${CHROME_BIN}" ]]; then
      ${SUDO} dnf install -y chromium
    fi
  else
    echo "[ERROR] Unsupported package manager for --auto-install. Install Node.js >= 20 and Google Chrome manually." >&2
    exit 1
  fi

  NODE_MAJOR="$(get_node_major)"
  HAS_NPM=0
  if command -v npm >/dev/null 2>&1; then HAS_NPM=1; fi
  CHROME_BIN="$(find_chrome_bin)"
  if [[ "${NODE_MAJOR}" -lt 20 || "${HAS_NPM}" -ne 1 || -z "${CHROME_BIN}" ]]; then
    echo "[ERROR] Automatic prerequisite installation did not satisfy all requirements." >&2
    exit 1
  fi
fi

ARGS=("${SETUP_SCRIPT}" "--runtime-root" "${PLUGIN_ROOT}")
if [[ "${CHECK_ONLY}" -eq 1 ]]; then ARGS+=("--check-only"); fi
if [[ "${NO_VERIFY}" -eq 1 ]]; then ARGS+=("--no-verify"); fi

exec node "${ARGS[@]}"
