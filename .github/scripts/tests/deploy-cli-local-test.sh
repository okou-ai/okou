#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
deploy_script="${repo_root}/scripts/deploy-cli-local.sh"
build_script="${repo_root}/.github/scripts/build-okou-cli-artifact.sh"
verify_script="${repo_root}/.github/scripts/verify-okou-cli-artifact.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

test_root="${tmp_dir}/repo"
mkdir -p \
  "${test_root}/scripts" \
  "${test_root}/.github/scripts" \
  "${test_root}/turbo/apps/cli/dist/migrations" \
  "${test_root}/turbo/apps/cli/dist" \
  "${test_root}/turbo/packages/pi-agent-runtime" \
  "${test_root}/turbo/patches" \
  "${test_root}/bin"

ln -s "$deploy_script" "${test_root}/scripts/deploy-cli-local.sh"
ln -s "$build_script" "${test_root}/.github/scripts/build-okou-cli-artifact.sh"
ln -s "$verify_script" "${test_root}/.github/scripts/verify-okou-cli-artifact.sh"

cat >"${test_root}/scripts/.env.local" <<'EOF'
R2_ACCOUNT_ID=test-account
R2_ACCESS_KEY_ID=wrong-access-key
R2_SECRET_ACCESS_KEY=wrong-secret-key
R2_STATIC_ACCESS_KEY_ID=static-access-key
R2_STATIC_SECRET_ACCESS_KEY=static-secret-key
EOF

cat >"${test_root}/scripts/cn.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'test.identity\n'
EOF
chmod +x "${test_root}/scripts/cn.sh"

cat >"${test_root}/turbo/apps/cli/dist/package.json" <<'EOF'
{
  "name": "@okouai/cli",
  "version": "1.0.0",
  "private": true,
  "bin": { "okou": "okou.js" },
  "files": ["*.js", "*.wasm", "migrations/*.sql"]
}
EOF
printf '#!/usr/bin/env node\n' >"${test_root}/turbo/apps/cli/dist/okou.js"
printf 'worker\n' \
  >"${test_root}/turbo/apps/cli/dist/image-resize-worker.js"
printf 'wasm\n' >"${test_root}/turbo/apps/cli/dist/photon_rs_bg.wasm"
printf 'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY);\n' \
  >"${test_root}/turbo/apps/cli/dist/migrations/001_initial.sql"

# The artifact manifest carries the bundled runtime and patched Pi SDK versions,
# so the local deploy needs the same sources the release build reads.
cat >"${test_root}/turbo/packages/pi-agent-runtime/package.json" <<'EOF'
{
  "name": "@okouai/pi-agent-runtime",
  "version": "1.36.0",
  "private": true,
  "dependencies": {
    "@earendil-works/pi-ai": "0.86.1",
    "@earendil-works/pi-coding-agent": "0.86.1"
  }
}
EOF
printf 'patch fixture\n' \
  >"${test_root}/turbo/patches/@earendil-works__pi-coding-agent@0.86.1.patch"

cat >"${test_root}/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
EOF

cat >"${test_root}/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"${PNPM_LOG:?}"
EOF

cat >"${test_root}/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

endpoint=""
bucket=""
key=""
body=""
content_type=""
cache_control=""
while (( $# )); do
  case "$1" in
    --endpoint-url) endpoint="$2"; shift 2 ;;
    --bucket) bucket="$2"; shift 2 ;;
    --key) key="$2"; shift 2 ;;
    --body) body="$2"; shift 2 ;;
    --content-type) content_type="$2"; shift 2 ;;
    --cache-control) cache_control="$2"; shift 2 ;;
    *) shift ;;
  esac
done

{
  printf 'endpoint=%s\n' "$endpoint"
  printf 'bucket=%s\n' "$bucket"
  printf 'key=%s\n' "$key"
  printf 'content_type=%s\n' "$content_type"
  printf 'cache_control=%s\n' "$cache_control"
  printf 'access_key=%s\n' "${AWS_ACCESS_KEY_ID:?}"
  printf 'secret_key=%s\n' "${AWS_SECRET_ACCESS_KEY:?}"
  printf 'region=%s\n' "${AWS_DEFAULT_REGION:?}"
} >"${AWS_LOG:?}"
cp "$body" "${UPLOADED_PACKAGE:?}"
EOF

chmod +x "${test_root}/bin/git" "${test_root}/bin/pnpm" "${test_root}/bin/aws"

output="$({
  PATH="${test_root}/bin:${PATH}" \
    PNPM_LOG="${tmp_dir}/pnpm.log" \
    AWS_LOG="${tmp_dir}/aws.log" \
    UPLOADED_PACKAGE="${tmp_dir}/package.tgz" \
    bash "${test_root}/scripts/deploy-cli-local.sh"
})"

grep -Fxq -- '--filter @okouai/cli build' "${tmp_dir}/pnpm.log"
grep -Fxq 'endpoint=https://test-account.r2.cloudflarestorage.com' "${tmp_dir}/aws.log"
grep -Fxq 'bucket=vm0-static-dev' "${tmp_dir}/aws.log"
grep -Fxq 'key=okou-cli/local/test.identity/package.tgz' "${tmp_dir}/aws.log"
grep -Fxq 'content_type=application/gzip' "${tmp_dir}/aws.log"
grep -Fxq 'cache_control=no-store' "${tmp_dir}/aws.log"
grep -Fxq 'access_key=static-access-key' "${tmp_dir}/aws.log"
grep -Fxq 'secret_key=static-secret-key' "${tmp_dir}/aws.log"
grep -Fxq 'region=auto' "${tmp_dir}/aws.log"
grep -Fxq 'CLI_PKG_URL=https://static.vm7.io/okou-cli/local/test.identity/package.tgz' <<<"$output"

package_json="$(tar -xOf "${tmp_dir}/package.tgz" package/package.json)"
jq -e '
  .name == "@okouai/cli"
  and .private == true
  and ((.bin | keys) == ["okou"])
  and .bin.okou == "okou.js"
  and (.files | index("*.wasm") != null)
' <<<"$package_json" >/dev/null

echo "deploy-cli-local tests passed"
