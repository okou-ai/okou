#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/runner-image-target.sh"

fail() {
  echo "runner image architecture: $1" >&2
  exit 2
}

validate_architecture() {
  local architecture="${RUNNER_IMAGE_ARCHITECTURE:-}"
  jq -e '
    type == "object" and
    (keys | sort) == ["assetSuffix", "cacheSuffix", "id", "label", "target", "unameM"] and
    all(.[]; type == "string" and length > 0)
  ' <<<"$architecture" >/dev/null || fail "invalid architecture contract"

  local target
  target=$(jq -r '.target' <<<"$architecture")
  runner_image_validate_target "$target" || fail "unsupported architecture target"
  jq -e \
    --arg id "$(runner_image_sccache_architecture "$target")" \
    --arg uname_m "$(runner_image_expected_uname_m "$target")" \
    --arg cache_suffix "$(runner_image_cache_suffix "$target")" \
    --arg asset_suffix "$(runner_image_asset_suffix "$target")" '
      .id == $id and .unameM == $uname_m and
      .cacheSuffix == $cache_suffix and .assetSuffix == $asset_suffix
    ' <<<"$architecture" >/dev/null || fail "inconsistent architecture metadata"
}

case "${1:-}" in
  validate)
    validate_architecture
    ;;
  build-ready)
    validate_architecture
    case "${RUNNER_IMAGE_CACHE_HIT:-}:${RUNNER_IMAGE_COMPILE_RESULT:-}" in
      true:skipped|false:success) ;;
      *) fail "compiler result does not match the target cache plan" ;;
    esac
    ;;
  *)
    fail "usage: runner-image-architecture.sh validate|build-ready"
    ;;
esac
