#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
WRAPPER="${REPO_ROOT}/.github/scripts/runner/cloudflare-ssh-command.sh"
PRECONNECT="${REPO_ROOT}/.github/scripts/runner/cloudflare-ssh-preconnect.sh"

fail() {
  echo "$1" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local expected=$2
  if ! grep -Fq -- "$expected" "$file"; then
    echo "expected ${file} to contain: ${expected}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local file=$1
  local unexpected=$2
  if grep -Fq -- "$unexpected" "$file"; then
    echo "expected ${file} not to contain: ${unexpected}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_line_count() {
  local file=$1
  local expected=$2
  local pattern=$3
  local actual
  actual=$(grep -Fxc -- "$pattern" "$file" || true)
  if [ "$actual" -ne "$expected" ]; then
    echo "expected ${file} to contain ${expected} exact line(s): ${pattern}; got ${actual}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_match_count() {
  local file=$1
  local expected=$2
  local pattern=$3
  local actual
  actual=$(grep -Fc -- "$pattern" "$file" || true)
  if [ "$actual" -ne "$expected" ]; then
    echo "expected ${file} to contain ${expected} matching line(s): ${pattern}; got ${actual}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_process_gone() {
  local pid_file=$1
  local description=$2
  local pid

  [ -s "$pid_file" ] || fail "missing PID for ${description}"
  pid=$(< "$pid_file")
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return
    fi
    sleep 0.1
  done
  fail "${description} process ${pid} is still alive"
}

tmp=$(mktemp -d)
cleanup() {
  local case_dir
  for case_dir in "$tmp/auto-master-failure" "$tmp/auto-master-reuse"; do
    if [ -s "$case_dir/auto-master.pid" ] \
      && [ ! -e "$case_dir/auto-master.completed" ]; then
      kill -TERM "$(< "$case_dir/auto-master.pid")" 2>/dev/null || true
    fi
  done
  rm -rf "$tmp"
}
trap cleanup EXIT

system_sleep=$(command -v sleep)
system_timeout=$(command -v timeout)

fake_bin="${tmp}/fake-bin"
wrapper_bin="${tmp}/wrapper-bin"
mkdir -p "$fake_bin" "$wrapper_bin"

fake_ssh="${fake_bin}/real-ssh"
cat > "$fake_ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$FAKE_SSH_INVOCATIONS"

arguments=("$@")
argument_count=${#arguments[@]}
control_path=""
has_detached_stdin=false
for ((index = 0; index < argument_count; index++)); do
  argument="${arguments[$index]}"
  case "$argument" in
    -n)
      has_detached_stdin=true
      ;;
    -S)
      index=$((index + 1))
      control_path="${arguments[$index]}"
      ;;
    -o)
      index=$((index + 1))
      option="${arguments[$index]}"
      if [[ "$option" == ControlPath=* ]]; then
        control_path="${option#ControlPath=}"
      fi
      ;;
    -oControlPath=*)
      control_path="${argument#-oControlPath=}"
      ;;
  esac
done

if [[ " $* " == *" -O check "* ]]; then
  echo "Master running"
  exit 0
fi
if [[ " $* " == *" -O exit "* ]]; then
  exit 0
fi
if [[ " $* " == *" -M "* ]] \
  && [[ " $* " == *" -N "* ]] \
  && [[ " $* " == *" -f "* ]]; then
  echo "debug1: master ready" >&2
  exit 0
fi

is_probe=false
if [ "$argument_count" -ge 2 ] \
  && [ "${arguments[$((argument_count - 1))]}" = "true" ] \
  && [[ "${arguments[$((argument_count - 2))]}" == *@*.vm3.ai ]]; then
  is_probe=true
fi

if [ "$is_probe" = "true" ]; then
  if [ "$has_detached_stdin" = "false" ]; then
    cat > "$FAKE_PROBE_STDIN_FILE"
  fi

  case "$FAKE_SSH_SCENARIO" in
    healthy|actual-failure|actual-hang)
      exit 0
      ;;
    auto-master-failure|auto-master-reuse)
      # Simulate the detached master retaining the probe's stderr descriptor.
      # Emit its failure only after caller execution has started.
      if [ -s "$FAKE_MASTER_PID_FILE" ]; then
        exit 0
      fi
      (
        printf '%s\n' "$BASHPID" > "$FAKE_MASTER_PID_FILE"
        if [ "$FAKE_SSH_SCENARIO" = "auto-master-reuse" ]; then
          printf 'ready\n' > "$FAKE_MASTER_DONE"
        fi
        IFS= read -r _ < "$FAKE_MASTER_TRIGGER"
        echo "debug1: probe-created master disconnected TUNNEL_SERVICE_TOKEN_SECRET=probe-secret" >&2
        printf 'done\n' > "$FAKE_MASTER_DONE"
        : > "$FAKE_MASTER_COMPLETED"
      ) > /dev/null &
      exit 0
      ;;
    stale-success)
      if [ -z "$control_path" ]; then
        echo "websocket: bad handshake --secret super-secret" >&2
        echo "TUNNEL_SERVICE_TOKEN_ID=client-id" >&2
        exit 124
      fi
      exit 0
      ;;
    selected-stale-success)
      if [ "$control_path" = "$FAKE_STALE_CONTROL_PATH" ]; then
        echo "Connection closed --secret super-secret" >&2
        exit 255
      fi
      exit 0
      ;;
    stale-exhaustion)
      echo "connection closed --secret super-secret --id client-id" >&2
      exit 255
      ;;
    permanent)
      echo "Permission denied (publickey). --secret super-secret" >&2
      exit 255
      ;;
    *)
      echo "unexpected fake SSH scenario: ${FAKE_SSH_SCENARIO}" >&2
      exit 2
      ;;
  esac
fi

printf '%s\n' "$*" >> "$FAKE_ACTUAL_SSH_INVOCATIONS"
if [[ " $* " == *" capture-stdin "* ]]; then
  cat > "$FAKE_ACTUAL_SSH_STDIN"
fi
if [ "$FAKE_SSH_SCENARIO" = "actual-failure" ]; then
  echo "actual stdout"
  echo "actual stderr" >&2
  exit 42
fi
if [ "$FAKE_SSH_SCENARIO" = "actual-hang" ]; then
  printf '%s\n' "$$" > "$FAKE_ACTUAL_SSH_PID"
  trap '' HUP INT TERM
  bash -c '
    trap "" HUP INT TERM
    printf "%s\n" "$$" > "$1"
    exec "$2" 300
  ' _ "$FAKE_ACTUAL_SSH_CHILD_PID" "$SYSTEM_SLEEP" &
  wait
fi
EOF

fake_scp="${fake_bin}/real-scp"
cat > "$fake_scp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SCP_INVOCATIONS"
if [ "$FAKE_SSH_SCENARIO" = "actual-failure" ]; then
  printf 'debug1: connection closed TUNNEL_SERVICE_TOKEN_SECRET=master-secret\n' \
    >> "$FAKE_MASTER_DIAGNOSTICS_FILE"
  echo "lost connection" >&2
  exit 1
fi
if [ "$FAKE_SSH_SCENARIO" = "auto-master-reuse" ] \
  && [ "$(wc -l < "$FAKE_SCP_INVOCATIONS")" -eq 1 ]; then
  IFS= read -r _ < "$FAKE_MASTER_DONE"
  exit 0
fi
if [ "$FAKE_SSH_SCENARIO" = "auto-master-failure" ] \
  || [ "$FAKE_SSH_SCENARIO" = "auto-master-reuse" ]; then
  printf 'caller-started\n' > "$FAKE_MASTER_TRIGGER"
  IFS= read -r _ < "$FAKE_MASTER_DONE"
  echo "lost connection" >&2
  exit 1
fi
EOF

fake_sftp="${fake_bin}/real-sftp"
cat > "$fake_sftp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SFTP_INVOCATIONS"
if [[ " $* " == *" -b - "* ]]; then
  cat > "$FAKE_ACTUAL_SFTP_STDIN"
fi
if [ "$FAKE_SSH_SCENARIO" = "actual-failure" ]; then
  exit 17
fi
EOF

fake_timeout="${fake_bin}/timeout"
cat > "$fake_timeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_TIMEOUT_INVOCATIONS"
if [ "${FAKE_TIMEOUT_MODE:-passthrough}" = "real" ]; then
  exec "$SYSTEM_TIMEOUT" "$@"
fi
if [ "${1:-}" = --verbose ]; then
  shift
fi
if [[ "${1:-}" == --kill-after=* ]]; then
  shift
fi
shift
exec "$@"
EOF

fake_sleep="${fake_bin}/sleep"
cat > "$fake_sleep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SLEEP_INVOCATIONS"
EOF

chmod +x \
  "$fake_ssh" \
  "$fake_scp" \
  "$fake_sftp" \
  "$fake_timeout" \
  "$fake_sleep"
ln -s "$WRAPPER" "${wrapper_bin}/ssh"
ln -s "$WRAPPER" "${wrapper_bin}/scp"
ln -s "$WRAPPER" "${wrapper_bin}/sftp"

setup_case() {
  local case_dir=$1
  mkdir -p "$case_dir/state" "$case_dir/runner-temp"
  : > "$case_dir/ssh.log"
  : > "$case_dir/actual-ssh.log"
  : > "$case_dir/scp.log"
  : > "$case_dir/sftp.log"
  : > "$case_dir/timeout.log"
  : > "$case_dir/sleep.log"
  : > "$case_dir/probe-stdin"
  : > "$case_dir/ssh-stdin"
  : > "$case_dir/sftp-stdin"
  : > "$case_dir/actual-ssh.pid"
  : > "$case_dir/actual-ssh-child.pid"
}

invoke_wrapper() {
  local case_dir=$1
  local scenario=$2
  local tool=$3
  shift 3
  local program="${wrapper_bin}/${tool}"
  if [ "$tool" = "preconnect" ]; then
    program="$PRECONNECT"
  fi

  PATH="$fake_bin:$PATH" \
  FAKE_SSH_INVOCATIONS="$case_dir/ssh.log" \
  FAKE_ACTUAL_SSH_INVOCATIONS="$case_dir/actual-ssh.log" \
  FAKE_SCP_INVOCATIONS="$case_dir/scp.log" \
  FAKE_SFTP_INVOCATIONS="$case_dir/sftp.log" \
  FAKE_TIMEOUT_INVOCATIONS="$case_dir/timeout.log" \
  FAKE_SLEEP_INVOCATIONS="$case_dir/sleep.log" \
  FAKE_PROBE_STDIN_FILE="$case_dir/probe-stdin" \
  FAKE_ACTUAL_SSH_STDIN="$case_dir/ssh-stdin" \
  FAKE_ACTUAL_SSH_PID="$case_dir/actual-ssh.pid" \
  FAKE_ACTUAL_SSH_CHILD_PID="$case_dir/actual-ssh-child.pid" \
  FAKE_ACTUAL_SFTP_STDIN="$case_dir/sftp-stdin" \
  FAKE_SSH_SCENARIO="$scenario" \
  FAKE_STALE_CONTROL_PATH="${FAKE_STALE_CONTROL_PATH:-}" \
  FAKE_TIMEOUT_MODE="${FAKE_TIMEOUT_MODE:-passthrough}" \
  FAKE_MASTER_DIAGNOSTICS_FILE="${FAKE_MASTER_DIAGNOSTICS_FILE:-}" \
  FAKE_MASTER_PID_FILE="$case_dir/auto-master.pid" \
  FAKE_MASTER_TRIGGER="$case_dir/auto-master.trigger" \
  FAKE_MASTER_DONE="$case_dir/auto-master.done" \
  FAKE_MASTER_COMPLETED="$case_dir/auto-master.completed" \
  GITHUB_STEP_SUMMARY="$case_dir/summary" \
  RUNNER_TEMP="$case_dir/runner-temp" \
  SYSTEM_SLEEP="$system_sleep" \
  SYSTEM_TIMEOUT="$system_timeout" \
  CLOUDFLARE_SSH_BIN="$fake_ssh" \
  OKOU_CLOUDFLARE_SSH_REAL_SSH="$fake_ssh" \
  OKOU_CLOUDFLARE_SSH_REAL_SCP="$fake_scp" \
  OKOU_CLOUDFLARE_SSH_REAL_SFTP="$fake_sftp" \
  OKOU_CLOUDFLARE_SSH_SCRIPTS_DIR="${REPO_ROOT}/.github/scripts/runner" \
  OKOU_CLOUDFLARE_SSH_STATE_DIR="$case_dir/state" \
  OKOU_CLOUDFLARE_SSH_USER=metal \
  OKOU_CLOUDFLARE_SSH_DEFAULT_CONTROL_PATH=/tmp/default-control \
  OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS="${OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS:-600}" \
    "$program" "$@"
}

run_wrapper() {
  local case_dir=$1
  local scenario=$2
  local tool=$3
  shift 3

  if [ ! -d "$case_dir" ]; then
    setup_case "$case_dir"
  fi
  local status=0
  invoke_wrapper "$case_dir" "$scenario" "$tool" "$@" \
    > "$case_dir/stdout" 2> "$case_dir/stderr" || status=$?
  printf '%s\n' "$status" > "$case_dir/status"
}

healthy="${tmp}/healthy"
run_wrapper "$healthy" healthy ssh \
  metal@dev-1.aws.vm3.ai touch /tmp/healthy-operation
assert_contains "$healthy/status" "0"
assert_line_count "$healthy/ssh.log" 1 \
  "-v -n -T metal@dev-1.aws.vm3.ai true"
assert_line_count "$healthy/actual-ssh.log" 1 \
  "metal@dev-1.aws.vm3.ai touch /tmp/healthy-operation"
assert_not_contains "$healthy/ssh.log" "-M -N -f"
if find "$healthy/state" -name '*.control-path' -print -quit | grep -q .; then
  fail "healthy transport must not create recovery state"
fi

default_user="${tmp}/default-user"
run_wrapper "$default_user" stale-success ssh \
  dev-1.aws.vm3.ai touch /tmp/default-user
default_user_control_path=$(< "$(find "$default_user/state" -name '*.control-path' -print -quit)")
assert_contains "$default_user/status" "0"
assert_line_count "$default_user/ssh.log" 1 \
  "-v -n -T metal@dev-1.aws.vm3.ai true"
assert_line_count "$default_user/actual-ssh.log" 1 \
  "-o User=metal -o ControlPath=${default_user_control_path} dev-1.aws.vm3.ai touch /tmp/default-user"

actual_failure="${tmp}/actual-failure"
setup_case "$actual_failure"
invoke_wrapper "$actual_failure" healthy preconnect metal dev-1.aws.vm3.ai \
  > "$actual_failure/preconnect.stdout" 2> "$actual_failure/preconnect.stderr"
run_wrapper "$actual_failure" actual-failure ssh \
  metal@dev-1.aws.vm3.ai run-once
assert_contains "$actual_failure/status" "42"
assert_line_count "$actual_failure/ssh.log" 1 \
  "-v -n -T metal@dev-1.aws.vm3.ai true"
assert_line_count "$actual_failure/actual-ssh.log" 1 \
  "metal@dev-1.aws.vm3.ai run-once"
assert_line_count "$actual_failure/stdout" 1 "actual stdout"
assert_line_count "$actual_failure/stderr" 1 "actual stderr"
assert_contains "$actual_failure/stderr" "SSH master stderr"
assert_contains "$actual_failure/stderr" "debug1: master ready"
assert_contains "$actual_failure/stderr" "Tool: ssh; host: dev-1.aws.vm3.ai; exit: 42; started:"
python3 - "$actual_failure/stderr" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
phases = [dict(part.split('=', 1) for part in line.split())
          for line in text.splitlines() if line.startswith('event=')]
assert [p['event'] for p in phases] == [
    'probe-start', 'probe-result', 'transport-selected', 'caller-start', 'caller-result']
assert phases[1]['status'] == '0' and phases[-1]['status'] == '42'
assert len({p['call'] for p in phases}) == 1
assert len({p['master'] for p in phases}) == 1
assert re.fullmatch('[0-9a-f]{24}', phases[0]['master'])
assert 'master=' + phases[0]['master'] in text
elapsed = [int(p['elapsed_centiseconds']) for p in phases]
assert elapsed == sorted(elapsed) and elapsed[0] == 0
assert all(p['utc'].endswith('Z') and p['uptime_seconds'] != 'unavailable' for p in phases)
PY

scp_failure="${tmp}/scp-failure"
setup_case "$scp_failure"
invoke_wrapper "$scp_failure" healthy preconnect metal dev-1.aws.vm3.ai \
  > "$scp_failure/preconnect.stdout" 2> "$scp_failure/preconnect.stderr"
scp_master_log=$(find "$scp_failure/runner-temp" -name 'cloudflare-ssh-master-*.stderr' -print -quit)
[ -n "$scp_master_log" ] || fail "setup must retain initial master diagnostics"
for index in {1..150}; do
  printf 'debug1: earlier channel event %s\n' "$index" >> "$scp_master_log"
done
printf '::error title=Cloudflare tunnel failed::--secret proxy-secret --id proxy-id\n' \
  >> "$scp_master_log"
FAKE_MASTER_DIAGNOSTICS_FILE="$scp_master_log" \
  run_wrapper "$scp_failure" actual-failure scp \
    /tmp/source metal@dev-1.aws.vm3.ai:/tmp/target
assert_contains "$scp_failure/status" "1"
assert_line_count "$scp_failure/scp.log" 1 \
  "/tmp/source metal@dev-1.aws.vm3.ai:/tmp/target"
assert_line_count "$scp_failure/stderr" 1 "lost connection"
assert_contains "$scp_failure/stderr" "Tool: scp; host: dev-1.aws.vm3.ai; exit: 1; started:"
assert_contains "$scp_failure/stderr" "earlier channel event 150"
assert_line_count "$scp_failure/stderr" 0 "debug1: earlier channel event 1"
assert_contains "$scp_failure/stderr" "TUNNEL_SERVICE_TOKEN_SECRET=[redacted]"
assert_contains "$scp_failure/stderr" "--secret [redacted] --id [redacted]"
assert_not_contains "$scp_failure/stderr" "master-secret"
assert_not_contains "$scp_failure/stderr" "proxy-secret"
assert_not_contains "$scp_failure/stderr" "proxy-id"
assert_not_contains "$scp_failure/stderr" "::error"
if [ -s "$scp_failure/stdout" ]; then
  fail "failed transfer diagnostics must stay out of caller stdout"
fi

auto_master="${tmp}/auto-master-failure"
setup_case "$auto_master"
mkfifo "$auto_master/auto-master.trigger" "$auto_master/auto-master.done"
run_wrapper "$auto_master" auto-master-failure scp \
  /tmp/source metal@dev-1.aws.vm3.ai:/tmp/target
assert_contains "$auto_master/status" "1"
assert_line_count "$auto_master/scp.log" 1 \
  "/tmp/source metal@dev-1.aws.vm3.ai:/tmp/target"
assert_contains "$auto_master/stderr" \
  "probe-created master disconnected TUNNEL_SERVICE_TOKEN_SECRET=[redacted]"
assert_not_contains "$auto_master/stderr" "probe-secret"
auto_master_stderr=$(find "$auto_master/runner-temp" -name 'cloudflare-ssh-master-*.stderr' -print -quit)
[ -n "$auto_master_stderr" ] || fail "probe-created master log must remain addressable"
if [ "$(stat -c '%a' "$auto_master_stderr")" != 600 ]; then
  fail "probe-created master log must have restricted permissions"
fi

auto_master_reuse="${tmp}/auto-master-reuse"
setup_case "$auto_master_reuse"
mkfifo "$auto_master_reuse/auto-master.trigger" "$auto_master_reuse/auto-master.done"
run_wrapper "$auto_master_reuse" auto-master-reuse scp \
  /tmp/source metal@dev-1.aws.vm3.ai:/tmp/first-target
assert_contains "$auto_master_reuse/status" "0"
if [ -s "$auto_master_reuse/stderr" ]; then
  fail "successful callers must not emit retained master diagnostics"
fi
run_wrapper "$auto_master_reuse" auto-master-reuse scp \
  /tmp/source metal@dev-1.aws.vm3.ai:/tmp/second-target
assert_contains "$auto_master_reuse/status" "1"
assert_line_count "$auto_master_reuse/scp.log" 1 \
  "/tmp/source metal@dev-1.aws.vm3.ai:/tmp/first-target"
assert_line_count "$auto_master_reuse/scp.log" 1 \
  "/tmp/source metal@dev-1.aws.vm3.ai:/tmp/second-target"
assert_contains "$auto_master_reuse/stderr" \
  "probe-created master disconnected TUNNEL_SERVICE_TOKEN_SECRET=[redacted]"
assert_not_contains "$auto_master_reuse/stderr" "probe-secret"

diagnostic_write_failure="${tmp}/diagnostic-write-failure"
setup_case "$diagnostic_write_failure"
diagnostic_write_status=0
invoke_wrapper "$diagnostic_write_failure" actual-failure sftp \
  metal@dev-1.aws.vm3.ai \
  > "$diagnostic_write_failure/stdout" 2>&- || diagnostic_write_status=$?
if [ "$diagnostic_write_status" -ne 17 ]; then
  fail "unwritable diagnostics must preserve caller status 17; got ${diagnostic_write_status}"
fi
assert_line_count "$diagnostic_write_failure/sftp.log" 1 \
  "metal@dev-1.aws.vm3.ai"

invalid_timeout="${tmp}/invalid-timeout"
OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS=0 \
  run_wrapper "$invalid_timeout" healthy ssh \
    metal@dev-1.aws.vm3.ai must-not-run
assert_contains "$invalid_timeout/status" "2"
assert_contains "$invalid_timeout/stderr" \
  "Invalid Cloudflare SSH operation timeout: 0"
if [ -s "$invalid_timeout/ssh.log" ]; then
  fail "invalid operation timeout must fail before the transport probe"
fi

actual_timeout="${tmp}/actual-timeout"
FAKE_TIMEOUT_MODE=real \
  OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS=1 \
  run_wrapper "$actual_timeout" actual-hang ssh \
    metal@dev-1.aws.vm3.ai run-once-and-hang
case "$(< "$actual_timeout/status")" in
  124|137) ;;
  *)
    fail \
      "timed-out caller returned unexpected status: $(< "$actual_timeout/status")"
    ;;
esac
assert_line_count "$actual_timeout/actual-ssh.log" 1 \
  "metal@dev-1.aws.vm3.ai run-once-and-hang"
assert_contains "$actual_timeout/timeout.log" \
  "--kill-after=5s 1s ${fake_ssh} metal@dev-1.aws.vm3.ai run-once-and-hang"
assert_contains "$actual_timeout/stderr" 'sending signal TERM to command'
assert_process_gone "$actual_timeout/actual-ssh.pid" "timed-out SSH caller"
assert_process_gone \
  "$actual_timeout/actual-ssh-child.pid" \
  "timed-out SSH descendant"

actual_cancel="${tmp}/actual-cancel"
setup_case "$actual_cancel"
FAKE_TIMEOUT_MODE=real \
  OKOU_CLOUDFLARE_SSH_OPERATION_TIMEOUT_SECONDS=30 \
  invoke_wrapper "$actual_cancel" actual-hang ssh \
    metal@dev-1.aws.vm3.ai run-once-until-cancelled \
    > "$actual_cancel/stdout" 2> "$actual_cancel/stderr" &
actual_cancel_invocation_pid=$!
for _ in {1..50}; do
  if [ -s "$actual_cancel/actual-ssh.pid" ] \
    && [ -s "$actual_cancel/actual-ssh-child.pid" ]; then
    break
  fi
  sleep 0.1
done
[ -s "$actual_cancel/actual-ssh.pid" ] \
  || fail "cancelled SSH caller did not start"
[ -s "$actual_cancel/actual-ssh-child.pid" ] \
  || fail "cancelled SSH descendant did not start"
actual_cancel_pid=$(< "$actual_cancel/actual-ssh.pid")
actual_cancel_timeout_pid=$(ps -o ppid= -p "$actual_cancel_pid" \
  | tr -d '[:space:]')
actual_cancel_wrapper_pid=$(ps -o ppid= -p "$actual_cancel_timeout_pid" \
  | tr -d '[:space:]')
kill -TERM "$actual_cancel_wrapper_pid"
actual_cancel_status=0
wait "$actual_cancel_invocation_pid" || actual_cancel_status=$?
if [ "$actual_cancel_status" -ne 143 ]; then
  fail "cancelled caller returned ${actual_cancel_status}, expected 143"
fi
assert_contains "$actual_cancel/stderr" 'Cloudflare SSH caller signal:'
assert_contains "$actual_cancel/stderr" 'signal=TERM'
assert_contains "$actual_cancel/stderr" 'event=caller-signal'
assert_line_count "$actual_cancel/actual-ssh.log" 1 \
  "metal@dev-1.aws.vm3.ai run-once-until-cancelled"
assert_process_gone "$actual_cancel/actual-ssh.pid" "cancelled SSH caller"
assert_process_gone \
  "$actual_cancel/actual-ssh-child.pid" \
  "cancelled SSH descendant"

recovery="${tmp}/github-runner-recovery-case"
setup_case "$recovery"
invoke_wrapper "$recovery" healthy preconnect metal dev-11.gcp.vm3.ai \
  > "$recovery/preconnect.stdout" 2> "$recovery/preconnect.stderr"
recovery_initial_log=$(find "$recovery/runner-temp" -name 'cloudflare-ssh-master-*.stderr' -print -quit)
# A permanent error from an earlier channel must not reclassify this probe's
# transient failure when both append to the retained master log.
printf 'Permission denied (publickey).\n' >> "$recovery_initial_log"
run_wrapper "$recovery" stale-success ssh \
  metal@dev-11.gcp.vm3.ai touch /tmp/recovered-operation
assert_contains "$recovery/status" "0"
assert_contains "$recovery/stderr" \
  "::warning title=Cloudflare SSH command-channel probe failed::"
assert_contains "$recovery/stderr" "--secret [redacted]"
assert_contains "$recovery/stderr" "TUNNEL_SERVICE_TOKEN_ID=[redacted]"
assert_not_contains "$recovery/stderr" "super-secret"
assert_not_contains "$recovery/stderr" "client-id"
if [ -s "$recovery/stdout" ]; then
  fail "transport recovery must not pollute caller stdout"
fi
assert_line_count "$recovery/ssh.log" 1 \
  "-v -n -T metal@dev-11.gcp.vm3.ai true"

state_file=$(find "$recovery/state" -name '*.control-path' -print -quit)
[ -n "$state_file" ] || fail "expected recovery control-path state"
selected_control_path=$(< "$state_file")
[ -n "$selected_control_path" ] || fail "expected selected recovery socket"
control_path_bind_length=$((${#selected_control_path} + 17))
if [ "$control_path_bind_length" -gt 107 ]; then
  fail "recovery control path exceeds the Linux Unix socket path limit"
fi
assert_line_count "$recovery/ssh.log" 1 \
  "-S ${selected_control_path} -v -n -M -N -f metal@dev-11.gcp.vm3.ai"
assert_line_count "$recovery/ssh.log" 1 \
  "-S ${selected_control_path} -n -O check metal@dev-11.gcp.vm3.ai"
assert_line_count "$recovery/ssh.log" 1 \
  "-S ${selected_control_path} -v -n -T metal@dev-11.gcp.vm3.ai true"
assert_line_count "$recovery/actual-ssh.log" 1 \
  "-o ControlPath=${selected_control_path} metal@dev-11.gcp.vm3.ai touch /tmp/recovered-operation"
assert_not_contains "$recovery/ssh.log" "-n -O exit metal@dev-11.gcp.vm3.ai"

run_wrapper "$recovery" stale-success scp \
  /tmp/nbd-cow-test metal@dev-11.gcp.vm3.ai:/tmp/nbd-cow-test
assert_contains "$recovery/status" "0"
assert_line_count "$recovery/ssh.log" 2 \
  "-S ${selected_control_path} -v -n -T metal@dev-11.gcp.vm3.ai true"
assert_line_count "$recovery/scp.log" 1 \
  "-o ControlPath=${selected_control_path} /tmp/nbd-cow-test metal@dev-11.gcp.vm3.ai:/tmp/nbd-cow-test"
assert_match_count "$recovery/ssh.log" 2 "-M -N -f"

ansible_ssh="${tmp}/ansible-ssh"
run_wrapper "$ansible_ssh" stale-success ssh \
  -C \
  -o ControlMaster=auto \
  -o ControlPersist=600s \
  -o ControlPath=/tmp/default-control \
  -o 'User="metal"' \
  -o ConnectTimeout=10 \
  dev-11.gcp.vm3.ai printf ansible-operation
ansible_control_path=$(< "$(find "$ansible_ssh/state" -name '*.control-path' -print -quit)")
assert_contains "$ansible_ssh/status" "0"
assert_line_count "$ansible_ssh/actual-ssh.log" 1 \
  "-o ControlPath=${ansible_control_path} -C -o ControlMaster=auto -o ControlPersist=600s -o ControlPath=/tmp/default-control -o User=\"metal\" -o ConnectTimeout=10 dev-11.gcp.vm3.ai printf ansible-operation"

ansible_scp="${tmp}/ansible-scp"
run_wrapper "$ansible_scp" stale-success scp \
  -o ControlMaster=auto \
  -o ControlPath=/tmp/default-control \
  -o 'User="metal"' \
  /tmp/source dev-11.gcp.vm3.ai:/tmp/target
ansible_scp_control_path=$(< "$(find "$ansible_scp/state" -name '*.control-path' -print -quit)")
assert_contains "$ansible_scp/status" "0"
assert_line_count "$ansible_scp/scp.log" 1 \
  "-o ControlPath=${ansible_scp_control_path} -o ControlMaster=auto -o ControlPath=/tmp/default-control -o User=\"metal\" /tmp/source dev-11.gcp.vm3.ai:/tmp/target"

sftp_batch_expected="${tmp}/sftp-batch"
printf 'put /tmp/source /tmp/target\nquit\n' > "$sftp_batch_expected"
ansible_sftp="${tmp}/ansible-sftp"
run_wrapper "$ansible_sftp" stale-success sftp \
  -b - \
  -o ControlMaster=auto \
  -o ControlPath=/tmp/default-control \
  -o 'User="metal"' \
  dev-11.gcp.vm3.ai < "$sftp_batch_expected"
ansible_sftp_control_path=$(< "$(find "$ansible_sftp/state" -name '*.control-path' -print -quit)")
assert_contains "$ansible_sftp/status" "0"
assert_line_count "$ansible_sftp/sftp.log" 1 \
  "-o ControlPath=${ansible_sftp_control_path} -b - -o ControlMaster=auto -o ControlPath=/tmp/default-control -o User=\"metal\" dev-11.gcp.vm3.ai"
cmp "$sftp_batch_expected" "$ansible_sftp/sftp-stdin"
if [ -s "$ansible_sftp/probe-stdin" ]; then
  fail "transport probe consumed SFTP batch stdin"
fi

ssh_stdin_expected="${tmp}/ssh-stdin"
printf 'line one\nbinary\0payload\n' > "$ssh_stdin_expected"
stdin_case="${tmp}/stdin"
run_wrapper "$stdin_case" stale-success ssh \
  metal@dev-2.aws.vm3.ai capture-stdin < "$ssh_stdin_expected"
assert_contains "$stdin_case/status" "0"
cmp "$ssh_stdin_expected" "$stdin_case/ssh-stdin"
if [ -s "$stdin_case/probe-stdin" ]; then
  fail "transport probe consumed SSH stdin"
fi
assert_contains "$stdin_case/ssh.log" \
  "-v -n -T metal@dev-2.aws.vm3.ai true"

old_control_path="$selected_control_path"
printf 'master channel failed TUNNEL_SERVICE_TOKEN_SECRET=master-secret\n' \
  > "${old_control_path}.stderr"
export FAKE_STALE_CONTROL_PATH="$old_control_path"
run_wrapper "$recovery" selected-stale-success ssh \
  metal@dev-11.gcp.vm3.ai touch /tmp/second-recovery
unset FAKE_STALE_CONTROL_PATH
new_control_path=$(< "$state_file")
if [ "$new_control_path" = "$old_control_path" ]; then
  fail "stale selected transport must be replaced with a unique socket"
fi
assert_match_count "$recovery/ssh.log" 3 "-M -N -f"
assert_line_count "$recovery/actual-ssh.log" 1 \
  "-o ControlPath=${new_control_path} metal@dev-11.gcp.vm3.ai touch /tmp/second-recovery"
assert_not_contains "$recovery/ssh.log" \
  "-S ${old_control_path} -n -O exit metal@dev-11.gcp.vm3.ai"
assert_contains "$recovery/stderr" \
  "TUNNEL_SERVICE_TOKEN_SECRET=[redacted]"
assert_not_contains "$recovery/stderr" "master-secret"

# A recovered connection owns a different log; report that connection's late
# failure without reading another master's log or submitting the transfer again.
printf 'debug1: recovered master closed TUNNEL_SERVICE_TOKEN_SECRET=recovery-secret\n' \
  > "${new_control_path}.stderr"
run_wrapper "$recovery" actual-failure sftp \
  metal@dev-11.gcp.vm3.ai
assert_contains "$recovery/status" "17"
assert_line_count "$recovery/sftp.log" 1 \
  "-o ControlPath=${new_control_path} metal@dev-11.gcp.vm3.ai"
assert_contains "$recovery/stderr" "recovered master closed TUNNEL_SERVICE_TOKEN_SECRET=[redacted]"
assert_not_contains "$recovery/stderr" "recovery-secret"

large_log="${tmp}/large-log"
setup_case "$large_log"
invoke_wrapper "$large_log" healthy preconnect metal dev-1.aws.vm3.ai \
  > "$large_log/preconnect.stdout" 2> "$large_log/preconnect.stderr"
large_master_log=$(find "$large_log/runner-temp" -name 'cloudflare-ssh-master-*.stderr' -print -quit)
printf '%100000s\n' '' >> "$large_master_log"
run_wrapper "$large_log" actual-failure ssh \
  metal@dev-1.aws.vm3.ai run-once
assert_contains "$large_log/status" "42"
if [ "$(wc -c < "$large_log/stderr")" -gt 66000 ]; then
  fail "master diagnostics must be limited to 64 KiB plus caller context"
fi

exhaustion="${tmp}/exhaustion"
run_wrapper "$exhaustion" stale-exhaustion scp \
  /tmp/source metal@dev-3.aws.vm3.ai:/tmp/target
assert_contains "$exhaustion/status" "255"
assert_contains "$exhaustion/stderr" \
  "::error title=Cloudflare SSH command-channel probe failed::"
assert_contains "$exhaustion/stderr" "--secret [redacted]"
assert_contains "$exhaustion/stderr" "--id [redacted]"
assert_not_contains "$exhaustion/stderr" "super-secret"
assert_not_contains "$exhaustion/stderr" "client-id"
if [ -s "$exhaustion/scp.log" ]; then
  fail "probe exhaustion must not submit the SCP operation"
fi
assert_contains "$exhaustion/ssh.log" "-n -O exit metal@dev-3.aws.vm3.ai"

permanent="${tmp}/permanent"
run_wrapper "$permanent" permanent ssh \
  metal@dev-4.aws.vm3.ai touch /tmp/must-not-run
assert_contains "$permanent/status" "255"
assert_contains "$permanent/stderr" \
  "::error title=Cloudflare SSH command-channel probe failed::"
assert_contains "$permanent/stderr" "Permission denied (publickey)."
assert_not_contains "$permanent/stderr" "super-secret"
assert_not_contains "$permanent/ssh.log" "-M -N -f"
if [ -s "$permanent/actual-ssh.log" ]; then
  fail "permanent probe failure must not submit the SSH operation"
fi

passthrough="${tmp}/passthrough"
run_wrapper "$passthrough" stale-exhaustion ssh \
  deploy@example.com touch /tmp/passthrough
assert_contains "$passthrough/status" "0"
assert_line_count "$passthrough/ssh.log" 1 \
  "deploy@example.com touch /tmp/passthrough"
assert_line_count "$passthrough/actual-ssh.log" 1 \
  "deploy@example.com touch /tmp/passthrough"
assert_not_contains "$passthrough/ssh.log" " true"

explicit="${tmp}/explicit"
run_wrapper "$explicit" stale-exhaustion ssh \
  -S /tmp/caller-owned.sock metal@dev-5.aws.vm3.ai touch /tmp/explicit
assert_contains "$explicit/status" "0"
assert_line_count "$explicit/ssh.log" 1 \
  "-S /tmp/caller-owned.sock metal@dev-5.aws.vm3.ai touch /tmp/explicit"
assert_not_contains "$explicit/ssh.log" " true"

disabled_master="${tmp}/disabled-master"
run_wrapper "$disabled_master" stale-exhaustion ssh \
  -o ControlMaster=no \
  metal@dev-5.aws.vm3.ai touch /tmp/disabled-master
assert_contains "$disabled_master/status" "0"
assert_line_count "$disabled_master/ssh.log" 1 \
  "-o ControlMaster=no metal@dev-5.aws.vm3.ai touch /tmp/disabled-master"
assert_not_contains "$disabled_master/ssh.log" " true"

mismatched_control_path="${tmp}/mismatched-control-path"
run_wrapper "$mismatched_control_path" stale-exhaustion ssh \
  -o ControlPath=/tmp/other-control \
  metal@dev-5.aws.vm3.ai touch /tmp/mismatched-control-path
assert_contains "$mismatched_control_path/status" "0"
assert_line_count "$mismatched_control_path/ssh.log" 1 \
  "-o ControlPath=/tmp/other-control metal@dev-5.aws.vm3.ai touch /tmp/mismatched-control-path"
assert_not_contains "$mismatched_control_path/ssh.log" " true"

control="${tmp}/control"
run_wrapper "$control" stale-exhaustion ssh \
  -O check metal@dev-5.aws.vm3.ai
assert_contains "$control/status" "0"
assert_line_count "$control/ssh.log" 1 \
  "-O check metal@dev-5.aws.vm3.ai"
assert_not_contains "$control/ssh.log" " true"

unsupported="${tmp}/unsupported"
run_wrapper "$unsupported" stale-exhaustion ssh \
  -J jump.example.com metal@dev-6.aws.vm3.ai touch /tmp/unsupported
assert_contains "$unsupported/status" "0"
assert_line_count "$unsupported/ssh.log" 1 \
  "-J jump.example.com metal@dev-6.aws.vm3.ai touch /tmp/unsupported"
assert_not_contains "$unsupported/ssh.log" " true"

uri_port="${tmp}/uri-port"
run_wrapper "$uri_port" stale-exhaustion ssh \
  ssh://metal@dev-6.aws.vm3.ai:2222 touch /tmp/uri-port
assert_contains "$uri_port/status" "0"
assert_line_count "$uri_port/ssh.log" 1 \
  "ssh://metal@dev-6.aws.vm3.ai:2222 touch /tmp/uri-port"
assert_not_contains "$uri_port/ssh.log" " true"

remote_copy="${tmp}/remote-copy"
run_wrapper "$remote_copy" stale-exhaustion scp \
  metal@dev-6.aws.vm3.ai:/tmp/source \
  metal@dev-7.aws.vm3.ai:/tmp/target
assert_contains "$remote_copy/status" "0"
assert_line_count "$remote_copy/scp.log" 1 \
  "metal@dev-6.aws.vm3.ai:/tmp/source metal@dev-7.aws.vm3.ai:/tmp/target"
if [ -s "$remote_copy/ssh.log" ]; then
  fail "remote-to-remote SCP must bypass the transport guard"
fi

concurrent="${tmp}/concurrent"
setup_case "$concurrent"
invoke_wrapper "$concurrent" stale-success ssh \
  metal@dev-8.aws.vm3.ai touch /tmp/concurrent-ssh \
  > "$concurrent/stdout-1" 2> "$concurrent/stderr-1" &
pid1=$!
invoke_wrapper "$concurrent" stale-success scp \
  /tmp/source metal@dev-8.aws.vm3.ai:/tmp/concurrent-scp \
  > "$concurrent/stdout-2" 2> "$concurrent/stderr-2" &
pid2=$!
status1=0
status2=0
wait "$pid1" || status1=$?
wait "$pid2" || status2=$?
if [ "$status1" -ne 0 ] || [ "$status2" -ne 0 ]; then
  fail "concurrent guarded operations failed: ssh=${status1}, scp=${status2}"
fi
assert_match_count "$concurrent/ssh.log" 1 "-M -N -f"
assert_match_count "$concurrent/actual-ssh.log" 1 \
  "metal@dev-8.aws.vm3.ai touch /tmp/concurrent-ssh"
assert_match_count "$concurrent/scp.log" 1 "/tmp/source metal@dev-8.aws.vm3.ai:/tmp/concurrent-scp"
if [ -s "$concurrent/probe-stdin" ]; then
  fail "concurrent probes consumed caller stdin"
fi

echo "cloudflare-ssh-command-test: ok"
