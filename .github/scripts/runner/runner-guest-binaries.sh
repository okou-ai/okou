#!/usr/bin/env bash

RUNNER_GUEST_HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_GUEST_REPO_ROOT="$(cd "${RUNNER_GUEST_HELPER_DIR}/../../.." && pwd)"
RUNNER_GUEST_INVENTORY_PATH="${RUNNER_GUEST_INVENTORY_PATH:-${RUNNER_GUEST_REPO_ROOT}/crates/runner/guest-binaries.json}"

RUNNER_GUEST_PACKAGES=()
RUNNER_GUEST_BINARIES=()
RUNNER_GUEST_PATH_ENVS=()

runner_guest_binaries_load() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required to load runner guest binaries" >&2
    return 2
  fi

  local rows
  if ! rows=$(jq -er '
    if type != "array" or length == 0 then
      error("runner guest inventory must be a non-empty array")
    else
      .[]
      | [.package, .binary, .pathEnv, .bundledEnv, .destination] as $fields
      | if any($fields[]; type != "string" or length == 0) then
          error("runner guest inventory fields must be non-empty strings")
        else
          $fields[:3] | @tsv
        end
    end
  ' "$RUNNER_GUEST_INVENTORY_PATH"); then
    return 1
  fi

  RUNNER_GUEST_PACKAGES=()
  RUNNER_GUEST_BINARIES=()
  RUNNER_GUEST_PATH_ENVS=()

  local package binary path_env
  while IFS=$'\t' read -r package binary path_env; do
    RUNNER_GUEST_PACKAGES+=("$package")
    RUNNER_GUEST_BINARIES+=("$binary")
    RUNNER_GUEST_PATH_ENVS+=("$path_env")
  done <<<"$rows"
}
