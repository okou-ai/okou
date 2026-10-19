#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/scripts/runner/cloudflare-ssh-diagnostics.sh
. "$SCRIPT_DIR/cloudflare-ssh-diagnostics.sh"

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
umask 077

safe_host=$(printf '%s' "$HOST" | tr -c 'A-Za-z0-9_.-' '_')
proxy_root="${OKOU_CLOUDFLARE_SSH_PROXY_DIAGNOSTICS_DIR:-}"
RETAIN_DIAGNOSTICS=false
PROXY_DIR=""
LOG_FILE=""
EVENTS_FILE=""
native_log_args=()

proxy_event() {
  local event=$1 status=${2:-unknown} signal=${3:-none}
  local uptime=unavailable utc
  if [ -z "$EVENTS_FILE" ]; then
    return
  fi
  if [ -r /proc/uptime ]; then
    read -r uptime _ < /proc/uptime || uptime=unavailable
  fi
  utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) || utc=unavailable
  printf 'event=%s utc=%s epoch=%s uptime_seconds=%s transport=%s proxy_pid=%s parent_pid=%s child_pid=%s sampler_pid=%s status=%s signal=%s host=%s\n' \
    "$event" "$utc" "${EPOCHREALTIME:-unavailable}" "$uptime" "${PROXY_DIR##*/}" \
    "$$" "$PPID" "${cloudflared_pid:-none}" "${tcp_sampler_pid:-none}" "$status" "$signal" "$safe_host" \
    >> "$EVENTS_FILE" || true
}

github_escape() {
  local value="$1"
  value=${value//'%'/'%25'}
  value=${value//$'\r'/'%0D'}
  value=${value//$'\n'/'%0A'}
  printf '%s' "$value"
}

emit_redacted_cloudflared_log() {
  local header="$1"
  if [ -z "$PROXY_DIR" ]; then
    echo "Cloudflare proxy diagnostics unavailable before initialization." >&2
    return
  fi
  echo "$header" >&2
  cloudflare_ssh_render_diagnostics proxy "$PROXY_DIR" >&2 || true
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
tcp_sampler_pid=""

stop_tcp_sampler() {
  if [ -n "$tcp_sampler_pid" ]; then
    kill -TERM "$tcp_sampler_pid" 2>/dev/null || true
    wait "$tcp_sampler_pid" 2>/dev/null || true
    tcp_sampler_pid=""
  fi
}

terminate_cloudflared() {
  if [ -n "$cloudflared_pid" ]; then
    local signal_status=0 child_status=0
    kill -TERM "$cloudflared_pid" 2>/dev/null || signal_status=$?
    proxy_event signal-forwarded "$signal_status" TERM
    wait "$cloudflared_pid" 2>/dev/null || child_status=$?
    proxy_event child-exit "$child_status"
    cloudflared_pid=""
  fi
}

cleanup() {
  local status="$1"
  trap - EXIT
  terminate_cloudflared
  stop_tcp_sampler
  proxy_event proxy-exit "$status"
  if [ "$RETAIN_DIAGNOSTICS" = "false" ] && [ -n "$PROXY_DIR" ]; then
    rm -rf -- "$PROXY_DIR"
  fi
  exit "$status"
}

handle_hup() {
  trap - HUP INT TERM
  proxy_event signal-received 129 HUP
  terminate_cloudflared
  emit_redacted_cloudflared_log \
    "----- cloudflared stderr before ProxyCommand teardown (last 20 lines, redacted) -----" || true
  exit 129
}

handle_signal() {
  local signal="$1"
  local status="$2"
  trap - HUP INT TERM
  proxy_event signal-received "$status" "$signal"
  terminate_cloudflared
  emit_interrupted_marker "$signal" "$status" || true
  exit "$status"
}

trap 'cleanup $?' EXIT
trap handle_hup HUP
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM

# Register cleanup before creating owned directories or fallible log files.
if [[ "$proxy_root" == /* ]]; then
  if [ ! -L "$proxy_root" ] \
    && mkdir -p -- "$proxy_root" \
    && chmod 700 "$proxy_root"; then
    PROXY_DIR=$(mktemp -d "${proxy_root}/proxy.XXXXXX") || true
    if [ -n "$PROXY_DIR" ]; then
      RETAIN_DIAGNOSTICS=true
    fi
  fi
fi
if [ -z "$PROXY_DIR" ]; then
  PROXY_DIR=$(mktemp -d "${LOG_DIR%/}/cloudflared-ssh-${safe_host}.XXXXXX.log")
fi
LOG_FILE="${PROXY_DIR}/stderr.log"
EVENTS_FILE="${PROXY_DIR}/events.log"
: > "$LOG_FILE"
: > "$EVENTS_FILE"
if mkdir -m 700 "${PROXY_DIR}/application" \
  && touch "${PROXY_DIR}/application/cloudflared.log"; then
  native_log_args=(--log-level debug --log-directory "${PROXY_DIR}/application")
fi
proxy_event proxy-start

status=0
TUNNEL_SERVICE_TOKEN_ID="$CF_ACCESS_CLIENT_ID" \
  TUNNEL_SERVICE_TOKEN_SECRET="$CF_ACCESS_CLIENT_SECRET" \
  "$CLOUDFLARED_BIN" access ssh \
  --hostname "$TUNNEL_HOST" \
  "${native_log_args[@]}" \
  <&0 2> "$LOG_FILE" &
cloudflared_pid=$!
proxy_event child-start
# This observer neither holds the SSH stream open nor makes a new connection.
# Its last passive sample remains available even after cloudflared exits 0.
python3 "$SCRIPT_DIR/cloudflare-ssh-tcp.py" "$cloudflared_pid" "$PROXY_DIR/tcp.log" \
  </dev/null >/dev/null 2>/dev/null &
tcp_sampler_pid=$!
proxy_event tcp-sampler-start
wait "$cloudflared_pid" || status=$?
proxy_event child-exit "$status"
cloudflared_pid=""
stop_tcp_sampler

if [ "$status" -ne 0 ]; then
  emit_failure_marker "$status" || true
fi

exit "$status"
