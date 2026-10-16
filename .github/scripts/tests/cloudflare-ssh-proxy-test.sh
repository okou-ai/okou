#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROXY="$REPO_ROOT/.github/scripts/runner/cloudflare-ssh-proxy.sh"

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! grep -Fq -- "$expected" "$file"; then
    echo "expected ${file} to contain: ${expected}" >&2
    echo "--- ${file} ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    echo "expected ${file} not to contain: ${unexpected}" >&2
    echo "--- ${file} ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

make_home() {
  local dir="$1"
  mkdir -p "$dir/.ssh"
  cat > "$dir/.ssh/cf-access.env" <<'EOF'
export CF_ACCESS_CLIENT_ID="client-id"
export CF_ACCESS_CLIENT_SECRET="super-secret"
EOF
}

tmp=$(mktemp -d)
proxy_pid=""
clock_pid=""

cleanup() {
  if [ -n "$clock_pid" ]; then
    kill -TERM "$clock_pid" 2>/dev/null || true
  fi
  if [ -n "$proxy_pid" ]; then
    kill -TERM "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}

trap cleanup EXIT

home_success="$tmp/home-success"
make_home "$home_success"
args_file="$tmp/cloudflared.args"
env_file="$tmp/cloudflared.env"
success_cloudflared="$tmp/cloudflared-success"
cat > "$success_cloudflared" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$FAKE_ARGS_FILE"
printf 'TUNNEL_SERVICE_TOKEN_ID=%s\nTUNNEL_SERVICE_TOKEN_SECRET=%s\n' \
  "$TUNNEL_SERVICE_TOKEN_ID" "$TUNNEL_SERVICE_TOKEN_SECRET" \
  > "$FAKE_ENV_FILE"
IFS= read -r input
printf 'proxied: %s\n' "$input"
exit 0
EOF
chmod +x "$success_cloudflared"

HOME="$home_success" \
CLOUDFLARED_BIN="$success_cloudflared" \
FAKE_ARGS_FILE="$args_file" \
FAKE_ENV_FILE="$env_file" \
"$PROXY" dev-1.aws.vm3.ai <<< "SSH-2.0-test-client" > "$tmp/success.out" 2> "$tmp/success.err"

assert_contains "$args_file" "--hostname dev-1-aws-ssh.vm3.ai"
assert_not_contains "$args_file" "--id"
assert_not_contains "$args_file" "--secret"
assert_not_contains "$args_file" "client-id"
assert_not_contains "$args_file" "super-secret"
assert_contains "$env_file" "TUNNEL_SERVICE_TOKEN_ID=client-id"
assert_contains "$env_file" "TUNNEL_SERVICE_TOKEN_SECRET=super-secret"
assert_contains "$tmp/success.out" "proxied: SSH-2.0-test-client"
assert_not_contains "$tmp/success.err" "::error"

# Pause the first external clock read after directory creation, then deliver a
# real signal before any Cloudflare child starts. Filesystem operations stay real.
early_logs="$tmp/early-logs"
clock_bin="$tmp/clock-bin"
mkdir -p "$early_logs" "$clock_bin"
mkfifo "$tmp/clock-ready" "$tmp/clock-release"
real_date=$(command -v date)
cat > "$clock_bin/date" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ ! -e "$PROXY_TEST_CLOCK_ONCE" ]; then
  touch "$PROXY_TEST_CLOCK_ONCE"
  printf '%s\n' "$$" > "$PROXY_TEST_CLOCK_PID"
  printf 'ready\n' > "$PROXY_TEST_CLOCK_READY"
  IFS= read -r _ < "$PROXY_TEST_CLOCK_RELEASE"
fi
exec "$PROXY_TEST_REAL_DATE" "$@"
EOF
chmod +x "$clock_bin/date"
PATH="$clock_bin:$PATH" \
CF_ACCESS_ENV_FILE="$home_success/.ssh/cf-access.env" \
CLOUDFLARED_BIN="$success_cloudflared" \
FAKE_ARGS_FILE="$tmp/early-child.args" \
FAKE_ENV_FILE="$tmp/early-child.env" \
RUNNER_TEMP="$early_logs" \
PROXY_TEST_CLOCK_ONCE="$tmp/clock-once" \
PROXY_TEST_CLOCK_PID="$tmp/clock.pid" \
PROXY_TEST_CLOCK_READY="$tmp/clock-ready" \
PROXY_TEST_CLOCK_RELEASE="$tmp/clock-release" \
PROXY_TEST_REAL_DATE="$real_date" \
"$PROXY" dev-1.aws.vm3.ai > "$tmp/early.out" 2> "$tmp/early.err" &
proxy_pid=$!
timeout 5s cat "$tmp/clock-ready" > /dev/null
clock_pid=$(< "$tmp/clock.pid")
kill -HUP "$proxy_pid"
printf 'continue\n' > "$tmp/clock-release"
early_status=0
wait "$proxy_pid" || early_status=$?
proxy_pid=""
clock_pid=""
test "$early_status" -eq 129
test ! -e "$tmp/early-child.args"
if compgen -G "$early_logs/cloudflared-ssh-*.log" > /dev/null; then
  echo 'pre-child cancellation left standalone diagnostic resources behind' >&2
  exit 1
fi

home_failure="$tmp/home-failure"
make_home "$home_failure"
summary="$tmp/summary.md"
failure_cloudflared="$tmp/cloudflared-failure"
cat > "$failure_cloudflared" <<'EOF'
#!/usr/bin/env bash
printf 'failed args: %s\n' "$*" >&2
printf 'TUNNEL_SERVICE_TOKEN_ID=%s TUNNEL_SERVICE_TOKEN_SECRET=%s\n' \
  "$TUNNEL_SERVICE_TOKEN_ID" "$TUNNEL_SERVICE_TOKEN_SECRET" >&2
echo "Unable to reach the origin service: context canceled" >&2
exit 255
EOF
chmod +x "$failure_cloudflared"

status=0
HOME="$home_failure" \
CLOUDFLARED_BIN="$failure_cloudflared" \
GITHUB_STEP_SUMMARY="$summary" \
"$PROXY" dev-1.aws.vm3.ai > "$tmp/failure.out" 2> "$tmp/failure.err" || status=$?

if [ "$status" -ne 255 ]; then
  echo "expected failure status 255, got ${status}" >&2
  exit 1
fi

assert_contains "$tmp/failure.err" "::error title=Metal Cloudflare tunnel unavailable::"
assert_contains "$tmp/failure.err" "dev-1.aws.vm3.ai"
assert_contains "$tmp/failure.err" "dev-1-aws-ssh.vm3.ai"
assert_contains "$tmp/failure.err" "----- cloudflared stderr (last 20 lines, redacted) -----"
assert_contains "$summary" "### Metal Cloudflare tunnel unavailable"
assert_contains "$summary" "Exit status: \`255\`"
assert_not_contains "$tmp/failure.err" "super-secret"
assert_not_contains "$tmp/failure.err" "client-id"
assert_not_contains "$summary" "super-secret"
assert_not_contains "$summary" "client-id"

home_hup="$tmp/home-hup"
make_home "$home_hup"
hup_summary="$tmp/hup-summary.md"
hup_logs="$tmp/hup-logs"
hup_pid_file="$tmp/hup.pid"
hup_signal_file="$tmp/hup.signal"
mkdir -p "$hup_logs"
hup_cloudflared="$tmp/cloudflared-hup"
cat > "$hup_cloudflared" <<'EOF'
#!/usr/bin/env bash
trap 'printf "terminated\n" > "$FAKE_SIGNAL_FILE"; exit 143' TERM
printf '%s\n' "$$" > "$FAKE_PID_FILE"
printf 'websocket handshake still pending: %s\n' "$*" >&2
printf 'TUNNEL_SERVICE_TOKEN_ID=%s TUNNEL_SERVICE_TOKEN_SECRET=%s\n' \
  "$TUNNEL_SERVICE_TOKEN_ID" "$TUNNEL_SERVICE_TOKEN_SECRET" >&2
while :; do
  :
done
EOF
chmod +x "$hup_cloudflared"

HOME="$home_hup" \
CLOUDFLARED_BIN="$hup_cloudflared" \
FAKE_PID_FILE="$hup_pid_file" \
FAKE_SIGNAL_FILE="$hup_signal_file" \
GITHUB_STEP_SUMMARY="$hup_summary" \
RUNNER_TEMP="$hup_logs" \
"$PROXY" dev-1.aws.vm3.ai < /dev/null > "$tmp/hup.out" 2> "$tmp/hup.err" &
proxy_pid=$!

deadline=$((SECONDS + 5))
while [ ! -s "$hup_pid_file" ]; do
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    echo "proxy exited before starting cloudflared" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "timed out waiting for cloudflared to start" >&2
    exit 1
  fi
done

hup_pid=$(cat "$hup_pid_file")
kill -HUP "$proxy_pid"
status=0
wait "$proxy_pid" || status=$?
proxy_pid=""

if [ "$status" -ne 129 ]; then
  echo "expected HUP status 129, got ${status}" >&2
  exit 1
fi

assert_contains "$hup_signal_file" "terminated"
assert_contains "$tmp/hup.err" "cloudflared stderr before ProxyCommand teardown"
assert_contains "$tmp/hup.err" "websocket handshake still pending"
assert_not_contains "$tmp/hup.err" "::error"
assert_not_contains "$tmp/hup.err" "Cloudflare SSH proxy interrupted"
assert_not_contains "$tmp/hup.err" "super-secret"
assert_not_contains "$tmp/hup.err" "client-id"
if [ -s "$hup_summary" ]; then
  echo "expected HUP not to write a failure summary" >&2
  cat "$hup_summary" >&2
  exit 1
fi
if kill -0 "$hup_pid" 2>/dev/null; then
  echo "expected HUP cloudflared process ${hup_pid} to be reaped" >&2
  exit 1
fi
if compgen -G "$hup_logs/cloudflared-ssh-*.log" > /dev/null; then
  echo "expected HUP cloudflared logs to be removed" >&2
  exit 1
fi

home_term="$tmp/home-term"
make_home "$home_term"
term_summary="$tmp/term-summary.md"
term_logs="$tmp/term-logs"
term_pid_file="$tmp/term.pid"
term_signal_file="$tmp/term.signal"
mkdir -p "$term_logs"

HOME="$home_term" \
CLOUDFLARED_BIN="$hup_cloudflared" \
FAKE_PID_FILE="$term_pid_file" \
FAKE_SIGNAL_FILE="$term_signal_file" \
GITHUB_STEP_SUMMARY="$term_summary" \
RUNNER_TEMP="$term_logs" \
"$PROXY" dev-1.aws.vm3.ai < /dev/null > "$tmp/term.out" 2> "$tmp/term.err" &
proxy_pid=$!

deadline=$((SECONDS + 5))
while [ ! -s "$term_pid_file" ]; do
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    echo "proxy exited before starting cloudflared for TERM test" >&2
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "timed out waiting for cloudflared to start for TERM test" >&2
    exit 1
  fi
done

term_pid=$(cat "$term_pid_file")
kill -TERM "$proxy_pid"
status=0
wait "$proxy_pid" || status=$?
proxy_pid=""

if [ "$status" -ne 143 ]; then
  echo "expected TERM status 143, got ${status}" >&2
  exit 1
fi

assert_contains "$term_signal_file" "terminated"
assert_contains "$tmp/term.err" "::error title=Cloudflare SSH proxy interrupted::"
assert_contains "$tmp/term.err" "interrupted by signal TERM"
assert_contains "$term_summary" "### Cloudflare SSH proxy interrupted"
assert_contains "$term_summary" "Exit status: \`143\`"
assert_not_contains "$tmp/term.err" "super-secret"
assert_not_contains "$tmp/term.err" "client-id"
assert_not_contains "$term_summary" "super-secret"
assert_not_contains "$term_summary" "client-id"
if kill -0 "$term_pid" 2>/dev/null; then
  echo "expected TERM cloudflared process ${term_pid} to be reaped" >&2
  exit 1
fi
if compgen -G "$term_logs/cloudflared-ssh-*.log" > /dev/null; then
  echo "expected TERM cloudflared logs to be removed" >&2
  exit 1
fi

echo "cloudflare-ssh-proxy-test: ok"
