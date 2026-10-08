#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
publisher="${REPO_ROOT}/.github/scripts/publish-okou-cli-versioned-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
commit_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
old_commit_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
cli_version="9.353.0"
canonical="${tmp_dir}/canonical"
versioned="${tmp_dir}/versioned"
mkdir -p "${tmp_dir}/bin" "${canonical}/contents/package" "$versioned"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Real packed files and the real verifier; only curl/AWS are boundary mocks.
jq -n --arg version "$cli_version" '{
  name: "@okouai/cli", version: $version, private: true, bin: {okou: "okou.js"}
}' > "${canonical}/contents/package/package.json"
for asset in okou.js image-resize-worker.js photon_rs_bg.wasm; do
  printf 'synthetic %s\n' "$asset" > "${canonical}/contents/package/${asset}"
done
tar -czf "${canonical}/package.tgz" -C "${canonical}/contents" package
package_sha="$(sha256sum "${canonical}/package.tgz" | cut -d ' ' -f 1)"
package_size="$(wc -c < "${canonical}/package.tgz" | tr -d '[:space:]')"
jq -n --arg commit "$commit_sha" --arg sha "$package_sha" --argjson size "$package_size" '{
  version: 1, commitSha: $commit,
  package: {path: "package.tgz", sha256: $sha, size: $size},
  versions: {cli: "9.353.0", piAgentRuntime: "1.36.0", piSdk: "0.86.1+okou.0123456789ab"},
  sessionConstruction: {digest: ("d" * 64)}
}' > "${canonical}/manifest.json"
manifest_sha="$(sha256sum "${canonical}/manifest.json" | cut -d ' ' -f 1)"
jq -n --arg commit "$commit_sha" --arg sha "$manifest_sha" '{
  version: 1, commitSha: $commit, manifestSha256: $sha
}' > "${canonical}/ready.json"
jq -n '{"turbo/apps/cli": "9.353.0", "turbo/packages/pi-agent-runtime": "1.36.0"}' \
  > "${tmp_dir}/release-manifest.json"

cat > "${tmp_dir}/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) output="$2"; shift 2 ;;
    --retry|--retry-delay) shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  "${CLI_STATIC_BASE_URL}/okou-cli/${ARTIFACT_SHA}/"*)
    cp "${MOCK_CANONICAL_DIR}/${url##*/}" "$output" ;;
  "${CLI_STATIC_BASE_URL}/okou-cli/v9.353.0/"*)
    cp "${MOCK_VERSIONED_DIR}/${url##*/}" "$output" ;;
  *) echo "unexpected curl URL: $url" >&2; exit 1 ;;
esac
SH
cat > "${tmp_dir}/bin/aws" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
operation="${2:-}"
key=""
body=""
last_arg=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --key) key="$2"; shift 2 ;;
    --body) body="$2"; shift 2 ;;
    *) last_arg="$1"; shift ;;
  esac
done
case "$operation" in
  head-object)
    if [ -f "${MOCK_VERSIONED_DIR}/ready.json" ]; then exit 0; fi
    echo '404 Not Found' >&2; exit 1 ;;
  get-object) cp "${MOCK_VERSIONED_DIR}/${key##*/}" "$last_arg" ;;
  put-object)
    printf '%s\n' "${key##*/}" >> "$MOCK_UPLOAD_LOG"
    cp "$body" "${MOCK_VERSIONED_DIR}/${key##*/}" ;;
  *) echo "unexpected AWS operation: $operation" >&2; exit 1 ;;
esac
SH
chmod +x "${tmp_dir}/bin/curl" "${tmp_dir}/bin/aws"

run_publisher() {
  local output_dir="$1"
  PATH="${tmp_dir}/bin:${PATH}" \
  MOCK_CANONICAL_DIR="$canonical" MOCK_VERSIONED_DIR="$versioned" \
  MOCK_UPLOAD_LOG="${tmp_dir}/upload.log" \
  ARTIFACT_SHA="$commit_sha" RELEASE_MANIFEST_PATH="${tmp_dir}/release-manifest.json" \
  CLI_STATIC_BASE_URL="https://canonical-cli.example.invalid" \
  R2_ACCOUNT_ID="synthetic-account" R2_BUCKET_NAME="synthetic-bucket" \
  AWS_ACCESS_KEY_ID="synthetic-access" AWS_SECRET_ACCESS_KEY="synthetic-secret" \
  OUTPUT_DIR="$output_dir" WAIT_ATTEMPTS=1 GITHUB_OUTPUT="${tmp_dir}/publish-outputs" \
    bash "$publisher"
}

# Initial publication retains exactly the canonical package and manifest in the
# explicit directory that the workflow uploads for both Runner architectures.
run_publisher "${tmp_dir}/runner-input" > "${tmp_dir}/new.log" 2>&1
for filename in package.tgz manifest.json ready.json; do
  cmp "${canonical}/${filename}" "${tmp_dir}/runner-input/${filename}" \
    || fail "retained ${filename} differs from the canonical input"
done
[ "$(wc -l < "${tmp_dir}/upload.log")" -eq 3 ] || fail "initial publication must upload all three files"

# A version can already contain the same package from an earlier commit. Keep
# that immutable version untouched, but retain THIS release's canonical manifest
# for Runner, not the older manifest read back through the versioned CDN path.
jq --arg commit "$old_commit_sha" '.commitSha = $commit' "${canonical}/manifest.json" \
  > "${versioned}/manifest.json"
old_manifest_sha="$(sha256sum "${versioned}/manifest.json" | cut -d ' ' -f 1)"
jq -n --arg commit "$old_commit_sha" --arg sha "$old_manifest_sha" '{
  version: 1, commitSha: $commit, manifestSha256: $sha
}' > "${versioned}/ready.json"
: > "${tmp_dir}/upload.log"
run_publisher "${tmp_dir}/runner-input-reused-version" > "${tmp_dir}/reuse.log" 2>&1
cmp "${canonical}/package.tgz" "${tmp_dir}/runner-input-reused-version/package.tgz"
cmp "${canonical}/manifest.json" "${tmp_dir}/runner-input-reused-version/manifest.json"
[ ! -s "${tmp_dir}/upload.log" ] || fail "an identical versioned package must not be republished"
[ "$(jq -r '.commitSha' "${versioned}/manifest.json")" = "$old_commit_sha" ] \
  || fail "immutable older versioned identity was overwritten"

# Wrong source identity or corrupt package must fail before publishing/uploading
# a Runner input; the workflow's upload step has the normal success-only gate.
jq --arg commit "$old_commit_sha" '.commitSha = $commit' "${canonical}/manifest.json" \
  > "${canonical}/wrong-manifest.json"
mv "${canonical}/manifest.json" "${canonical}/valid-manifest.json"
mv "${canonical}/wrong-manifest.json" "${canonical}/manifest.json"
if run_publisher "${tmp_dir}/wrong-source" > "${tmp_dir}/wrong-source.log" 2>&1; then
  fail "canonical input from the wrong commit must fail"
fi
[ ! -s "${tmp_dir}/upload.log" ] || fail "wrong-source input reached publication"
mv "${canonical}/valid-manifest.json" "${canonical}/manifest.json"
printf 'corrupt package\n' > "${canonical}/package.tgz"
if run_publisher "${tmp_dir}/corrupt-package" > "${tmp_dir}/corrupt.log" 2>&1; then
  fail "corrupt canonical package must fail"
fi
grep -Fq 'CLI package digest does not match manifest' "${tmp_dir}/corrupt.log" \
  || fail "corruption must be rejected by the real artifact verifier"
[ ! -s "${tmp_dir}/upload.log" ] || fail "corrupt input reached publication"

echo 'publish-okou-cli-versioned-artifact-test: ok'
