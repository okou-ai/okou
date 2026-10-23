#!/usr/bin/env bash
set -euo pipefail

# Publish the already-authoritative Desktop manifest without deleting readers'
# current object. Arguments: S3 endpoint, bucket, manifest file, publication SHA.
# Requires AWS CLI, jq, Python 3 and the caller's existing R2 credentials.
if (( $# != 4 )) || [[ ! -f "$3" || ! "$4" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <r2-endpoint> <bucket> <manifest-file> <publication-sha>" >&2
  exit 2
fi
: "${AWS_ACCESS_KEY_ID:?R2 access key is required}"
: "${AWS_SECRET_ACCESS_KEY:?R2 secret key is required}"

endpoint=$1
bucket=$2
publication_sha=$4
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
cp "$3" "$work_dir/candidate.json"

digest=$(python3 - "$work_dir/candidate.json" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

body = Path(sys.argv[1]).read_bytes()
manifest = json.loads(body)
if manifest.get("schemaVersion") != 1 or manifest.get("product") != "okou":
    raise SystemExit("Desktop manifest has an unsupported schema or product")
print(hashlib.sha256(body).hexdigest())
PY
)
snapshot_key="desktop-updates/okou/publications/$publication_sha/$digest.json"

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

condition=(--if-none-match '*')
if get_object "$current_key"; then
  etag=$(jq -er '.ETag | select(type == "string" and length > 0)' "$work_dir/read-metadata.json")
  condition=(--if-match "$etag")
else
  code=$(error_code "$work_dir/read-error.json")
  if [[ "$code" != NoSuchKey ]]; then
    printf 'Cannot read the current Desktop manifest from R2: %s\n' "$code" >&2
    exit 1
  fi
fi

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
put_verified "$current_key" 'no-store' "${condition[@]}"
printf 'Verified Desktop manifest in R2: publication=%s sha256=%s\n' "$publication_sha" "$digest"
