#!/usr/bin/env bash
# Sourced by the App/Desktop fetch commands. Copy one immutable object with
# caller-owned diagnostics and retry settings; leave cleanup and traps to them.
# Usage: artifact_r2_copy_with_retry <source> <destination> <endpoint>
#                                  <error-log> <attempts> <delay-seconds>
artifact_r2_copy_with_retry() {
  local source_uri="$1"
  local destination_path="$2"
  local endpoint="$3"
  local error_log="$4"
  local max_attempts="$5"
  local retry_delay_seconds="$6"
  local attempt=1

  # R2 can break a transfer mid-stream (IncompleteRead). These copies are
  # idempotent, but a permanently missing object must fail without replay.
  while true; do
    if aws s3 cp \
      "$source_uri" \
      "$destination_path" \
      --endpoint-url "$endpoint" \
      --only-show-errors 2>"$error_log"; then
      return 0
    fi
    if grep -Eq '404|NotFound|Not Found|NoSuchKey' "$error_log"; then
      cat "$error_log" >&2
      return 1
    fi
    if (( attempt >= max_attempts )); then
      cat "$error_log" >&2
      return 1
    fi
    echo "::warning::R2 copy of $source_uri failed, retrying ($((attempt + 1))/${max_attempts})"
    cat "$error_log" >&2
    attempt=$((attempt + 1))
    sleep "$retry_delay_seconds"
  done
}
