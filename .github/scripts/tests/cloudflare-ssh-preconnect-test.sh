#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PRECONNECT="$REPO_ROOT/.github/scripts/runner/cloudflare-ssh-preconnect.sh"
SSH_ACTION="$REPO_ROOT/.github/actions/setup-ssh-tunnel/action.yml"
ANSIBLE_CONFIG="$REPO_ROOT/ansible/ansible.cfg"

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

assert_line_count() {
  local file="$1"
  local expected="$2"
  local pattern="$3"
  local actual
  actual=$(grep -Fxc -- "$pattern" "$file" || true)
  if [ "$actual" -ne "$expected" ]; then
    echo "expected ${file} to contain ${expected} exact line(s): ${pattern}; got ${actual}" >&2
    cat "$file" >&2
    exit 1
  fi
}

assert_runner_temp_empty() {
  local dir="$1"
  if find "$dir" -mindepth 1 -print -quit | grep -q .; then
    echo "expected runner temp to be empty: ${dir}" >&2
    find "$dir" -mindepth 1 -maxdepth 2 -print >&2
    exit 1
  fi
}

tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

fake_bin="$tmp/bin"
mkdir -p "$fake_bin"

fake_ssh="$fake_bin/ssh"
cat > "$fake_ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$FAKE_SSH_INVOCATIONS"

if [[ " $* " == *" -O check "* ]]; then
  check_count_file="$FAKE_SSH_STATE_DIR/check-count"
  check_count=0
  if [ -f "$check_count_file" ]; then
    check_count=$(<"$check_count_file")
  fi
  check_count=$((check_count + 1))
  printf '%s\n' "$check_count" > "$check_count_file"
  if [ "$FAKE_SSH_SCENARIO" = "check-failure-success" ] && [ "$check_count" -eq 1 ]; then
    echo "Control socket connect failed: Connection refused" >&2
    exit 255
  fi
  echo "Master running"
  exit 0
fi

if [[ " $* " == *" -O exit "* ]]; then
  exit 0
fi

count_file="$FAKE_SSH_STATE_DIR/master-count"
count=0
if [ -f "$count_file" ]; then
  count=$(<"$count_file")
fi
count=$((count + 1))
printf '%s\n' "$count" > "$count_file"

case "$FAKE_SSH_SCENARIO" in
  transient-success)
    if [ "$count" -eq 1 ]; then
      echo "Connection closed by UNKNOWN port 65535 --secret super-secret" >&2
      echo "TUNNEL_SERVICE_TOKEN_ID=client-id" >&2
      if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        echo "intermediate failure" >> "$GITHUB_STEP_SUMMARY"
      fi
      exit 255
    fi
    ;;
  reconnect-window-success)
    if [ "$count" -le 3 ]; then
      echo "Connection closed by UNKNOWN port 65535 --secret super-secret" >&2
      echo "TUNNEL_SERVICE_TOKEN_ID=client-id" >&2
      exit 255
    fi
    ;;
  timeout-success)
    if [ "$count" -eq 1 ]; then
      echo "Cloudflare SSH transport timed out --secret super-secret" >&2
      exit 124
    fi
    ;;
  permanent)
    echo "Permission denied (publickey)." >&2
    echo "TUNNEL_SERVICE_TOKEN_SECRET=super-secret" >&2
    echo "TUNNEL_SERVICE_TOKEN_ID=client-id" >&2
    echo "::error title=Cloudflare Access credentials rejected::Access denied for TUNNEL_SERVICE_TOKEN_ID=client-id" >&2
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      echo "permanent failure" >> "$GITHUB_STEP_SUMMARY"
    fi
    exit 255
    ;;
  exhaustion)
    echo "Connection reset by peer --secret super-secret --id client-id" >&2
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      echo "transient failure" >> "$GITHUB_STEP_SUMMARY"
    fi
    exit 255
    ;;
  success)
    ;;
  check-failure-success)
    ;;
  partial-failure)
    if [[ "$*" == *"metal@dev-11.gcp.aws.vm3.ai"* ]]; then
      echo "Permission denied (publickey)." >&2
      exit 255
    fi
    ;;
  *)
    echo "unexpected fake SSH scenario: $FAKE_SSH_SCENARIO" >&2
    exit 2
    ;;
esac
EOF
chmod +x "$fake_ssh"

fake_sleep="$fake_bin/sleep"
cat > "$fake_sleep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SLEEP_INVOCATIONS"
EOF
chmod +x "$fake_sleep"

fake_timeout="$fake_bin/timeout"
cat > "$fake_timeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_TIMEOUT_INVOCATIONS"
if [[ "${1:-}" == --kill-after=* ]]; then
  shift
fi
shift
exec "$@"
EOF
chmod +x "$fake_timeout"

run_case() {
  local name="$1"
  local scenario="$2"
  local hosts="$3"
  local require_all_hosts="${4:-true}"
  local control_path="${5:-}"
  local case_dir="$tmp/$name"
  local -a preconnect_args=()

  mkdir -p "$case_dir/state" "$case_dir/runner-temp"
  : > "$case_dir/ssh-invocations"
  : > "$case_dir/sleep-invocations"
  : > "$case_dir/timeout-invocations"
  if [ -n "$control_path" ]; then
    preconnect_args=(--control-path "$control_path")
  fi

  local status=0
  PATH="$fake_bin:$PATH" \
  FAKE_SSH_INVOCATIONS="$case_dir/ssh-invocations" \
  FAKE_SSH_SCENARIO="$scenario" \
  FAKE_SSH_STATE_DIR="$case_dir/state" \
  FAKE_SLEEP_INVOCATIONS="$case_dir/sleep-invocations" \
  FAKE_TIMEOUT_INVOCATIONS="$case_dir/timeout-invocations" \
  GITHUB_STEP_SUMMARY="$case_dir/outer-summary" \
  RUNNER_TEMP="$case_dir/runner-temp" \
  bash "$PRECONNECT" "${preconnect_args[@]}" metal "$hosts" "$require_all_hosts" \
    > "$case_dir/stdout" 2> "$case_dir/stderr" || status=$?

  printf '%s\n' "$status" > "$case_dir/status"
}

run_case transient transient-success "dev-1.aws.vm3.ai"
assert_contains "$tmp/transient/status" "0"
assert_contains "$tmp/transient/stdout" "Established replay-safe SSH transport to dev-1.aws.vm3.ai"
assert_contains "$tmp/transient/stderr" "::warning title=Retrying Cloudflare SSH preconnection::"
assert_not_contains "$tmp/transient/stderr" "::error"
assert_not_contains "$tmp/transient/stderr" "super-secret"
assert_not_contains "$tmp/transient/stderr" "client-id"
assert_line_count "$tmp/transient/ssh-invocations" 2 "-n -M -N -f metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/transient/ssh-invocations" 1 "-n -O check metal@dev-1.aws.vm3.ai"
assert_contains "$tmp/transient/timeout-invocations" "--kill-after=5s 40s ssh -n -M -N -f metal@dev-1.aws.vm3.ai"
assert_contains "$tmp/transient/timeout-invocations" "--kill-after=2s 5s ssh -n -O check metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/transient/sleep-invocations" 1 "1"
if [ -e "$tmp/transient/outer-summary" ]; then
  echo "expected recovered attempt not to write the job summary" >&2
  cat "$tmp/transient/outer-summary" >&2
  exit 1
fi
assert_runner_temp_empty "$tmp/transient/runner-temp"

run_case reconnect-window reconnect-window-success "dev-1.aws.vm3.ai"
assert_contains "$tmp/reconnect-window/status" "0"
assert_contains "$tmp/reconnect-window/stdout" "Established replay-safe SSH transport to dev-1.aws.vm3.ai"
assert_contains "$tmp/reconnect-window/stderr" "attempt 3/4"
assert_not_contains "$tmp/reconnect-window/stderr" "::error"
assert_not_contains "$tmp/reconnect-window/stderr" "super-secret"
assert_not_contains "$tmp/reconnect-window/stderr" "client-id"
assert_line_count "$tmp/reconnect-window/ssh-invocations" 4 "-n -M -N -f metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/reconnect-window/ssh-invocations" 1 "-n -O check metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/reconnect-window/sleep-invocations" 1 "1"
assert_line_count "$tmp/reconnect-window/sleep-invocations" 1 "5"
assert_line_count "$tmp/reconnect-window/sleep-invocations" 1 "15"
if [ -e "$tmp/reconnect-window/outer-summary" ]; then
  echo "expected recovered attempts not to write the job summary" >&2
  cat "$tmp/reconnect-window/outer-summary" >&2
  exit 1
fi
assert_runner_temp_empty "$tmp/reconnect-window/runner-temp"

run_case timeout timeout-success "dev-1.aws.vm3.ai"
assert_contains "$tmp/timeout/status" "0"
assert_contains "$tmp/timeout/stderr" "::warning title=Retrying Cloudflare SSH preconnection::"
assert_contains "$tmp/timeout/stderr" "Cloudflare SSH transport timed out --secret [redacted]"
assert_not_contains "$tmp/timeout/stderr" "super-secret"
assert_line_count "$tmp/timeout/ssh-invocations" 2 "-n -M -N -f metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/timeout/sleep-invocations" 1 "1"
assert_runner_temp_empty "$tmp/timeout/runner-temp"

run_case check-failure check-failure-success "dev-1.aws.vm3.ai"
assert_contains "$tmp/check-failure/status" "0"
assert_contains "$tmp/check-failure/stderr" "::warning title=Retrying Cloudflare SSH preconnection::"
assert_not_contains "$tmp/check-failure/stderr" "::error"
assert_line_count "$tmp/check-failure/ssh-invocations" 2 "-n -M -N -f metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/check-failure/ssh-invocations" 2 "-n -O check metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/check-failure/ssh-invocations" 1 "-n -O exit metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/check-failure/sleep-invocations" 1 "1"
assert_runner_temp_empty "$tmp/check-failure/runner-temp"

explicit_control_path="$tmp/explicit-check/runner-temp/recovery.sock"
run_case explicit-check check-failure-success "dev-1.aws.vm3.ai" true "$explicit_control_path"
assert_contains "$tmp/explicit-check/status" "0"
assert_line_count "$tmp/explicit-check/ssh-invocations" 2 "-S $explicit_control_path -n -M -N -f metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/explicit-check/ssh-invocations" 2 "-S $explicit_control_path -n -O check metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/explicit-check/ssh-invocations" 1 "-S $explicit_control_path -n -O exit metal@dev-1.aws.vm3.ai"
assert_contains "$tmp/explicit-check/timeout-invocations" "--kill-after=2s 5s ssh -S $explicit_control_path -n -O exit metal@dev-1.aws.vm3.ai"
if [ ! -f "${explicit_control_path}.stderr" ]; then
  echo "expected explicit recovery master diagnostics to remain addressable" >&2
  exit 1
fi
rm -f "${explicit_control_path}.stderr"
assert_runner_temp_empty "$tmp/explicit-check/runner-temp"

run_case permanent permanent "dev-1.aws.vm3.ai"
assert_contains "$tmp/permanent/status" "255"
assert_contains "$tmp/permanent/stderr" "::error title=Cloudflare SSH preconnection failed::"
assert_contains "$tmp/permanent/stderr" "permanent connection failure"
assert_contains "$tmp/permanent/stderr" "Permission denied (publickey)."
assert_contains "$tmp/permanent/stderr" "TUNNEL_SERVICE_TOKEN_SECRET=[redacted]"
assert_contains "$tmp/permanent/stderr" "Access denied for TUNNEL_SERVICE_TOKEN_ID=[redacted]"
assert_not_contains "$tmp/permanent/stderr" "super-secret"
assert_not_contains "$tmp/permanent/stderr" "client-id"
if [ "$(grep -c '^::error' "$tmp/permanent/stderr")" -ne 1 ]; then
  echo "expected one final error annotation for a permanent failure" >&2
  cat "$tmp/permanent/stderr" >&2
  exit 1
fi
assert_line_count "$tmp/permanent/ssh-invocations" 1 "-n -M -N -f metal@dev-1.aws.vm3.ai"
if [ -s "$tmp/permanent/sleep-invocations" ]; then
  echo "expected a permanent failure not to sleep" >&2
  cat "$tmp/permanent/sleep-invocations" >&2
  exit 1
fi
if [ -e "$tmp/permanent/outer-summary" ]; then
  echo "expected permanent attempt diagnostics to stay out of the job summary" >&2
  cat "$tmp/permanent/outer-summary" >&2
  exit 1
fi
assert_runner_temp_empty "$tmp/permanent/runner-temp"

run_case partial-failure partial-failure "dev-1.aws.vm3.ai,dev-11.gcp.aws.vm3.ai"
assert_contains "$tmp/partial-failure/status" "255"
assert_line_count "$tmp/partial-failure/ssh-invocations" 1 "-n -M -N -f metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/partial-failure/ssh-invocations" 1 "-n -O check metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/partial-failure/ssh-invocations" 1 "-n -M -N -f metal@dev-11.gcp.aws.vm3.ai"
assert_line_count "$tmp/partial-failure/ssh-invocations" 1 "-n -O exit metal@dev-1.aws.vm3.ai"
assert_runner_temp_empty "$tmp/partial-failure/runner-temp"

run_case partial-best-effort partial-failure "dev-1.aws.vm3.ai,dev-11.gcp.aws.vm3.ai,dev-2.aws.vm3.ai" false
assert_contains "$tmp/partial-best-effort/status" "0"
assert_contains "$tmp/partial-best-effort/stderr" "::warning title=Cloudflare SSH preconnection failed::"
assert_not_contains "$tmp/partial-best-effort/stderr" "::error"
assert_line_count "$tmp/partial-best-effort/ssh-invocations" 1 "-n -M -N -f metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/partial-best-effort/ssh-invocations" 1 "-n -O check metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/partial-best-effort/ssh-invocations" 1 "-n -M -N -f metal@dev-11.gcp.aws.vm3.ai"
assert_line_count "$tmp/partial-best-effort/ssh-invocations" 1 "-n -M -N -f metal@dev-2.aws.vm3.ai"
assert_line_count "$tmp/partial-best-effort/ssh-invocations" 1 "-n -O check metal@dev-2.aws.vm3.ai"
assert_line_count "$tmp/partial-best-effort/ssh-invocations" 0 "-n -O exit metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/partial-best-effort/ssh-invocations" 0 "-n -O exit metal@dev-2.aws.vm3.ai"
assert_runner_temp_empty "$tmp/partial-best-effort/runner-temp"

run_case exhaustion exhaustion "dev-1.aws.vm3.ai"
assert_contains "$tmp/exhaustion/status" "255"
assert_contains "$tmp/exhaustion/stderr" "retry limit reached after 4 attempts"
assert_contains "$tmp/exhaustion/stderr" "--secret [redacted]"
assert_contains "$tmp/exhaustion/stderr" "--id [redacted]"
assert_not_contains "$tmp/exhaustion/stderr" "super-secret"
assert_not_contains "$tmp/exhaustion/stderr" "client-id"
if [ "$(grep -c '^::error' "$tmp/exhaustion/stderr")" -ne 1 ]; then
  echo "expected one final error annotation after retry exhaustion" >&2
  cat "$tmp/exhaustion/stderr" >&2
  exit 1
fi
assert_line_count "$tmp/exhaustion/ssh-invocations" 4 "-n -M -N -f metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/exhaustion/sleep-invocations" 1 "1"
assert_line_count "$tmp/exhaustion/sleep-invocations" 1 "5"
assert_line_count "$tmp/exhaustion/sleep-invocations" 1 "15"
assert_runner_temp_empty "$tmp/exhaustion/runner-temp"

run_case multiple success $' dev-1.aws.vm3.ai,dev-11.gcp.aws.vm3.ai\nDEV-1.AWS.VM3.AI '
assert_contains "$tmp/multiple/status" "0"
assert_line_count "$tmp/multiple/ssh-invocations" 1 "-n -M -N -f metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/multiple/ssh-invocations" 1 "-n -O check metal@dev-1.aws.vm3.ai"
assert_line_count "$tmp/multiple/ssh-invocations" 1 "-n -M -N -f metal@dev-11.gcp.aws.vm3.ai"
assert_line_count "$tmp/multiple/ssh-invocations" 1 "-n -O check metal@dev-11.gcp.aws.vm3.ai"
if grep -Fq "DEV-1.AWS.VM3.AI" "$tmp/multiple/ssh-invocations"; then
  echo "expected duplicate hosts to be pre-connected once" >&2
  cat "$tmp/multiple/ssh-invocations" >&2
  exit 1
fi
assert_runner_temp_empty "$tmp/multiple/runner-temp"

assert_contains "$SSH_ACTION" "ControlPath \$HOME/.ssh/vm0-ssh-%C"
assert_contains "$SSH_ACTION" "ANSIBLE_SSH_CONTROL_PATH=%s"
assert_contains "$SSH_ACTION" "\$HOME/.ssh/vm0-ssh-%%C"
assert_contains "$SSH_ACTION" "ServerAliveInterval 15"
assert_contains "$SSH_ACTION" "ServerAliveCountMax 20"
assert_contains "$ANSIBLE_CONFIG" 'control_path = ~/.ssh/vm0-ssh-%%C'
assert_contains "$ANSIBLE_CONFIG" "ServerAliveInterval=15"
assert_contains "$ANSIBLE_CONFIG" "ServerAliveCountMax=20"

echo "cloudflare-ssh-preconnect-test: ok"
