#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
checker="${repo_root}/.github/scripts/checks/check-cdp-viewer-pin.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/repo/turbo/apps/platform"
export MOCK_PIN_SHA=1111111111111111111111111111111111111111
export MOCK_GH_LOG="$fixture/gh.log"

cat >"$fixture/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "api repos/okou-ai/cdp-viewer/compare/main...${MOCK_PIN_SHA} --jq .status" ]]
printf '%s\n' "$*" >>"$MOCK_GH_LOG"
if [[ "$MOCK_COMPARE_STATUS" == "api-failure" ]]; then
  echo "upstream unavailable" >&2
  exit 1
fi
printf '%s\n' "$MOCK_COMPARE_STATUS"
SH
chmod +x "$fixture/bin/gh"

write_reference() {
  jq -n --arg reference "$1" '{dependencies: {"cdp-viewer": $reference}}' \
    >"$fixture/repo/turbo/apps/platform/package.json"
}

run_check() {
  PATH="$fixture/bin:$PATH" MOCK_COMPARE_STATUS="$1" \
    bash "$checker" "$fixture/repo"
}

write_reference "github:okou-ai/cdp-viewer#${MOCK_PIN_SHA}"
for status in identical behind; do
  run_check "$status" >/dev/null
done

# Reject unmerged heads whether they extend or diverge from main. An unavailable
# or incomplete API response must not certify a commit either.
for status in ahead diverged api-failure ''; do
  if run_check "$status" >"$fixture/output" 2>&1; then
    echo "Expected comparison '${status}' to reject the pin." >&2
    exit 1
  fi
done

# Reject mutable refs and abbreviated SHAs before querying the upstream.
for reference in main 1111111; do
  write_reference "github:okou-ai/cdp-viewer#${reference}"
  : >"$MOCK_GH_LOG"
  if run_check identical >"$fixture/output" 2>&1; then
    echo "Expected reference '${reference}' to reject the pin." >&2
    exit 1
  fi
  [[ ! -s "$MOCK_GH_LOG" ]]
done

echo "cdp-viewer main pin policy: ok"
