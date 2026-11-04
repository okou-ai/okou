#!/usr/bin/env bash

# Sourced helpers for Runner binary requests. Never expose raw AWS diagnostics.
runner_binary_r2_category() {
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
      RequestTimeout|RequestTimeoutException|InternalError|InternalFailure|ServiceUnavailable|ConditionalRequestConflict|500|502|503|504)
        echo service ;;
      AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|ExpiredToken|InvalidToken|401|403)
        echo authorization ;;
      NoSuchKey|NotFound|404) echo missing ;;
      PreconditionFailed|412) echo precondition ;;
      NoSuchBucket|InvalidArgument|InvalidRequest|InvalidRange|ParamValidation|Configuration|NoCredentials|NoRegion)
        echo configuration ;;
      *) echo unknown ;;
    esac
  else
    # Only SDK-owned prefixes identify transport errors; provider Message text
    # cannot turn an authorization/unknown error into a replayable request.
    local prefix='^[[:space:]]*(aws: \[ERROR\]: )?'
    local connection="${prefix}Could not connect to the endpoint URL:"
    local connect_timeout="${prefix}Connect timeout on endpoint URL:"
    local read_timeout="${prefix}Read timeout on endpoint URL:"
    local transport="${prefix}(Connection was closed before we received a valid response from endpoint URL:|An error occurred while reading from response stream:)"
    local incomplete="${prefix}[0-9]+ read, but total bytes expected is [0-9]+[[:space:]]*$"
    if [[ "$diagnostic" =~ $connect_timeout ]]; then
      echo connect-timeout
    elif [[ "$diagnostic" =~ $connection ]]; then
      echo connection
    elif [[ "$diagnostic" =~ $read_timeout ]]; then
      echo read-timeout
    elif [[ "$diagnostic" =~ $transport || "$diagnostic" =~ $incomplete ]]; then
      echo transport
    else
      echo unknown
    fi
  fi
}

runner_binary_r2_retryable() {
  case "$1" in
    timeout|connect-timeout|connection|read-timeout|transport|throttled|service) return 0 ;;
    *) return 1 ;;
  esac
}

# Transport passes the same absolute deadline to its publisher subprocess.
# Direct cache publication gets the same budget. Consumers own other budgets.
runner_binary_r2_publication_init() {
  local now
  now=$(date +%s)
  if [ -z "${RUNNER_BINARY_PUBLICATION_DEADLINE:-}" ]; then
    export RUNNER_BINARY_PUBLICATION_DEADLINE=$((now + 180))
  elif [[ ! "$RUNNER_BINARY_PUBLICATION_DEADLINE" =~ ^[1-9][0-9]{0,10}$ ]] ||
    [ "$RUNNER_BINARY_PUBLICATION_DEADLINE" -gt "$((now + 180))" ]; then
    echo 'invalid Runner binary publication deadline' >&2
    return 2
  fi
}

runner_binary_r2_cancel() {
  local status=$1
  trap '' INT TERM HUP
  if [ -n "$request_pid" ]; then
    if [ "$request_policy" = forward ]; then
      # Let the publisher retire its separately supervised AWS process group
      # and remove its files before this outer timeout's kill-after deadline.
      kill -TERM "$request_pid" 2>/dev/null || true
    else
      kill -KILL -- "-$request_pid" 2>/dev/null || kill -KILL "$request_pid" 2>/dev/null || true
    fi
    wait "$request_pid" 2>/dev/null || true
  fi
  printf 'R2 publication stage=%s target=%s category=cancelled exit=%s\n' \
    "$stage" "$EXPECTED_TARGET" "$status" >&2
  exit "$status"
}

# Supervise both AWS requests and the publisher subprocess. GNU timeout owns
# their process groups; cancellation must also retire TERM-resistant children.
runner_binary_r2_run() {
  local stage=$1 limit=$2 output=$3 errors=$4 request_policy=$5
  shift 5
  local remaining status=0 request_pid='' previous_traps
  remaining=$((RUNNER_BINARY_PUBLICATION_DEADLINE - $(date +%s) - 5))
  if [ "$remaining" -le 0 ]; then
    printf 'R2 publication stage=%s target=%s category=budget exit=124\n' \
      "$stage" "$EXPECTED_TARGET" >&2
    return 124
  fi
  [ "$limit" -le "$remaining" ] || limit=$remaining
  previous_traps=$(trap -p INT TERM HUP)
  trap 'runner_binary_r2_cancel 130' INT
  trap 'runner_binary_r2_cancel 143' TERM
  trap 'runner_binary_r2_cancel 129' HUP
  if [ "$output" = - ]; then
    timeout --kill-after=5s "${limit}s" "$@" &
  else
    timeout --kill-after=5s "${limit}s" "$@" >"$output" 2>"$errors" &
  fi
  request_pid=$!
  wait "$request_pid" 2>/dev/null || status=$?
  request_pid=
  trap - INT TERM HUP
  eval "$previous_traps"
  return "$status"
}

runner_binary_r2_request() {
  local stage=$1 attempt=$2 output=$3 errors=$4
  shift 4
  local started=$SECONDS status=0
  printf 'R2 publication stage=%s target=%s attempt=%s/3 event=start\n' \
    "$stage" "$EXPECTED_TARGET" "$attempt" >&2
  runner_binary_r2_run "$stage" 60 "$output" "$errors" kill \
    env AWS_MAX_ATTEMPTS=1 AWS_RETRY_MODE=standard AWS_CLI_ERROR_FORMAT=json \
    AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off \
    aws s3api "$@" \
    --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    --bucket "$R2_BUCKET_NAME" --cli-connect-timeout 5 --cli-read-timeout 30 || status=$?
  RUNNER_R2_CATEGORY=success
  if [ "$status" -ne 0 ]; then
    RUNNER_R2_CATEGORY=$(runner_binary_r2_category "$status" "$errors")
  fi
  printf 'R2 publication stage=%s target=%s attempt=%s/3 elapsed=%ss exit=%s category=%s\n' \
    "$stage" "$EXPECTED_TARGET" "$attempt" "$((SECONDS - started))" \
    "$status" "$RUNNER_R2_CATEGORY" >&2
  return "$status"
}

runner_binary_r2_backoff() {
  # The same supervisor makes backoff cancellable and includes it in the budget.
  runner_binary_r2_run backoff 3 /dev/null /dev/null kill sleep "$1"
}

runner_binary_r2_read() {
  local stage=$1 output=$2 errors=$3
  shift 3
  local attempt status=1
  for attempt in 1 2 3; do
    if [ "$1" = get-object ]; then
      rm -f "${@: -1}"
    fi
    status=0
    runner_binary_r2_request "$stage" "$attempt" "$output" "$errors" "$@" || status=$?
    [ "$status" -ne 0 ] || return 0
    runner_binary_r2_retryable "$RUNNER_R2_CATEGORY" || break
    [ "$attempt" -lt 3 ] || break
    runner_binary_r2_backoff "$attempt" || return $?
  done
  return "$status"
}

# A failed write can already have committed. Establishment failures can retry
# directly; other transient outcomes first inspect the exact object identity.
# An existing object is NEVER rewritten here: the caller must verify its bytes.
runner_binary_r2_put() {
  local stage=$1 key=$2 body=$3 mode=$4 work=$5
  shift 5
  local attempt status=1
  local conditional=()
  export RUNNER_R2_PUT_RESULT
  [ "$mode" != create ] || conditional=(--if-none-match '*')
  for attempt in 1 2 3; do
    status=0
    runner_binary_r2_request "$stage" "$attempt" "${work}/put.out" "${work}/put.err" \
      put-object --key "$key" --body "$body" "${conditional[@]}" "$@" || status=$?
    if [ "$status" -eq 0 ]; then
      RUNNER_R2_PUT_RESULT=uploaded
      return 0
    fi
    if [ "$mode" = create ] && [ "$RUNNER_R2_CATEGORY" = precondition ]; then
      RUNNER_R2_PUT_RESULT=existing-validated
      return 0
    fi
    runner_binary_r2_retryable "$RUNNER_R2_CATEGORY" || return "$status"
    case "$RUNNER_R2_CATEGORY" in
      connection|connect-timeout) ;;
      *)
        if runner_binary_r2_read "${stage}-recover" "${work}/recover.out" "${work}/recover.err" \
          head-object --key "$key" --output json; then
          RUNNER_R2_PUT_RESULT=existing-validated
          return 0
        fi
        [ "$RUNNER_R2_CATEGORY" = missing ] || return "$status"
        ;;
    esac
    [ "$attempt" -lt 3 ] || break
    runner_binary_r2_backoff "$attempt" || return $?
  done
  return "$status"
}
