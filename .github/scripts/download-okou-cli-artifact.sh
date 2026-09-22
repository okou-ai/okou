#!/usr/bin/env bash
# Download the commit-addressed CLI artifact that deploy-cli publishes for a
# commit, so a preview runner image can install the same bundle the preview API
# hands out through CLI_PKG_URL.
#
# Required env:
#   ARTIFACT_SHA   full lowercase commit SHA the artifact was built from
#   OUTPUT_DIR     directory that receives package.tgz, manifest.json, ready.json
# Optional env:
#   CLI_STATIC_BASE_URL   default https://static.okou.io
#   WAIT_SECONDS          how long to wait for ready.json (default 900)
#   ARTIFACT_REQUIRED     "true" fails when the artifact never appears;
#                         anything else emits found=false and exits 0, which
#                         builds an image without an installed CLI (legacy npx
#                         launch) for commits that publish no CLI artifact.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}
require_env ARTIFACT_SHA
require_env OUTPUT_DIR

emit() {
  printf '%s=%s\n' "$1" "$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
}

if [[ ! "$ARTIFACT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "CLI artifact commit must be a full lowercase SHA-1: $ARTIFACT_SHA" >&2
  exit 1
fi

base_url="${CLI_STATIC_BASE_URL:-https://static.okou.io}/okou-cli/${ARTIFACT_SHA}"
wait_seconds="${WAIT_SECONDS:-900}"
required="${ARTIFACT_REQUIRED:-true}"
mkdir -p "$OUTPUT_DIR"

deadline=$((SECONDS + wait_seconds))
while ! curl -fsSL "${base_url}/ready.json" --output "${OUTPUT_DIR}/ready.json" 2>/dev/null; do
  if (( SECONDS >= deadline )); then
    if [[ "$required" == "true" ]]; then
      echo "CLI artifact was not ready after ${wait_seconds}s: ${base_url}" >&2
      exit 1
    fi
    echo "::warning::CLI artifact not published for ${ARTIFACT_SHA} after ${wait_seconds}s; building the runner image without an installed Okou CLI"
    emit "found" "false"
    exit 0
  fi
  echo "Waiting for CLI artifact: ${base_url} (${SECONDS}s elapsed)"
  sleep 10
done

curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
  "${base_url}/manifest.json" --output "${OUTPUT_DIR}/manifest.json"
curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
  "${base_url}/package.tgz" --output "${OUTPUT_DIR}/package.tgz"
bash "${SCRIPT_DIR}/verify-okou-cli-artifact.sh" "$OUTPUT_DIR" "$ARTIFACT_SHA"

emit "found" "true"
emit "artifact-dir" "$OUTPUT_DIR"
emit "cli-version" "$(jq -er '.versions.cli' "${OUTPUT_DIR}/manifest.json")"
emit "pi-agent-runtime-version" "$(jq -er '.versions.piAgentRuntime' "${OUTPUT_DIR}/manifest.json")"
