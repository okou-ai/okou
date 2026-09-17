#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/verify-okou-app-assets.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
assets_directory="${test_root}/assets"
fake_bin="${test_root}/bin"
curl_log="${test_root}/curl.log"
mkdir -p "$assets_directory/nested" "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

printf 'javascript\n' > "${assets_directory}/app-AbCd1234.js"
printf '{}\n' > "${assets_directory}/app-AbCd1234.js.map"
printf 'lazy\n' > "${assets_directory}/lazy-Lazy1234.js"
for group in 1 2 3 4 5; do
  printf 'vendor %s\n' "$group" > "${assets_directory}/vendor-${group}-EfGh5678.js"
  printf '{}\n' > "${assets_directory}/vendor-${group}-EfGh5678.js.map"
done
printf 'runtime\n' > "${assets_directory}/rolldown-runtime-IjKl9012.js"
printf 'worker\n' > "${assets_directory}/shared-database-worker-MnOp3456.js"
printf 'clerk ui\n' > "${assets_directory}/clerk-ui-AbCd123456789012.js"
printf '{}\n' > "${assets_directory}/shared-database-worker-MnOp3456.js.map"
printf 'svg\n' > "${assets_directory}/nested/logo-EfGh5678.svg"
printf '{}\n' > "${assets_directory}/runtime.js.map"

cat > "${fake_bin}/curl" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

asset_url="${!#}"
printf '%s\n' "$*" >> "$MOCK_CURL_LOG"
if [[ "$asset_url" == "${MOCK_CURL_FAIL_URL:-}" ]]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
BASH
chmod +x "${fake_bin}/curl"

: > "$curl_log"
output="$({
  PATH="${fake_bin}:$PATH" \
    MOCK_CURL_LOG="$curl_log" \
    bash "$script" \
      https://static.test/okou-app/assets/ \
      "$assets_directory"
} 2>&1)"

grep -Fq 'Skipping unhashed source map: runtime.js.map' <<< "$output" ||
  fail "unhashed source map was not reported as skipped"
grep -Fq \
  'App bundle layout: app=app-AbCd1234.js vendor=vendor-1-EfGh5678.js vendor-2-EfGh5678.js vendor-3-EfGh5678.js vendor-4-EfGh5678.js vendor-5-EfGh5678.js runtime=rolldown-runtime-IjKl9012.js worker=shared-database-worker-MnOp3456.js clerk-ui=clerk-ui-AbCd123456789012.js' \
  <<< "$output" || fail "bundle layout was not reported"
grep -Fq \
  'Verified 18 immutable app assets on https://static.test/okou-app/assets' \
  <<< "$output" || fail "verification summary is incorrect"

for relative_path in \
  app-AbCd1234.js \
  app-AbCd1234.js.map \
  lazy-Lazy1234.js \
  vendor-1-EfGh5678.js \
  vendor-1-EfGh5678.js.map \
  vendor-2-EfGh5678.js \
  vendor-2-EfGh5678.js.map \
  vendor-3-EfGh5678.js \
  vendor-3-EfGh5678.js.map \
  vendor-4-EfGh5678.js \
  vendor-4-EfGh5678.js.map \
  vendor-5-EfGh5678.js \
  vendor-5-EfGh5678.js.map \
  rolldown-runtime-IjKl9012.js \
  shared-database-worker-MnOp3456.js \
  shared-database-worker-MnOp3456.js.map \
  clerk-ui-AbCd123456789012.js \
  nested/logo-EfGh5678.svg; do
  grep -Fq -- \
    "--head --connect-timeout 10 --max-time 30 --retry 6 --retry-delay 2 --retry-max-time 90 --retry-all-errors https://static.test/okou-app/assets/${relative_path}" \
    "$curl_log" || fail "asset was not verified: ${relative_path}"
done

if grep -Fq 'runtime.js.map' "$curl_log"; then
  fail "unhashed source map reached the public verifier"
fi

for missing_file in clerk-ui-AbCd123456789012.js vendor-5-EfGh5678.js; do
  missing_url="https://static.test/okou-app/assets/${missing_file}"
  if PATH="${fake_bin}:$PATH" \
    MOCK_CURL_LOG="$curl_log" \
    MOCK_CURL_FAIL_URL="$missing_url" \
    bash "$script" \
      https://static.test/okou-app/assets \
      "$assets_directory" > "${test_root}/failure.log" 2>&1; then
    fail "missing public asset did not fail verification"
  fi
  grep -Fq "App asset is unavailable: $missing_url" \
    "${test_root}/failure.log" || fail "missing asset was not identified"
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
    bash "$script" \
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

mv "${assets_directory}/clerk-ui-AbCd123456789012.js" "${test_root}/clerk-ui.js"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  bash "$script" \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/ui-layout-failure.log" 2>&1; then
  fail "missing optional UI did not fail layout verification"
fi
grep -Fq 'clerk-ui=none' "${test_root}/ui-layout-failure.log" ||
  fail "missing optional UI was not identified"
mv "${test_root}/clerk-ui.js" "${assets_directory}/clerk-ui-AbCd123456789012.js"

rm "${assets_directory}/rolldown-runtime-IjKl9012.js"
if PATH="${fake_bin}:$PATH" \
  MOCK_CURL_LOG="$curl_log" \
  bash "$script" \
    https://static.test/okou-app/assets \
    "$assets_directory" > "${test_root}/layout-failure.log" 2>&1; then
  fail "missing Rolldown runtime did not fail layout verification"
fi
grep -Fq \
  'Expected exactly five numbered vendor assets plus one app, Rolldown runtime, SharedWorker, and optional Clerk UI JavaScript asset' \
  "${test_root}/layout-failure.log" || fail "layout failure was not identified"

echo "verify okou app assets tests passed"
