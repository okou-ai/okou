#!/usr/bin/env bash

# The callers derive the version and asset name with runner-image-target.sh.
runner_release_assets_read() {
  local tag=$1
  printf 'Authorization: Bearer %s\n' "$GH_TOKEN" | curl -fsSL \
    --retry 5 \
    --retry-delay 2 \
    --retry-max-time 60 \
    --retry-all-errors \
    -H @- \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${tag}"
}

# A missing/ambiguous asset fails the lookup. A missing digest is represented
# by an empty string so an existing local rollback executable can still be used.
runner_release_asset_checksum() {
  jq -er --arg name "$1" '
    [.assets[] | select(.name == $name)]
    | select(length == 1)
    | .[0].digest
    | if type == "string" and test("^sha256:[0-9a-f]{64}$") then . else "" end
  '
}

runner_release_asset_url() {
  printf 'https://github.com/%s/releases/download/%s/%s\n' "$GITHUB_REPOSITORY" "$1" "$2"
}
