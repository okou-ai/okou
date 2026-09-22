#!/usr/bin/env bash
# Publish the release commit's CLI artifact under its version.
#
# The commit-addressed artifact at okou-cli/<sha>/ is built by deploy-cli for
# every commit. A release additionally publishes the same bytes at
# okou-cli/v<cli version>/ so the runner rootfs can install the CLI by version.
# The versioned path is immutable: publishing a different bundle under an
# existing version fails the release, because one version must identify exactly
# one runtime build for API-first handoff parity.
#
# Required env:
#   ARTIFACT_SHA            full lowercase release commit SHA
#   RELEASE_MANIFEST_PATH   .release-please-manifest.json at that commit
#   CLI_STATIC_BASE_URL     public base URL of the static bucket
#   R2_ACCOUNT_ID, R2_BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# Optional env:
#   OUTPUT_DIR              where the downloaded commit artifact is kept
#   WAIT_ATTEMPTS           ready.json polls, 10s apart (default 60)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

for name in ARTIFACT_SHA RELEASE_MANIFEST_PATH CLI_STATIC_BASE_URL R2_ACCOUNT_ID R2_BUCKET_NAME AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  require_env "$name"
done

if [[ ! "$ARTIFACT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "CLI artifact commit must be a full lowercase SHA-1: $ARTIFACT_SHA" >&2
  exit 1
fi

release_version_pattern='^[0-9]+\.[0-9]+\.[0-9]+$'
cli_version="$(jq -er '."turbo/apps/cli"' "$RELEASE_MANIFEST_PATH")"
pi_agent_runtime_version="$(jq -er '."turbo/packages/pi-agent-runtime"' "$RELEASE_MANIFEST_PATH")"
for pair in "cli:$cli_version" "pi-agent-runtime:$pi_agent_runtime_version"; do
  if [[ ! "${pair#*:}" =~ $release_version_pattern ]]; then
    echo "release manifest ${pair%%:*} version must be MAJOR.MINOR.PATCH: ${pair#*:}" >&2
    exit 1
  fi
done

output_dir="${OUTPUT_DIR:-$(mktemp -d)}"
mkdir -p "$output_dir"
commit_base_url="${CLI_STATIC_BASE_URL}/okou-cli/${ARTIFACT_SHA}"
wait_attempts="${WAIT_ATTEMPTS:-60}"
for attempt in $(seq 1 "$wait_attempts"); do
  if curl -fsSL "${commit_base_url}/ready.json" --output "${output_dir}/ready.json"; then
    break
  fi
  if (( attempt == wait_attempts )); then
    echo "CLI artifact was not ready after ${wait_attempts} attempts: $commit_base_url" >&2
    exit 1
  fi
  echo "Waiting for CLI artifact: $commit_base_url (attempt ${attempt}/${wait_attempts})"
  sleep 10
done
curl -fsSL "${commit_base_url}/manifest.json" --output "${output_dir}/manifest.json"
curl -fsSL "${commit_base_url}/package.tgz" --output "${output_dir}/package.tgz"
bash "${SCRIPT_DIR}/verify-okou-cli-artifact.sh" "$output_dir" "$ARTIFACT_SHA"

# The bundle must carry the versions this release tagged. A mismatch means the
# release manifest and the packed sources disagree, so the versioned path would
# not identify the build it claims to.
artifact_cli_version="$(jq -er '.versions.cli' "${output_dir}/manifest.json")"
artifact_runtime_version="$(jq -er '.versions.piAgentRuntime' "${output_dir}/manifest.json")"
if [[ "$artifact_cli_version" != "$cli_version" ]]; then
  echo "CLI artifact reports cli ${artifact_cli_version} but the release manifest tags ${cli_version}" >&2
  exit 1
fi
if [[ "$artifact_runtime_version" != "$pi_agent_runtime_version" ]]; then
  echo "CLI artifact reports pi-agent-runtime ${artifact_runtime_version} but the release manifest tags ${pi_agent_runtime_version}" >&2
  exit 1
fi
package_sha256="$(jq -er '.package.sha256' "${output_dir}/manifest.json")"

r2_endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
versioned_prefix="okou-cli/v${cli_version}"
versioned_base_url="${CLI_STATIC_BASE_URL}/${versioned_prefix}"
cache_control="public, max-age=31536000, immutable"

error_log="$(mktemp)"
set +e
aws s3api head-object \
  --endpoint-url "$r2_endpoint" \
  --bucket "$R2_BUCKET_NAME" \
  --key "${versioned_prefix}/ready.json" \
  >/dev/null 2>"$error_log"
head_status=$?
set -e
if (( head_status == 0 )); then
  existing_dir="$(mktemp -d)"
  aws s3api get-object \
    --endpoint-url "$r2_endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "${versioned_prefix}/manifest.json" \
    "${existing_dir}/manifest.json" >/dev/null
  existing_sha256="$(jq -er '.package.sha256' "${existing_dir}/manifest.json")"
  existing_commit="$(jq -er '.commitSha' "${existing_dir}/manifest.json")"
  if [[ "$existing_sha256" != "$package_sha256" ]]; then
    cat >&2 <<MESSAGE
CLI version ${cli_version} is already published from commit ${existing_commit} with a different bundle.
  published package sha256: ${existing_sha256}
  this release's package sha256: ${package_sha256}
A version must identify exactly one CLI build. Release a commit that advances
@okouai/cli (or @okouai/pi-agent-runtime, which bumps the CLI) before publishing.
MESSAGE
    exit 1
  fi
  echo "CLI ${cli_version} already published with identical bytes from ${existing_commit}; keeping ${versioned_base_url}/"
elif grep -Eq '404|NotFound|Not Found|NoSuchKey' "$error_log"; then
  aws s3api put-object \
    --endpoint-url "$r2_endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "${versioned_prefix}/package.tgz" \
    --body "${output_dir}/package.tgz" \
    --content-type application/gzip \
    --cache-control "$cache_control" >/dev/null
  aws s3api put-object \
    --endpoint-url "$r2_endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "${versioned_prefix}/manifest.json" \
    --body "${output_dir}/manifest.json" \
    --content-type application/json \
    --cache-control "$cache_control" >/dev/null
  aws s3api put-object \
    --endpoint-url "$r2_endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "${versioned_prefix}/ready.json" \
    --body "${output_dir}/ready.json" \
    --content-type application/json \
    --cache-control "$cache_control" \
    --if-none-match "*" >/dev/null
  echo "Published CLI ${cli_version} from ${ARTIFACT_SHA} at ${versioned_base_url}/"
else
  cat "$error_log" >&2
  exit "$head_status"
fi

# Read back through the CDN so the runner hosts see what was published.
cdn_dir="$(mktemp -d)"
for filename in package.tgz manifest.json ready.json; do
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors \
    "${versioned_base_url}/${filename}" --output "${cdn_dir}/${filename}"
done
cdn_sha256="$(sha256sum "${cdn_dir}/package.tgz" | cut -d ' ' -f 1)"
if [[ "$cdn_sha256" != "$package_sha256" ]]; then
  echo "CDN copy of ${versioned_base_url}/package.tgz has sha256 ${cdn_sha256}, expected ${package_sha256}" >&2
  exit 1
fi

emit() {
  printf '%s=%s\n' "$1" "$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
}
emit "cli-version" "$cli_version"
emit "pi-agent-runtime-version" "$pi_agent_runtime_version"
emit "package-url" "${versioned_base_url}/package.tgz"
emit "manifest-url" "${versioned_base_url}/manifest.json"
emit "package-sha256" "$package_sha256"
