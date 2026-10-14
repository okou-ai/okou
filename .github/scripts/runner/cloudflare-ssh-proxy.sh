#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "Usage: $0 <host>" >&2
  exit 2
fi

CF_ACCESS_ENV_FILE="${CF_ACCESS_ENV_FILE:-$HOME/.ssh/cf-access.env}"
if [ ! -f "$CF_ACCESS_ENV_FILE" ]; then
  echo "::error title=Cloudflare Access SSH not configured::Missing credentials file at ${CF_ACCESS_ENV_FILE}" >&2
  exit 2
fi

# shellcheck source=/dev/null
source "$CF_ACCESS_ENV_FILE"

if [ -z "${CF_ACCESS_CLIENT_ID:-}" ] || [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  echo "::error title=Cloudflare Access SSH not configured::CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set" >&2
  exit 2
fi

DOMAIN="${CF_TUNNEL_DOMAIN:-vm3.ai}"
SUB="${HOST%."${DOMAIN}"}"
TUNNEL_HOST="${SUB//./-}-ssh.${DOMAIN}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
LOG_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
mkdir -p "$LOG_DIR"

safe_host=$(printf '%s' "$HOST" | tr -c 'A-Za-z0-9_.-' '_')
LOG_FILE=$(mktemp "${LOG_DIR%/}/cloudflared-ssh-${safe_host}.XXXXXX.log")

github_escape() {
  local value="$1"
  value=${value//'%'/'%25'}
  value=${value//$'\r'/'%0D'}
  value=${value//$'\n'/'%0A'}
  printf '%s' "$value"
}

redact_cloudflared_log() {
  sed -E \
    -e 's/(--secret(=|[[:space:]]+))[^[:space:]]+/\1[redacted]/g' \
    -e 's/(--id(=|[[:space:]]+))[^[:space:]]+/\1[redacted]/g' \
    -e 's/(CF_ACCESS_CLIENT_SECRET=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(CF_ACCESS_CLIENT_ID=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(TUNNEL_SERVICE_TOKEN_SECRET=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(TUNNEL_SERVICE_TOKEN_ID=)[^[:space:]]+/\1[redacted]/g' \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]]+/\1[redacted]/Ig' \
    "$LOG_FILE"
}

emit_redacted_cloudflared_log() {
  local header="$1"
  if [ -s "$LOG_FILE" ]; then
    echo "$header" >&2
    redact_cloudflared_log | tail -n 20 >&2
  fi
}

failure_title() {
  if grep -Eiq "Unable to reach the origin service|connection (refused|reset|timed out)|i/o timeout|context canceled|no route to host|websocket: bad handshake|EOF" "$LOG_FILE"; then
    echo "Metal Cloudflare tunnel unavailable"
  elif grep -Eiq "access denied|unauthorized|forbidden|invalid.*token|service token|authentication" "$LOG_FILE"; then
    echo "Cloudflare Access credentials rejected"
  elif grep -Eiq "command not found|No such file or directory" "$LOG_FILE"; then
    echo "cloudflared is not installed"
  else
    echo "Metal Cloudflare SSH tunnel failed"
  fi
}

failure_message() {
  local status="$1"
  local title="$2"
  case "$title" in
    "Metal Cloudflare tunnel unavailable")
      echo "Cloudflare Access SSH to ${HOST} (${TUNNEL_HOST}) failed with cloudflared exit ${status}. The metal host tunnel is disconnected or unreachable; check the cloudflared service on the metal host."
      ;;
    "Cloudflare Access credentials rejected")
      echo "Cloudflare Access SSH to ${HOST} (${TUNNEL_HOST}) failed with cloudflared exit ${status}. Check CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET for this workflow."
      ;;
    "cloudflared is not installed")
      echo "Cloudflare Access SSH to ${HOST} (${TUNNEL_HOST}) failed because cloudflared could not be executed."
      ;;
    *)
      echo "Cloudflare Access SSH to ${HOST} (${TUNNEL_HOST}) failed with cloudflared exit ${status}. Check the cloudflared stderr below."
      ;;
  esac
}

emit_failure_report() {
  local status="$1"
  local title="$2"
  local message="$3"
  local escaped_title escaped_message
  escaped_title=$(github_escape "$title")
  escaped_message=$(github_escape "$message")

  echo "::error title=${escaped_title}::${escaped_message}" >&2

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### ${title}"
      echo ""
      echo "- Host: \`${HOST}\`"
      echo "- Tunnel: \`${TUNNEL_HOST}\`"
      echo "- Exit status: \`${status}\`"
      echo "- Diagnosis: ${message}"
      echo ""
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  emit_redacted_cloudflared_log \
    "----- cloudflared stderr (last 20 lines, redacted) -----"
}

emit_failure_marker() {
  local status="$1"
  local title message
  title=$(failure_title)
  message=$(failure_message "$status" "$title")
  emit_failure_report "$status" "$title" "$message"
}

emit_interrupted_marker() {
  local signal="$1"
  local status="$2"
  local title="Cloudflare SSH proxy interrupted"
  local message
  message="Cloudflare Access SSH to ${HOST} (${TUNNEL_HOST}) was interrupted by signal ${signal}. If SSH reported a banner timeout, cloudflared did not deliver the origin SSH banner before ConnectTimeout; inspect the redacted stderr below."
  emit_failure_report "$status" "$title" "$message"
}

cloudflared_pid=""

terminate_cloudflared() {
  if [ -n "$cloudflared_pid" ]; then
    kill -TERM "$cloudflared_pid" 2>/dev/null || true
    wait "$cloudflared_pid" 2>/dev/null || true
    cloudflared_pid=""
  fi
}

cleanup() {
  local status="$1"
  trap - EXIT
  terminate_cloudflared
  rm -f "$LOG_FILE"
  exit "$status"
}

handle_hup() {
  trap - HUP INT TERM
  terminate_cloudflared
  emit_redacted_cloudflared_log \
    "----- cloudflared stderr before ProxyCommand teardown (last 20 lines, redacted) -----"
  exit 129
}

handle_signal() {
  local signal="$1"
  local status="$2"
  trap - HUP INT TERM
  terminate_cloudflared
  emit_interrupted_marker "$signal" "$status"
  exit "$status"
}

trap 'cleanup $?' EXIT
trap handle_hup HUP
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

status=0
TUNNEL_SERVICE_TOKEN_ID="$CF_ACCESS_CLIENT_ID" \
  TUNNEL_SERVICE_TOKEN_SECRET="$CF_ACCESS_CLIENT_SECRET" \
  "$CLOUDFLARED_BIN" access ssh \
  --hostname "$TUNNEL_HOST" \
  <&0 2> "$LOG_FILE" &
cloudflared_pid=$!
wait "$cloudflared_pid" || status=$?
cloudflared_pid=""

if [ "$status" -ne 0 ]; then
  emit_failure_marker "$status"
fi

exit "$status"
