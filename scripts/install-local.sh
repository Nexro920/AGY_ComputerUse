#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/agy-chrome-use"

UNINSTALL=0
for arg in "$@"; do
  case "${arg}" in
    --uninstall|-u)
      UNINSTALL=1
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 1
      ;;
  esac
done

if [[ "${UNINSTALL}" -eq 1 ]]; then
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

(
  cd "${PLUGIN_ROOT}"
  npm run build
)

mkdir -p "${TARGET_DIR}"
cp -f "${PLUGIN_ROOT}/plugin.json" "${TARGET_DIR}/plugin.json"

node -e '
const fs = require("fs");
const path = require("path");
const pluginRoot = process.argv[1];
const targetDir = process.argv[2];
const cfgPath = path.join(pluginRoot, "mcp_config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
if (cfg.mcpServers && cfg.mcpServers["agy-chrome-use"]) {
  cfg.mcpServers["agy-chrome-use"].env = cfg.mcpServers["agy-chrome-use"].env || {};
  cfg.mcpServers["agy-chrome-use"].env.AGY_CHROME_RUNTIME_ROOT = pluginRoot;
}
fs.writeFileSync(path.join(targetDir, "mcp_config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
' "${PLUGIN_ROOT}" "${TARGET_DIR}"

if [[ -f "${PLUGIN_ROOT}/scripts/stop-hook.mjs" ]]; then
  mkdir -p "${TARGET_DIR}/scripts"
  INSTALLED_HOOK="${TARGET_DIR}/scripts/stop-hook.mjs"
  cp -f "${PLUGIN_ROOT}/scripts/stop-hook.mjs" "${INSTALLED_HOOK}"
  if [[ -f "${PLUGIN_ROOT}/hooks.json" ]]; then
    node -e '
const fs = require("fs");
const path = require("path");
const pluginRoot = process.argv[1];
const targetDir = process.argv[2];
const hookScript = process.argv[3];
const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks.json"), "utf8"));
const stopArr = hooks["agy-chrome-use-release"] && hooks["agy-chrome-use-release"].Stop;
if (Array.isArray(stopArr) && stopArr.length > 0) {
  stopArr[0].command = `node "${hookScript}"`;
}
fs.writeFileSync(path.join(targetDir, "hooks.json"), JSON.stringify(hooks, null, 2) + "\n", "utf8");
' "${PLUGIN_ROOT}" "${TARGET_DIR}" "${INSTALLED_HOOK}"
  fi
elif [[ -f "${PLUGIN_ROOT}/hooks.json" ]]; then
  cp -f "${PLUGIN_ROOT}/hooks.json" "${TARGET_DIR}/hooks.json"
fi

if [[ -f "${PLUGIN_ROOT}/README.md" ]]; then
  cp -f "${PLUGIN_ROOT}/README.md" "${TARGET_DIR}/README.md"
fi

rm -rf "${TARGET_DIR}/rules" "${TARGET_DIR}/skills"
cp -R "${PLUGIN_ROOT}/rules" "${TARGET_DIR}/rules"
cp -R "${PLUGIN_ROOT}/skills" "${TARGET_DIR}/skills"

echo "Installed plugin bundle to ${TARGET_DIR} (runtime from ${PLUGIN_ROOT})"
