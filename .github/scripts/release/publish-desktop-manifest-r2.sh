#!/usr/bin/env bash
set -euo pipefail

# Advance the R2-owned manifest and export the verified publication bytes.
# Requires AWS CLI, jq, Python 3, Node.js and R2 credentials.
if (( $# != 6 )) || [[ ! "$4" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <r2-endpoint> <bucket> <verified-manifest-file> <publication-sha> <version> <zip-url>" >&2
  exit 2
fi
: "${AWS_ACCESS_KEY_ID:?R2 access key is required}"
: "${AWS_SECRET_ACCESS_KEY:?R2 secret key is required}"

endpoint=$1
bucket=$2
publication_sha=$4
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
current_key=desktop-updates/okou/manifest.json
work_dir=$(mktemp -d)
aws_pid=
cleanup() {
  if [[ -n "$aws_pid" ]]; then
    kill "$aws_pid" 2>/dev/null || true
    wait "$aws_pid" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# A failed PUT may have committed. Never replay it automatically: read back the
# exact bytes instead. Per-request timeouts bound both reads and writes.
export AWS_MAX_ATTEMPTS=1 AWS_RETRY_MODE=standard AWS_CLI_ERROR_FORMAT=json
export AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
export AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
export AWS_RESPONSE_CHECKSUM_VALIDATION=WHEN_REQUIRED
s3_args=(--endpoint-url "$endpoint" --bucket "$bucket" --output json
  --cli-connect-timeout 5 --cli-read-timeout 20 --no-cli-pager)
run_aws() {
  local status=0
  aws s3api "$@" "${s3_args[@]}" &
  aws_pid=$!
  wait "$aws_pid" || status=$?
  aws_pid=
  return "$status"
}
get_object() {
  run_aws get-object --key "$1" "$work_dir/read.json" \
    >"$work_dir/read-metadata.json" 2>"$work_dir/read-error.json"
}
error_code() {
  jq -er '(.Error.Code // .Code) | select(type == "string" and test("^[A-Za-z0-9_]+$"))' \
    "$1" 2>/dev/null || printf 'unknown\n'
}

# Stage one must have bootstrapped this object. A missing or unreadable R2 source
# is a publication failure; GitHub cannot reconstruct the authoritative history.
if ! get_object "$current_key"; then
  code=$(error_code "$work_dir/read-error.json")
  printf 'Cannot read the current Desktop manifest from R2: %s\n' "$code" >&2
  exit 1
fi
etag=$(jq -er '.ETag | select(type == "string" and length > 0)' "$work_dir/read-metadata.json")
cp "$work_dir/read.json" "$work_dir/candidate.json"
jq -e '.schemaVersion == 1 and .product == "okou"' "$work_dir/candidate.json" >/dev/null
node "$repo_root/desktop/scripts/update-desktop-release-manifest.mjs" \
  --manifest "$work_dir/candidate.json" --version "$5" --zip-url "$6" \
  --channel stable --platform darwin --arch arm64
digest=$(python3 - "$work_dir/candidate.json" <<'PY'
import hashlib
import sys
from pathlib import Path

print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)
snapshot_key="desktop-updates/okou/publications/$publication_sha/$digest.json"

put_verified() {
  local key=$1 cache_control=$2 status=0
  shift 2
  run_aws put-object --key "$key" --body "$work_dir/candidate.json" \
    --content-type application/json --cache-control "$cache_control" \
    --metadata "publication-sha=$publication_sha,manifest-sha256=$digest" "$@" \
    >"$work_dir/put-metadata.json" 2>"$work_dir/put-error.json" || status=$?
  if ! get_object "$key" || ! cmp -s "$work_dir/candidate.json" "$work_dir/read.json"; then
    printf 'Desktop manifest R2 publication could not be verified: put_exit=%s code=%s\n' \
      "$status" "$(error_code "$work_dir/put-error.json")" >&2
    return 1
  fi
}

# Verify an immutable receipt before replacing the complete current document.
# If a conditional write loses a race, only matching published bytes count as
# success; a different revision remains untouched and this job fails.
put_verified "$snapshot_key" 'public, max-age=31536000, immutable' --if-none-match '*'
# Match the ETag of the document used to construct this candidate, including
# changes that raced with construction rather than only the final PUT.
put_verified "$current_key" 'no-store' --if-match "$etag"
cp "$work_dir/candidate.json" "$3"
printf 'Verified Desktop manifest in R2: publication=%s sha256=%s\n' "$publication_sha" "$digest"
