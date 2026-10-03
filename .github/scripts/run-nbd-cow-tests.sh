#!/usr/bin/env bash
set -euo pipefail

REMOTE="${METAL_USER:?}@${HOST:?}"
REMOTE_PREFIX="/tmp/nbd-cow-test-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-${RUNNER_HOST_GROUP_ID:?}"

for upload_attempt in 1 2 3; do
  # A disconnected uploader may still write remotely. Give every attempt its
  # own candidate so it cannot corrupt the binary selected by a later upload.
  REMOTE_BIN="${REMOTE_PREFIX}-${upload_attempt}"
  echo "nbd-cow upload: host=${HOST} attempt=${upload_attempt}/3 candidate=${REMOTE_BIN}"
  if OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS=60 \
    scp "${TEST_BIN:?}" "${REMOTE}:${REMOTE_BIN}"; then
    break
  else
    upload_status=$?
  fi

  echo "nbd-cow upload failed: host=${HOST} attempt=${upload_attempt}/3 status=${upload_status}" >&2
  case "$upload_status" in
    124|141|255) ;; # Operation timeout, broken pipe, or SSH transport failure.
    *) exit "$upload_status" ;;
  esac
  if [ "$upload_attempt" -eq 3 ]; then
    exit "$upload_status"
  fi
done

# Only the upload is replay-safe. Submit the actual test command exactly once.
ssh "$REMOTE" bash -s -- "$REMOTE_PREFIX" "$REMOTE_BIN" <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE_PREFIX=$1
REMOTE_BIN=$2
trap 'rm -f "${REMOTE_PREFIX}-1" "${REMOTE_PREFIX}-2" "${REMOTE_PREFIX}-3"' EXIT
sudo modprobe nbd nbds_max=4096
sudo "$REMOTE_BIN" --ignored --test-threads=1
REMOTE_SCRIPT
