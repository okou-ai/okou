#!/usr/bin/env bash

# Runner binary keys contain only URL-safe path components. Callers validate
# their manifests/run identity before reaching this private S3-compatible API.
runner_binary_r2_request() {
  local key=$1 output=$2 curl_status=0
  shift 2
  RUNNER_BINARY_R2_HTTP_STATUS=""
  # Disable curlrc and redirects; neither credentials nor raw error responses
  # belong in CI logs. Bound the entire operation, including transient retries.
  RUNNER_BINARY_R2_HTTP_STATUS=$(timeout --kill-after=5s 120s curl -q \
    --silent --fail --proto '=https' --globoff \
    --aws-sigv4 'aws:amz:auto:s3' \
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
    --connect-timeout 5 --max-time 60 --retry 2 --retry-max-time 90 \
    --output "$output" --write-out '%{http_code}' \
    "$@" \
    "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${key}" \
    2>/dev/null) || curl_status=$?
  # --fail discards HTTP error bodies, allowing upload retries with /dev/null
  # (curl 8.5 cannot truncate that device). Retain HTTP errors for the caller's
  # status checks, especially conditional PUT's 412; transport errors still fail.
  [ "$curl_status" -eq 0 ] || [ "$curl_status" -eq 22 ]
}

runner_binary_r2_head() {
  runner_binary_r2_request "$1" "$2" --head || return 1
  [ "$RUNNER_BINARY_R2_HTTP_STATUS" = 200 ]
}

runner_binary_r2_get() {
  local key=$1 output=$2 max_bytes=$3
  # Request one extra byte so callers can detect oversized objects. The local
  # limit also bounds responses from a server that ignores Range.
  runner_binary_r2_request "$key" "$output" \
    --range "0-${max_bytes}" --max-filesize "$((max_bytes + 1))" || return 1
  [[ "$RUNNER_BINARY_R2_HTTP_STATUS" = 200 || "$RUNNER_BINARY_R2_HTTP_STATUS" = 206 ]]
}

runner_binary_r2_put() {
  local key=$1 body=$2 content_type=$3 cache_control=$4 conditional=${5:-false}
  local payload_sha
  local -a headers=()
  payload_sha=$(sha256sum "$body" | cut -d' ' -f1) || return 1
  if [ "$conditional" = true ]; then
    headers+=(--header 'If-None-Match: *')
  fi
  # Supply the hash explicitly: curl streams --upload-file instead of buffering
  # it to calculate a payload hash. R2 verifies the same bytes we signed.
  runner_binary_r2_request "$key" /dev/null --upload-file "$body" \
    --header "x-amz-content-sha256: ${payload_sha}" \
    --header "Content-Type: ${content_type}" --header "Cache-Control: ${cache_control}" \
    "${headers[@]}" || return 1
  # Only an actual HTTP 412 can mean an existing immutable binary. Callers must
  # still read back and validate it before advertising readiness.
  [ "$RUNNER_BINARY_R2_HTTP_STATUS" = 200 ] ||
    { [ "$conditional" = true ] && [ "$RUNNER_BINARY_R2_HTTP_STATUS" = 412 ]; }
}
