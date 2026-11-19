#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
normalizer="$repo_root/.github/scripts/normalize-github-app-private-key.sh"
workflow="$repo_root/.github/workflows/publish-presentation-template-archives.yml"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

for command in base64 openssl; do
  command -v "$command" >/dev/null || fail "$command is required"
done

private_key="$(
  openssl genpkey \
    -algorithm RSA \
    -pkeyopt rsa_keygen_bits:2048 \
    2>/dev/null
)"
flattened_key="${private_key//$'\n'/ }"
escaped_key="$(printf '%s' "$flattened_key" | bash "$normalizer")"
round_trip_key="$(printf '%b' "$escaped_key")"

if [[ "$round_trip_key" != "$private_key" ]]; then
  fail "flattened private key did not survive normalization"
fi

escaped_multiline_key="$(printf '%s' "$private_key" | bash "$normalizer")"
if [[ "$(printf '%b' "$escaped_multiline_key")" != "$private_key" ]]; then
  fail "multiline private key did not survive normalization"
fi

encoded_key="$(printf '%s\n' "$private_key" | base64 -w 0)"
if printf '%s' "$encoded_key" | bash "$normalizer" >/dev/null 2>&1; then
  fail "Base64 input without PEM markers must fail"
fi

if printf '%s' '-----BEGIN PRIVATE KEY----- invalid -----END PRIVATE KEY-----' |
  bash "$normalizer" >/dev/null 2>&1; then
  fail "invalid PEM input must fail"
fi

grep -qF \
  "SOURCE_PRIVATE_KEY_PEM: \${{ secrets.OKOU_CI_APP_PRIVATE_KEY }}" \
  "$workflow" || fail "workflow must read the canonical PEM private key secret"
grep -qF \
  'bash .github/scripts/normalize-github-app-private-key.sh' \
  "$workflow" || fail "workflow must normalize the private key before token creation"
grep -qF \
  "private-key: \${{ steps.source-private-key.outputs.private-key }}" \
  "$workflow" || fail "token action must consume the normalized private key"

if grep -qF \
  "private-key: \${{ secrets.OKOU_CI_APP_PRIVATE_KEY }}" \
  "$workflow"; then
  fail "token action must not receive the secret directly"
fi

echo "normalize-github-app-private-key-test: ok"
