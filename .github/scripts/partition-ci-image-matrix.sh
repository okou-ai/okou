#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_NEEDED:?missing IMAGE_NEEDED}"
: "${IMAGE_MATRIX:?missing IMAGE_MATRIX}"
: "${GITHUB_OUTPUT:?missing GITHUB_OUTPUT}"

# A failed/unknown producer plan must not turn into an empty successful DAG.
jq -e --arg needed "$IMAGE_NEEDED" '
  ($needed == "true" or $needed == "false") and
  type == "array" and length <= 2 and
  (if $needed == "true" then length > 0 else length == 0 end) and
  (map(.target) | unique | length) == length and
  all(.[];
    (.id == "arm64" and .target == "aarch64-unknown-linux-musl") or
    (.id == "x86_64" and .target == "x86_64-unknown-linux-musl")
  )
' <<<"$IMAGE_MATRIX" >/dev/null

for arch in arm64 x86_64; do
  matrix=$(jq -c --arg arch "$arch" 'map(select(.id == $arch))' <<<"$IMAGE_MATRIX")
  printf '%s=%s\n' "$arch" "$matrix" >> "$GITHUB_OUTPUT"
done
