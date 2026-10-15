#!/usr/bin/env bash
# Fetch and verify one immutable CLI artifact without publishing another copy.
# Usage: fetch-okou-cli-artifact.sh <commit-sha> <output-dir>
# Required env: CLI_STATIC_BASE_URL (public artifact origin).
# Optional env: WAIT_ATTEMPTS (positive ready polls, default 60, 10s apart).
# Requires curl, jq, Python 3, tar and GNU coreutils; callable from any directory.
# Writes ready.json, manifest.json and package.tgz; exits nonzero on any failure.
set -euo pipefail

if [[ "$#" -ne 2 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Usage: $0 <full-lowercase-commit-sha> <output-dir>" >&2
  exit 2
fi
: "${CLI_STATIC_BASE_URL:?CLI_STATIC_BASE_URL is required}"
commit_sha="$1"
output_dir="$2"
wait_attempts="${WAIT_ATTEMPTS:-60}"
if [[ ! "$wait_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "WAIT_ATTEMPTS must be a positive integer" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
artifact_base_url="${CLI_STATIC_BASE_URL%/}/okou-cli/${commit_sha}"
mkdir -p "$output_dir"
for ((attempt = 1; attempt <= wait_attempts; attempt++)); do
  if curl --disable -fsSL --connect-timeout 10 --max-time 30 \
    "${artifact_base_url}/ready.json" --output "${output_dir}/ready.json"; then
    break
  fi
  if (( attempt == wait_attempts )); then
    echo "CLI artifact was not ready after ${wait_attempts} attempts: $artifact_base_url" >&2
    exit 1
  fi
  echo "Waiting for CLI artifact: $artifact_base_url (attempt ${attempt}/${wait_attempts})"
  sleep 10
done

for filename in manifest.json package.tgz; do
  bash "${script_dir}/download-okou-cli-cdn-file.sh" \
    "${artifact_base_url}/${filename}" "${output_dir}/${filename}"
done
bash "${script_dir}/verify-okou-cli-artifact.sh" "$output_dir" "$commit_sha"
