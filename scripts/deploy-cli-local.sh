#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.local"
R2_BUCKET_NAME="vm0-static-dev"
STATIC_BASE_URL="https://static.vm7.io"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE; run ./scripts/sync-env.sh first" >&2
  exit 1
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI is required to upload the local CLI package" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required in scripts/.env.local}"
: "${R2_STATIC_ACCESS_KEY_ID:?R2_STATIC_ACCESS_KEY_ID is required in scripts/.env.local}"
: "${R2_STATIC_SECRET_ACCESS_KEY:?R2_STATIC_SECRET_ACCESS_KEY is required in scripts/.env.local}"

identity="$("$SCRIPT_DIR/cn.sh" -u)"
if [[ ! "$identity" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]]; then
  echo "Local CLI identity contains unsupported characters: $identity" >&2
  exit 1
fi

artifact_dir="$(mktemp -d)"
trap 'rm -rf "$artifact_dir"' EXIT
commit_sha="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"

(
  cd "$PROJECT_ROOT/turbo"
  pnpm --filter @okouai/cli build
)
(
  cd "$PROJECT_ROOT"
  bash .github/scripts/artifacts/build-okou-cli-artifact.sh "$commit_sha" "$artifact_dir"
)

object_key="okou-cli/local/${identity}/package.tgz"
r2_endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
AWS_ACCESS_KEY_ID="$R2_STATIC_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_STATIC_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3api put-object \
    --endpoint-url "$r2_endpoint" \
    --bucket "$R2_BUCKET_NAME" \
    --key "$object_key" \
    --body "$artifact_dir/package.tgz" \
    --content-type application/gzip \
    --cache-control "no-store"

echo "CLI_PKG_URL=${STATIC_BASE_URL}/${object_key}"
