#!/usr/bin/env bash

# Sourced by required Runner binary consumers. Publication and validation stay
# with the caller; only complete, read-only GET attempts are retried here.
runner_binary_download_category() {
  local status=$1 error_file=$2 diagnostic code
  if [ "$status" -eq 124 ]; then
    echo timeout
    return
  fi
  case "$status" in
    252|253) echo configuration; return ;;
    1[2-9][0-9]) echo process; return ;;
  esac
  diagnostic=$(head -c 8192 "$error_file")
  if code=$(jq -er '(.Error.Code // .Code) | select(type == "string")' \
    <<<"$diagnostic" 2>/dev/null); then
    case "$code" in
      SlowDown|Throttling|ThrottlingException|TooManyRequestsException|429)
        echo throttled ;;
      RequestTimeout|RequestTimeoutException|InternalError|InternalFailure|ServiceUnavailable|500|502|503|504)
        echo service ;;
      AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|ExpiredToken|InvalidToken|401|403)
        echo authorization ;;
      NoSuchKey|NoSuchBucket|NotFound|404) echo missing ;;
      InvalidArgument|InvalidRequest|InvalidRange|ParamValidation|Configuration|NoCredentials|NoRegion)
        echo configuration ;;
      *) echo unknown ;;
    esac
  else
    # AWS CLI structures service/configuration errors, but its general exception
    # handler still prints Botocore transport errors as text. Match only these
    # SDK-owned prefixes, never a substring from a provider's Message field.
    local transport_pattern='^[[:space:]]*(aws: \[ERROR\]: )?(Could not connect to the endpoint URL:|Connection was closed before we received a valid response from endpoint URL:|Read timeout on endpoint URL:|Connect timeout on endpoint URL:|An error occurred while reading from response stream:)'
    local incomplete_pattern='^[[:space:]]*(aws: \[ERROR\]: )?[0-9]+ read, but total bytes expected is [0-9]+[[:space:]]*$'
    if [[ "$diagnostic" =~ $transport_pattern || "$diagnostic" =~ $incomplete_pattern ]]; then
      echo transport
    else
      echo unknown
    fi
  fi
}

runner_binary_download_cancel() {
  local status=$1
  trap '' INT TERM HUP
  if [ -n "$download_pid" ]; then
    # GNU timeout owns a separate process group. Killing that group also stops
    # a CLI ignoring TERM; a backoff sleep is a single directly owned process.
    if [ "$download_group" = true ]; then
      kill -KILL -- "-$download_pid" 2>/dev/null || kill -KILL "$download_pid" 2>/dev/null || true
    else
      kill -KILL "$download_pid" 2>/dev/null || true
    fi
    wait "$download_pid" 2>/dev/null || true
  fi
  rm -rf "$download_tmp"
  printf 'R2 GET operation=%s target=%s category=cancelled exit=%s\n' \
    "$operation" "$EXPECTED_TARGET" "$status" >&2
  exit "$status"
}

runner_binary_download() {
  local operation=$1 object_key=$2 range=$3 destination=$4 attempt_limit=$5 budget=$6
  local download_tmp download_pid='' download_group=false previous_traps
  local started=$SECONDS attempt=0 deadline status=1 category=unknown bytes partial errors
  download_tmp=$(mktemp -d "$(dirname "$destination")/runner-r2-get.XXXXXX")
  previous_traps=$(trap -p INT TERM HUP)
  trap 'runner_binary_download_cancel 130' INT
  trap 'runner_binary_download_cancel 143' TERM
  trap 'runner_binary_download_cancel 129' HUP

  while [ "$attempt" -lt 3 ]; do
    # Include GNU timeout's termination grace in the total transfer budget.
    deadline=$((budget - (SECONDS - started) - 5))
    if [ "$deadline" -le 0 ]; then
      category=budget
      status=124
      break
    fi
    [ "$deadline" -le "$attempt_limit" ] || deadline=$attempt_limit
    attempt=$((attempt + 1))
    partial="${download_tmp}/attempt-${attempt}.partial"
    errors="${download_tmp}/attempt-${attempt}.err"
    download_group=true
    AWS_MAX_ATTEMPTS=1 AWS_RETRY_MODE=standard AWS_CLI_ERROR_FORMAT=json \
      AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off \
      timeout --kill-after=5s "${deadline}s" aws s3api get-object \
      --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
      --bucket "$R2_BUCKET_NAME" --key "$object_key" --range "$range" \
      --cli-connect-timeout 5 --cli-read-timeout 30 \
      "$partial" >/dev/null 2>"$errors" &
    download_pid=$!
    status=0
    wait "$download_pid" 2>/dev/null || status=$?
    download_pid=
    bytes=0
    [ ! -f "$partial" ] || bytes=$(stat -c '%s' "$partial")
    if [ "$status" -eq 0 ]; then
      category=success
    else
      category=$(runner_binary_download_category "$status" "$errors")
    fi
    printf 'R2 GET operation=%s target=%s attempt=%s/3 elapsed=%ss bytes=%s exit=%s category=%s\n' \
      "$operation" "$EXPECTED_TARGET" "$attempt" "$((SECONDS - started))" \
      "$bytes" "$status" "$category" >&2
    if [ "$status" -eq 0 ]; then
      mv "$partial" "$destination"
      break
    fi
    rm -f "$partial" "$errors"
    case "$category" in
      timeout|throttled|service|transport) ;;
      *) break ;;
    esac
    [ "$attempt" -lt 3 ] || break
    if [ "$((SECONDS - started + attempt + 5))" -ge "$budget" ]; then
      category=budget
      break
    fi
    download_group=false
    sleep "$attempt" &
    download_pid=$!
    wait "$download_pid"
    download_pid=
  done

  rm -rf "$download_tmp"
  trap - INT TERM HUP
  eval "$previous_traps"
  if [ "$status" -ne 0 ]; then
    printf 'R2 GET failed operation=%s target=%s attempts=%s/3 elapsed=%ss category=%s exit=%s\n' \
      "$operation" "$EXPECTED_TARGET" "$attempt" "$((SECONDS - started))" "$category" "$status" >&2
  fi
  return "$status"
}
