#!/usr/bin/env bash
set -euo pipefail

if [ -z "${NATIVE_DIAGNOSTIC_CASE:-}" ]; then
  for creation in preconnect probe recovery failed-recovery failed-preconnect; do
    NATIVE_DIAGNOSTIC_CASE="$creation" timeout --kill-after=2s 10s bash "$0"
  done
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OWNER="$REPO_ROOT/.github/scripts/runner"
tmp=$(mktemp -d)
cleanup() {
  local file
  for file in "$tmp/cloudflared.pid" "$tmp/proxy.pid" "$tmp/master.pid"; do
    if [ -s "$file" ]; then
      kill -TERM "$(< "$file")" 2>/dev/null || true
    fi
  done
  rm -rf -- "$tmp"
}
trap cleanup EXIT

mkdir -p "$tmp/installed" "$tmp/bin" "$tmp/state" "$tmp/logs"
# Exercise the installed ProxyCommand layout used by the real setup action.
install -m 755 "$OWNER/cloudflare-ssh-proxy.sh" "$tmp/installed/cf-proxy.sh"
install -m 644 "$OWNER/cloudflare-ssh-diagnostics.sh" "$tmp/installed/cloudflare-ssh-diagnostics.sh"
install -m 644 "$OWNER/cloudflare-ssh-log.py" "$tmp/installed/cloudflare-ssh-log.py"
install -m 644 "$OWNER/cloudflare-ssh-tcp.py" "$tmp/installed/cloudflare-ssh-tcp.py"
ln -s "$OWNER/cloudflare-ssh-command.sh" "$tmp/bin/scp"
mkfifo "$tmp/started" "$tmp/trigger" "$tmp/finished"
cat > "$tmp/access.env" <<'EOF'
CF_ACCESS_CLIENT_ID=fixture-client
CF_ACCESS_CLIENT_SECRET=fixture-secret
EOF
cat > "$tmp/cloudflared" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$$" > "$FIXTURE/cloudflared.pid"
application=""
while (($#)); do
  if [ "$1" = --log-directory ]; then
    application="$2"
    shift
  fi
  shift
done
test -n "$application"
printf '%s\n' '{"time":"2026-10-16T04:05:18Z","level":"debug","message":"Websocket request: GET / HTTP/1.1\r\nCf-Access-Client-Secret: fixture-secret\r\nCookie: fixture-cookie\r\n"}' \
  >> "$application/cloudflared.log"
printf 'ready\n' > "$FIXTURE/started"
IFS= read -r _ < "$FIXTURE/trigger"
printf '%s\n' '{"time":"2026-10-16T04:06:09Z","level":"debug","message":"downstream->upstream copy: websocket: close 1006 (abnormal closure): unexpected EOF"}' \
  >> "$application/cloudflared.log"
exit 0
EOF
cat > "$tmp/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
create=false
if [ ! -e "$FIXTURE/master-created" ]; then
  case "$NATIVE_DIAGNOSTIC_CASE" in
    preconnect)
      [[ " $* " != *" -M -N -f "* ]] || create=true
      ;;
    probe)
      [[ " $* " != *" true "* ]] || create=true
      ;;
    recovery|failed-recovery|failed-preconnect)
      if [[ " $* " == *" true "* ]] && [ ! -e "$FIXTURE/probe-failed" ]; then
        touch "$FIXTURE/probe-failed"
        echo 'connection closed before caller submission' >&2
        exit 255
      fi
      if [[ " $* " == *" -M -N -f "* ]] \
        && [[ "$OKOU_CLOUDFLARE_SSH_PROXY_DIAGNOSTICS_DIR" == *'/r.'*'/master.sock.stderr.proxies' ]]; then
        create=true
      fi
      ;;
  esac
fi
if [ "$NATIVE_DIAGNOSTIC_CASE" = failed-recovery ] \
  && [ -e "$FIXTURE/master-created" ] && [[ " $* " == *" true "* ]]; then
  printf 'fail\n' > "$FIXTURE/trigger"
  IFS= read -r _ < "$FIXTURE/finished"
  echo 'recovered command channel closed' >&2
  exit 255
fi
if [ "$create" = true ]; then
  touch "$FIXTURE/master-created"
  (
    "$FIXTURE/installed/cf-proxy.sh" dev-11.gcp.vm3.ai </dev/null &
    proxy=$!
    printf '%s\n' "$proxy" > "$FIXTURE/proxy.pid"
    status=0
    wait "$proxy" || status=$?
    printf '%s\n' "$status" > "$FIXTURE/proxy.status"
    printf 'done\n' > "$FIXTURE/finished"
  ) >/dev/null &
  printf '%s\n' "$!" > "$FIXTURE/master.pid"
  IFS= read -r _ < "$FIXTURE/started"
  echo 'debug1: fixture master connected' >&2
  if [ "$NATIVE_DIAGNOSTIC_CASE" = failed-preconnect ]; then
    printf 'fail\n' > "$FIXTURE/trigger"
    IFS= read -r _ < "$FIXTURE/finished"
    echo 'Permission denied (publickey).' >&2
    exit 255
  fi
fi
exit 0
EOF
cat > "$tmp/scp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ ! -e "$FIXTURE/first-call" ]; then
  touch "$FIXTURE/first-call"
  printf 'ordinary caller stdout\n'
  exit 0
fi
printf 'fail\n' > "$FIXTURE/trigger"
IFS= read -r _ < "$FIXTURE/finished"
echo 'lost connection' >&2
exit 17
EOF
chmod +x "$tmp/cloudflared" "$tmp/ssh" "$tmp/scp"
export FIXTURE="$tmp" CF_ACCESS_ENV_FILE="$tmp/access.env" CLOUDFLARED_BIN="$tmp/cloudflared"
export RUNNER_TEMP="$tmp/logs" OKOU_CLOUDFLARE_SSH_REAL_SSH="$tmp/ssh"
export CLOUDFLARE_SSH_BIN="$tmp/ssh"
export OKOU_CLOUDFLARE_SSH_REAL_SCP="$tmp/scp" OKOU_CLOUDFLARE_SSH_USER=ubuntu
export OKOU_CLOUDFLARE_SSH_STATE_DIR="$tmp/state" OKOU_CLOUDFLARE_SSH_SCRIPTS_DIR="$OWNER"

"$OWNER/cloudflare-ssh-preconnect.sh" ubuntu dev-11.gcp.vm3.ai > "$tmp/setup.out" 2> "$tmp/setup.err"
first_status=0
"$tmp/bin/scp" /tmp/source ubuntu@dev-11.gcp.vm3.ai:/tmp/target > "$tmp/first.out" 2> "$tmp/first.err" || first_status=$?
if [[ "$NATIVE_DIAGNOSTIC_CASE" = failed-recovery || "$NATIVE_DIAGNOSTIC_CASE" = failed-preconnect ]]; then
  test "$first_status" -eq 255
  grep -Fq 'event=recovery-start' "$tmp/first.err"
  grep -Fq 'event=recovery-result' "$tmp/first.err"
  test ! -e "$tmp/first-call"
  test "$(< "$tmp/proxy.status")" -eq 0
  if ! grep -Fq 'close 1006' "$tmp/first.err"; then
    echo 'failed recovery omitted retained native proxy evidence' >&2
    exit 1
  fi
  test -n "$(find "$tmp/state" -type d -name 'proxy.*' -print -quit)"
  echo "cloudflare-ssh-native-diagnostics-test (${NATIVE_DIAGNOSTIC_CASE}): ok"
  exit 0
fi
test "$first_status" -eq 0
test "$(< "$tmp/first.out")" = 'ordinary caller stdout'
if [ "$NATIVE_DIAGNOSTIC_CASE" = recovery ]; then
  grep -Fq 'command-channel probe failed' "$tmp/first.err"
else
  test ! -s "$tmp/first.err"
fi
proxy_dir=$(find "$tmp" -type d -name 'proxy.*' -print -quit)
master_log="${proxy_dir%/proxy.*}"
master_log="${master_log%.proxies}"
python3 "$OWNER/cloudflare-ssh-log.py" master "$master_log" > "$tmp/running-snapshot"
grep -Fq 'no final proxy status observed' "$tmp/running-snapshot"
status=0
"$tmp/bin/scp" /tmp/source ubuntu@dev-11.gcp.vm3.ai:/tmp/target > "$tmp/failed.out" 2> "$tmp/failed.err" || status=$?
test "$status" -eq 17
test "$(< "$tmp/proxy.status")" -eq 0
test ! -s "$tmp/failed.out"
for expected in 'close 1006' '2026-10-16T04:06:09Z' 'event=child-exit' 'status=0' 'event=proxy-exit' 'proxy_pid=' 'uptime_seconds='; do
  grep -Fq "$expected" "$tmp/failed.err"
done
for forbidden in fixture-secret fixture-cookie; do
  if grep -Fq "$forbidden" "$tmp/failed.err"; then
    echo 'credential escaped the diagnostic publication boundary' >&2
    exit 1
  fi
done
test "$(stat -c %a "$proxy_dir")" = 700
test "$(stat -c %a "$proxy_dir/application/cloudflared.log")" = 600

# Malformed structured data and symlinked namespaces must also fail closed.
printf '%s\n' '{"message":"fixture-malformed-secret' >> "$proxy_dir/application/cloudflared.log"
printf '%s\n' '{"message":"transport error\nCf-Access-Client-Secret: fixture-nested-secret\nAuthorization: Bearer fixture-bearer\nCookie: fixture-nested-cookie","headers":{"private":"fixture-hidden-field"}}' \
  >> "$proxy_dir/application/cloudflared.log"
printf 'fixture-linked-secret\n' > "$tmp/private"
ln -s "$tmp/private" "$proxy_dir/application/cloudflared-linked.log"
python3 "$OWNER/cloudflare-ssh-log.py" master "$master_log" > "$tmp/sanitized"
grep -Fq 'close 1006' "$tmp/sanitized"
grep -Fq 'omitted malformed structured diagnostic' "$tmp/sanitized"
if grep -Eq 'fixture-(malformed|linked|nested)-secret|fixture-bearer|fixture-nested-cookie|fixture-hidden-field' "$tmp/sanitized"; then
  echo 'unsafe diagnostic data was published' >&2
  exit 1
fi
ln -s "${proxy_dir%/proxy.*}" "$tmp/unrelated.proxies"
printf 'unrelated master\n' > "$tmp/unrelated"
python3 "$OWNER/cloudflare-ssh-log.py" master "$tmp/unrelated" > "$tmp/unrelated.out"
if grep -Fq 'close 1006' "$tmp/unrelated.out"; then
  echo 'read proxy evidence through an unrelated master symlink' >&2
  exit 1
fi

echo "cloudflare-ssh-native-diagnostics-test (${NATIVE_DIAGNOSTIC_CASE}): ok"
