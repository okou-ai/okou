#!/usr/bin/env bash
set -euo pipefail

# The coordinator owns one Linux boot-time deadline for all three scenarios.
# Local results include finalization; a new per-turn latency limit is incorrect.
if [ "$#" -lt 1 ] \
  || [[ ! "${PROCESS_CONTAINMENT_DEADLINE_UPTIME_SECONDS:-}" =~ ^[1-9][0-9]{0,9}$ ]]; then
  echo 'invalid process-containment submission budget' >&2
  exit 2
fi
BIN_DIR=$1
shift
read -r uptime_seconds _ < /proc/uptime
remaining=$((PROCESS_CONTAINMENT_DEADLINE_UPTIME_SECONDS - ${uptime_seconds%%.*}))
if [ "$remaining" -le 0 ]; then
  echo 'process-containment scenario budget exhausted before local submit' >&2
  exit 1
fi

# Keep the background submit PID owned by lifecycle.sh attached to sudo/Runner.
exec sudo "$BIN_DIR/runner" local submit --timeout "$remaining" "$@"
