#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fetch_script="${repo_root}/.github/scripts/artifacts/fetch-okou-cli-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
commit_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
canonical="${tmp_dir}/canonical"
mkdir -p "${tmp_dir}/bin" "${canonical}/contents/package"
jq -n '{
  name: "@okouai/cli", version: "9.353.0", private: true, bin: {okou: "okou.js"},
  okouBuildIdentity: {
    schemaVersion: 1, piAgentRuntime: "1.36.0", piSdk: "0.86.1+okou.0123456789ab"
  }
}' > "${canonical}/contents/package/package.json"
for asset in okou.js image-resize-worker.js photon_rs_bg.wasm; do
  printf 'synthetic %s\n' "$asset" > "${canonical}/contents/package/${asset}"
done
tar -czf "${canonical}/package.tgz" -C "${canonical}/contents" package
jq -n --arg commit "$commit_sha" \
  --arg sha "$(sha256sum "${canonical}/package.tgz" | cut -d ' ' -f 1)" \
  --argjson size "$(wc -c < "${canonical}/package.tgz" | tr -d '[:space:]')" '{
    version: 1, commitSha: $commit,
    package: {path: "package.tgz", sha256: $sha, size: $size},
    versions: {cli: "9.353.0", piAgentRuntime: "1.36.0", piSdk: "0.86.1+okou.0123456789ab"}
  }' > "${canonical}/manifest.json"
jq -n --arg commit "$commit_sha" \
  --arg sha "$(sha256sum "${canonical}/manifest.json" | cut -d ' ' -f 1)" \
  '{version: 1, commitSha: $commit, manifestSha256: $sha}' > "${canonical}/ready.json"

# Only HTTP and waiting are external controls; use the real artifact verifier.
cat > "${tmp_dir}/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output="" url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --connect-timeout|--max-time|--retry|--retry-max-time|--stderr|--write-out) shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
prefix="https://static.example.test/okou-cli/${TEST_COMMIT}/"
[[ "$url" == "$prefix"* ]] || exit 23
filename="${url#"$prefix"}"
printf '%s\n' "$filename" >> "$FETCH_LOG"
if [[ "$filename" == ready.json ]]; then
  count=0
  if [[ -f "$FETCH_READY_COUNT" ]]; then count=$(cat "$FETCH_READY_COUNT"); fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$FETCH_READY_COUNT"
  if (( count <= ${FETCH_READY_MISSES:-0} )); then exit 22; fi
fi
if [[ "$filename" == "${FETCH_FAIL_ASSET:-}" ]]; then exit 22; fi
cp "${FETCH_SOURCE}/${filename}" "$output"
SH
cat > "${tmp_dir}/bin/sleep" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >> "$FETCH_SLEEPS"
SH
chmod +x "${tmp_dir}/bin/curl" "${tmp_dir}/bin/sleep"
export PATH="${tmp_dir}/bin:$PATH"
export CLI_STATIC_BASE_URL=https://static.example.test
export TEST_COMMIT="$commit_sha" FETCH_SOURCE="$canonical"
export FETCH_LOG="${tmp_dir}/fetch.log" FETCH_READY_COUNT="${tmp_dir}/ready-count"
export FETCH_SLEEPS="${tmp_dir}/sleeps"

FETCH_READY_MISSES=1 WAIT_ATTEMPTS=2 bash "$fetch_script" "$commit_sha" "${tmp_dir}/fetched"
for file in ready.json manifest.json package.tgz; do
  cmp "${canonical}/${file}" "${tmp_dir}/fetched/${file}"
done
[[ "$(cat "$FETCH_READY_COUNT")" == 2 ]]
[[ "$(cat "$FETCH_SLEEPS")" == 10 ]]

rm "$FETCH_READY_COUNT" "$FETCH_LOG" "$FETCH_SLEEPS"
if FETCH_READY_MISSES=2 WAIT_ATTEMPTS=2 bash "$fetch_script" "$commit_sha" "${tmp_dir}/not-ready" \
  > "${tmp_dir}/not-ready.log" 2>&1; then
  echo 'Fetch accepted an artifact that never became ready' >&2
  exit 1
fi
[[ "$(cat "$FETCH_READY_COUNT")" == 2 ]]
[[ "$(wc -l < "$FETCH_LOG")" == 2 ]]
grep -Fq 'not ready after 2 attempts' "${tmp_dir}/not-ready.log"

if FETCH_FAIL_ASSET=package.tgz bash "$fetch_script" "$commit_sha" "${tmp_dir}/download-failure" \
  > "${tmp_dir}/download-failure.log" 2>&1; then
  echo 'Fetch hid a required package download failure' >&2
  exit 1
fi
grep -Fq 'CLI CDN download failed' "${tmp_dir}/download-failure.log"

printf 'corrupt bytes\n' >> "${canonical}/package.tgz"
if bash "$fetch_script" "$commit_sha" "${tmp_dir}/corrupt" > "${tmp_dir}/corrupt.log" 2>&1; then
  echo 'Fetch accepted package bytes that disagree with the manifest' >&2
  exit 1
fi
grep -Fq 'CLI package digest does not match manifest' "${tmp_dir}/corrupt.log"

echo 'fetch-okou-cli-artifact-test: ok'
