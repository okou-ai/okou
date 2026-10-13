#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
SANDBOX_ID=$2
fail() { echo "FAIL: $1"; exit 1; }

echo "--- Test: PostgreSQL/pgvector ---"
# Verify PostgreSQL can actually start (not just psql --version).
# Test with TCP on localhost — users will connect via localhost:5432.
sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- sh -c '
  set -e
  pg_bin=$(
    for initdb in /usr/lib/postgresql/*/bin/initdb; do
      [ -x "$initdb" ] && printf "%s\n" "${initdb%/initdb}"
    done | sort -V | tail -n 1
  )
  if [ -z "$pg_bin" ]; then
    echo "initdb not found under /usr/lib/postgresql/*/bin" >&2
    ls -la /usr/lib/postgresql /usr/lib/postgresql/* /usr/lib/postgresql/*/bin 2>&1 || true
    exit 1
  fi
  rm -rf /tmp/pgdata
  mkdir -p /tmp/pgdata
  "$pg_bin/initdb" -D /tmp/pgdata -A trust
  pg_started=0
  stop_pg() {
    if [ "$pg_started" = "1" ]; then
      "$pg_bin/pg_ctl" -D /tmp/pgdata -m fast stop >/dev/null 2>&1 || true
    fi
  }
  trap stop_pg EXIT
  pg_started=1
  "$pg_bin/pg_ctl" -D /tmp/pgdata -l /tmp/pgdata/log -o "-c listen_addresses=localhost" -w -t 30 start
  pg_isready -h localhost
  [ "$(psql -h localhost -d postgres -Atc "select 1")" = "1" ]
  psql -h localhost -d postgres -v ON_ERROR_STOP=1 -c "CREATE EXTENSION vector"
  "$pg_bin/pg_ctl" -D /tmp/pgdata stop
  pg_started=0
' \
  || { sudo "$BIN_DIR/runner" exec --sandbox "$SANDBOX_ID" -- cat /tmp/pgdata/log 2>&1 || true; fail "PostgreSQL/pgvector smoke test"; }
echo "  PostgreSQL/pgvector smoke test: ok"
echo "PASS: PostgreSQL/pgvector"
