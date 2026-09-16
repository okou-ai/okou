#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/verify-okou-app-runtime.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
assets_directory="${test_root}/assets"
fake_bin="${test_root}/bin"
curl_log="${test_root}/curl.log"
sleep_log="${test_root}/sleep.log"
html_source="${test_root}/index.html"
old_html_source="${test_root}/old-index.html"
prioritized_html_source="${test_root}/prioritized-index.html"
worker_preview_html_source="${test_root}/worker-preview-index.html"
mkdir -p "$assets_directory" "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

for file_name in \
  app-AbCd1234.js \
  index-QrSt7890.css \
  vendor-1-EfGh5678.js \
  vendor-2-EfGh5678.js \
  vendor-3-EfGh5678.js \
  vendor-4-EfGh5678.js \
  vendor-5-EfGh5678.js \
  rolldown-runtime-IjKl9012.js \
  clerk-ui-AbCd123456789012.js \
  shared-database-worker-MnOp3456.js; do
  printf 'javascript\n' > "${assets_directory}/${file_name}"
done

cat > "$html_source" <<'HTML'
<!doctype html>
<meta name="okou-app-git-commit-sha" content="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
<meta name="okou-app-version" content="0.812.5">
<meta name="okou-clerk-ui-script" content="https://static.test/okou-app/assets/clerk-ui-AbCd123456789012.js">
<link id="okou-main-stylesheet" rel="preload" as="style" crossorigin href="https://static.test/okou-app/assets/index-QrSt7890.css">
<script id="okou-main-stylesheet-loader"></script>
<script type="module" crossorigin src="https://static.test/okou-app/assets/app-AbCd1234.js"></script>
<link rel="modulepreload" crossorigin href="https://static.test/okou-app/assets/rolldown-runtime-IjKl9012.js">
<link rel="modulepreload" crossorigin href="https://static.test/okou-app/assets/vendor-1-EfGh5678.js">
<link rel="modulepreload" crossorigin href="https://static.test/okou-app/assets/vendor-2-EfGh5678.js">
<link rel="modulepreload" crossorigin href="https://static.test/okou-app/assets/vendor-3-EfGh5678.js">
<link rel="modulepreload" crossorigin href="https://static.test/okou-app/assets/vendor-4-EfGh5678.js">
<link rel="modulepreload" crossorigin href="https://static.test/okou-app/assets/vendor-5-EfGh5678.js">
HTML

cat > "$old_html_source" <<'HTML'
<!doctype html>
<meta name="okou-app-git-commit-sha" content="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">
<meta name="okou-app-version" content="0.812.4">
<link id="okou-main-stylesheet" rel="preload" as="style" crossorigin href="https://static.test/okou-app/assets/index-Old12345.css">
<script id="okou-main-stylesheet-loader"></script>
<script type="module" crossorigin src="https://static.test/okou-app/assets/app-Old12345.js"></script>
<link rel="modulepreload" crossorigin href="https://static.test/okou-app/assets/rolldown-runtime-Old12345.js">
<link rel="modulepreload" crossorigin href="https://static.test/okou-app/assets/vendor-Old12345.js">
HTML

cat > "${fake_bin}/curl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
write_out=""
asset_url="${!#}"
arguments=("$@")
printf '%s\n' "$*" >> "$MOCK_CURL_LOG"
if [[ "$asset_url" == "${MOCK_CURL_FAIL_URL:-}" ]]; then
  echo "curl: (22) The requested URL returned error: 404: $asset_url" >&2
  exit 22
fi
for (( index = 0; index < ${#arguments[@]}; index += 1 )); do
  case "${arguments[index]}" in
    --output) output_file="${arguments[index + 1]}" ;;
    --write-out) write_out="${arguments[index + 1]}" ;;
  esac
done
if [[ "$asset_url" == */sign-up ]]; then
  if [[ "${MOCK_DOCUMENT_MODE:-success}" == "transport-failure" ]]; then
    echo 'curl: (56) simulated document transport failure' >&2
    exit 56
  fi
  document_source="$MOCK_HTML_SOURCE"
  if [[ -n "${MOCK_HTML_SEQUENCE_STATE:-}" ]]; then
    document_attempt="$(<"$MOCK_HTML_SEQUENCE_STATE")"
    document_attempt=$((document_attempt + 1))
    printf '%s\n' "$document_attempt" >"$MOCK_HTML_SEQUENCE_STATE"
    sequence_source="${MOCK_HTML_SEQUENCE_DIR}/${document_attempt}.html"
    if [[ -f "$sequence_source" ]]; then
      document_source="$sequence_source"
    fi
  fi
  cp "$document_source" "$output_file"
fi
if [[ -n "$write_out" ]]; then
  printf '%s' "${MOCK_WORKER_STATUS:-206}"
fi
BASH

cat > "${fake_bin}/sleep" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${1:?sleep delay is required}" >>"$MOCK_SLEEP_LOG"
BASH
chmod +x "${fake_bin}/curl" "${fake_bin}/sleep"

: > "$curl_log"
: > "$sleep_log"
output="$({
  PATH="${fake_bin}:$PATH" \
    MOCK_CURL_LOG="$curl_log" \
    MOCK_HTML_SOURCE="$html_source" \
    MOCK_SLEEP_LOG="$sleep_log" \
    bash "$script" \
      https://app.test \
      https://static.test/okou-app/assets \
      "$assets_directory"
} 2>&1)"

grep -Fq \
  'Verified app runtime: stylesheet=https://static.test/okou-app/assets/index-QrSt7890.css app=https://static.test/okou-app/assets/app-AbCd1234.js vendor=https://static.test/okou-app/assets/vendor-1-EfGh5678.js' \
  <<< "$output" || fail "runtime verification summary is incorrect"
for expected_url in \
  https://app.test/sign-up \
  https://static.test/okou-app/assets/index-QrSt7890.css \
  https://static.test/okou-app/assets/app-AbCd1234.js \
  https://static.test/okou-app/assets/vendor-1-EfGh5678.js \
  https://static.test/okou-app/assets/vendor-2-EfGh5678.js \
  https://static.test/okou-app/assets/vendor-3-EfGh5678.js \
  https://static.test/okou-app/assets/vendor-4-EfGh5678.js \
  https://static.test/okou-app/assets/vendor-5-EfGh5678.js \
  https://static.test/okou-app/assets/rolldown-runtime-IjKl9012.js \
  https://static.test/okou-app/assets/clerk-ui-AbCd123456789012.js \
  https://app.test/okou-app/assets/shared-database-worker-MnOp3456.js; do
  grep -Fq "$expected_url" "$curl_log" ||
    fail "runtime verifier did not probe ${expected_url}"
done

worker_preview_url="https://pr-123-app-okou-app-preview.test.workers.dev"
sed \
  "s#https://static.test/okou-app/assets#${worker_preview_url}/okou-app/assets#g" \
  "$html_source" > "$worker_preview_html_source"
: > "$curl_log"
: > "$sleep_log"
worker_preview_output="$({
  PATH="${fake_bin}:$PATH" \
    MOCK_CURL_LOG="$curl_log" \
    MOCK_HTML_SOURCE="$worker_preview_html_source" \
    MOCK_SLEEP_LOG="$sleep_log" \
    bash "$script" \
      "$worker_preview_url" \
      https://static.test/okou-app/assets \
      "$assets_directory"
} 2>&1)"
grep -Fq \
  "Verified app runtime: stylesheet=${worker_preview_url}/okou-app/assets/index-QrSt7890.css app=${worker_preview_url}/okou-app/assets/app-AbCd1234.js vendor=${worker_preview_url}/okou-app/assets/vendor-1-EfGh5678.js" \
  <<< "$worker_preview_output" || fail "Worker preview runtime summary is incorrect"
for expected_url in \
  "${worker_preview_url}/sign-up" \
  "${worker_preview_url}/okou-app/assets/index-QrSt7890.css" \
  "${worker_preview_url}/okou-app/assets/app-AbCd1234.js" \
  "${worker_preview_url}/okou-app/assets/vendor-1-EfGh5678.js" \
  "${worker_preview_url}/okou-app/assets/vendor-2-EfGh5678.js" \
  "${worker_preview_url}/okou-app/assets/vendor-3-EfGh5678.js" \
  "${worker_preview_url}/okou-app/assets/vendor-4-EfGh5678.js" \
  "${worker_preview_url}/okou-app/assets/vendor-5-EfGh5678.js" \
  "${worker_preview_url}/okou-app/assets/rolldown-runtime-IjKl9012.js" \
  "${worker_preview_url}/okou-app/assets/clerk-ui-AbCd123456789012.js" \
  "${worker_preview_url}/okou-app/assets/shared-database-worker-MnOp3456.js"; do
  grep -Fq "$expected_url" "$curl_log" ||
    fail "Worker preview runtime verifier did not probe ${expected_url}"
done

for layout_case in missing-vendor duplicate-vendor; do
  mv "${assets_directory}/vendor-5-EfGh5678.js" "${test_root}/vendor-5.js"
  expected_failure='Expected exactly five numbered vendor assets'
  if [[ "$layout_case" == duplicate-vendor ]]; then
    printf 'duplicate vendor\n' > "${assets_directory}/vendor-4-Duplicate.js"
    expected_failure='Expected exactly one vendor-4 JavaScript asset, found 2'
  fi
  if PATH="${fake_bin}:$PATH" \
    MOCK_CURL_LOG="$curl_log" \
    MOCK_HTML_SOURCE="$html_source" \
    MOCK_SLEEP_LOG="$sleep_log" \
    bash "$script" \
      https://app.test \
      https://static.test/okou-app/assets \
      "$assets_directory" > "${test_root}/${layout_case}.log" 2>&1; then
    fail "${layout_case} did not fail layout verification"
  fi
  grep -Fq "$expected_failure" "${test_root}/${layout_case}.log" ||
    fail "${layout_case} was not identified"
  if [[ "$layout_case" == duplicate-vendor ]]; then
    rm "${assets_directory}/vendor-4-Duplicate.js"
  fi
  mv "${test_root}/vendor-5.js" "${assets_directory}/vendor-5-EfGh5678.js"
done

missing_vendor_url='https://static.test/okou-app/assets/vendor-5-EfGh5678.js'
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_HTML_SOURCE="$html_source" \
  MOCK_SLEEP_LOG="$sleep_log" \
  MOCK_CURL_FAIL_URL="$missing_vendor_url" \
  bash "$script" \
    https://app.test \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/vendor-unavailable.log" 2>&1; then
  fail "unavailable fifth vendor did not fail runtime verification"
fi
grep -Fq "$missing_vendor_url" "${test_root}/vendor-unavailable.log" ||
  fail "unavailable fifth vendor was not identified"

if OKOU_APP_RUNTIME_MAX_ATTEMPTS=0 \
  bash "$script" \
    https://app.test \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/invalid-bound.log" 2>&1; then
  fail "invalid runtime convergence bound did not fail closed"
fi
grep -Fq 'OKOU_APP_RUNTIME_MAX_ATTEMPTS must be a positive integer' \
  "${test_root}/invalid-bound.log" ||
  fail "invalid runtime convergence bound was not identified"

sequence_directory="${test_root}/html-sequence"
sequence_state="${test_root}/html-sequence.state"
mkdir -p "$sequence_directory"
cp "$old_html_source" "${sequence_directory}/1.html"
cp "$html_source" "${sequence_directory}/2.html"
printf '0\n' > "$sequence_state"
: > "$curl_log"
: > "$sleep_log"
PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_HTML_SEQUENCE_DIR="$sequence_directory" \
  MOCK_HTML_SEQUENCE_STATE="$sequence_state" \
  MOCK_HTML_SOURCE="$html_source" \
  MOCK_SLEEP_LOG="$sleep_log" \
  OKOU_APP_RUNTIME_MAX_ATTEMPTS=3 \
  bash "$script" \
    https://app.test \
    https://static.test/okou-app/assets \
    "$assets_directory" >/dev/null
[[ "$(<"$sequence_state")" == "2" ]] ||
  fail "old runtime document did not converge on the second probe"
[[ "$(grep -Fc 'https://app.test/sign-up' "$curl_log")" == "2" ]] ||
  fail "runtime convergence did not fetch exactly two documents"
grep -Fxq '10' "$sleep_log" ||
  fail "runtime convergence did not wait between semantic probes"

: > "$curl_log"
: > "$sleep_log"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_HTML_SOURCE="$old_html_source" \
  MOCK_SLEEP_LOG="$sleep_log" \
  OKOU_APP_RUNTIME_MAX_ATTEMPTS=3 \
  bash "$script" \
    https://app.test \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/semantic-failure.log" 2>&1; then
  fail "permanent semantic mismatch did not exhaust the convergence bound"
fi
[[ "$(grep -Fc 'https://app.test/sign-up' "$curl_log")" == "3" ]] ||
  fail "permanent semantic mismatch did not use the bounded probe count"
[[ "$(wc -l < "$sleep_log")" == "2" ]] ||
  fail "permanent semantic mismatch used an unexpected retry count"
grep -Fq 'App runtime document did not converge for https://app.test after probe 3/3' \
  "${test_root}/semantic-failure.log" ||
  fail "semantic exhaustion did not identify the origin and bound"
grep -Fq 'Expected runtime build metadata' \
  "${test_root}/semantic-failure.log" ||
  fail "semantic exhaustion did not identify the metadata mismatch"
grep -Fq 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  "${test_root}/semantic-failure.log" ||
  fail "semantic exhaustion did not report the expected commit"
grep -Fq 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  "${test_root}/semantic-failure.log" ||
  fail "semantic exhaustion did not report the observed commit"

: > "$curl_log"
: > "$sleep_log"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_DOCUMENT_MODE=transport-failure \
  MOCK_HTML_SOURCE="$html_source" \
  MOCK_SLEEP_LOG="$sleep_log" \
  OKOU_APP_RUNTIME_MAX_ATTEMPTS=3 \
  bash "$script" \
    https://transport.test \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/transport-failure.log" 2>&1; then
  fail "permanent document transport failure did not exhaust the convergence bound"
fi
[[ "$(grep -Fc 'https://transport.test/sign-up' "$curl_log")" == "3" ]] ||
  fail "document transport failure did not use the bounded probe count"
grep -Fq 'App runtime document did not converge for https://transport.test after probe 3/3' \
  "${test_root}/transport-failure.log" ||
  fail "transport exhaustion did not identify the origin and bound"
grep -Fq 'curl exit 56' "${test_root}/transport-failure.log" ||
  fail "transport exhaustion did not preserve the final curl status"
grep -Fq 'simulated document transport failure' \
  "${test_root}/transport-failure.log" ||
  fail "transport exhaustion did not preserve the final curl evidence"

: > "$curl_log"
: > "$sleep_log"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_HTML_SOURCE="$html_source" \
  MOCK_SLEEP_LOG="$sleep_log" \
  MOCK_WORKER_STATUS=200 \
  bash "$script" \
    https://app.test \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/worker-failure.log" 2>&1; then
  fail "non-range SharedWorker response did not fail verification"
fi
grep -Fq 'SharedWorker same-origin proxy returned HTTP 200' \
  "${test_root}/worker-failure.log" || fail "worker failure was not identified"

cp "$html_source" "$prioritized_html_source"
sed -i \
  's/rel="preload"/rel="preload" fetchpriority="high"/' \
  "$prioritized_html_source"
: > "$curl_log"
: > "$sleep_log"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_HTML_SOURCE="$prioritized_html_source" \
  MOCK_SLEEP_LOG="$sleep_log" \
  bash "$script" \
    https://app.test \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/priority-failure.log" 2>&1; then
  fail "main stylesheet fetchpriority did not fail HTML verification"
fi
grep -Fq 'Expected main stylesheet preload without fetchpriority' \
  "${test_root}/priority-failure.log" ||
  fail "main stylesheet fetchpriority failure was not identified"

for ui_case in missing-source wrong-source eager-preload missing-asset; do
  ui_html_source="${test_root}/ui-${ui_case}.html"
  cp "$html_source" "$ui_html_source"
  case "$ui_case" in
    missing-source)
      sed -i '/okou-clerk-ui-script/d' "$ui_html_source"
      expected_failure='Expected one optional Clerk UI source'
      ;;
    wrong-source)
      sed -i 's/clerk-ui-AbCd123456789012/clerk-ui-Wrong12345678901/' "$ui_html_source"
      expected_failure='Expected one optional Clerk UI source'
      ;;
    eager-preload)
      printf '<link rel="modulepreload" href="https://static.test/okou-app/assets/clerk-ui-AbCd123456789012.js">\n' >> "$ui_html_source"
      expected_failure='Expected CDN runtime/vendor modulepreloads'
      ;;
    missing-asset)
      mv "${assets_directory}/clerk-ui-AbCd123456789012.js" "${test_root}/clerk-ui.js"
      expected_failure='optional-route Clerk UI JavaScript asset'
      ;;
  esac
  if PATH="${fake_bin}:$PATH" \
    MOCK_CURL_LOG="$curl_log" \
    MOCK_HTML_SOURCE="$ui_html_source" \
    MOCK_SLEEP_LOG="$sleep_log" \
    bash "$script" \
      https://app.test \
      https://static.test/okou-app/assets \
      "$assets_directory" > "${test_root}/ui-${ui_case}.log" 2>&1; then
    fail "Clerk UI ${ui_case} did not fail verification"
  fi
  grep -Fq "$expected_failure" "${test_root}/ui-${ui_case}.log" ||
    fail "Clerk UI ${ui_case} failure was not identified"
  if [[ "$ui_case" == missing-asset ]]; then
    mv "${test_root}/clerk-ui.js" "${assets_directory}/clerk-ui-AbCd123456789012.js"
  fi
done

duplicate_html_source="${test_root}/duplicate-vendor.html"
cp "$html_source" "$duplicate_html_source"
printf '<link rel="modulepreload" href="https://static.test/okou-app/assets/vendor-5-EfGh5678.js">\n' >> "$duplicate_html_source"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_HTML_SOURCE="$duplicate_html_source" \
  MOCK_SLEEP_LOG="$sleep_log" \
  bash "$script" \
    https://app.test \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/duplicate-preload.log" 2>&1; then
  fail "duplicate vendor preload did not fail HTML verification"
fi
grep -Fq 'Expected CDN runtime/vendor modulepreloads' \
  "${test_root}/duplicate-preload.log" || fail "duplicate preload was not identified"

sed -i '/vendor-5-EfGh5678/d' "$html_source"
: > "$curl_log"
: > "$sleep_log"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_HTML_SOURCE="$html_source" \
  MOCK_SLEEP_LOG="$sleep_log" \
  bash "$script" \
    https://app.test \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/html-failure.log" 2>&1; then
  fail "missing vendor preload did not fail HTML verification"
fi
grep -Fq 'Expected CDN runtime/vendor modulepreloads' \
  "${test_root}/html-failure.log" || fail "HTML failure was not identified"
grep -Fq 'App runtime document did not converge for https://app.test after probe 1/1' \
  "${test_root}/html-failure.log" ||
  fail "malformed document failure did not exhaust the convergence bound"

echo "verify okou app runtime tests passed"
