#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${AGY_CUA_REPO_URL:-https://github.com/Nexro920/AGY_ComputerUse.git}"
TAR_URL="${AGY_CUA_TAR_URL:-https://github.com/Nexro920/AGY_ComputerUse/archive/refs/heads/main.tar.gz}"
DATA_ROOT="${HOME}/.gemini/config/plugin-data/agy-chrome-use"
RUNTIME_DIR="${DATA_ROOT}/runtime"

UNINSTALL=0
PURGE_DATA=0
FORWARD_ARGS=()

for arg in "$@"; do
  case "${arg}" in
    --uninstall|-u)
      UNINSTALL=1
      FORWARD_ARGS+=("--uninstall")
      ;;
    --purge-data)
      PURGE_DATA=1
      FORWARD_ARGS+=("--purge-data")
      ;;
    *)
      FORWARD_ARGS+=("${arg}")
      ;;
  esac
done

if [[ "${UNINSTALL}" -eq 1 ]]; then
  if [[ -x "${RUNTIME_DIR}/scripts/install-local.sh" ]]; then
    bash "${RUNTIME_DIR}/scripts/install-local.sh" "${FORWARD_ARGS[@]}"
  else
    rm -rf "${HOME}/.gemini/config/plugins/agy-chrome-use"
    if [[ "${PURGE_DATA}" -eq 1 ]]; then
      rm -rf "${DATA_ROOT}"
    fi
  fi
  exit 0
fi

mkdir -p "${DATA_ROOT}"

if command -v git >/dev/null 2>&1; then
  if [[ -d "${RUNTIME_DIR}/.git" ]]; then
    echo "Updating existing runtime in ${RUNTIME_DIR}..."
    git -C "${RUNTIME_DIR}" pull --ff-only || true
  else
    rm -rf "${RUNTIME_DIR}"
    echo "Cloning ${REPO_URL} into ${RUNTIME_DIR}..."
    git clone --depth 1 "${REPO_URL}" "${RUNTIME_DIR}"
  fi
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  echo "Downloading runtime archive from ${TAR_URL}..."
  curl -fsSL "${TAR_URL}" -o "${TMP_DIR}/repo.tar.gz"
  tar -xzf "${TMP_DIR}/repo.tar.gz" -C "${TMP_DIR}"
  INNER_DIR="$(find "${TMP_DIR}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "${INNER_DIR}" ]]; then
    echo "Downloaded archive did not contain a root directory." >&2
    exit 1
  fi
  rm -rf "${RUNTIME_DIR}"
  mv "${INNER_DIR}" "${RUNTIME_DIR}"
fi

exec bash "${RUNTIME_DIR}/scripts/install-local.sh" "${FORWARD_ARGS[@]}"
