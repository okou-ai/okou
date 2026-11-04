#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
ansible_config="$repo_root/ansible/ansible.cfg"
playbook="$script_dir/fixtures/ansible-ssh-control-path.yml"
promote_playbook="$repo_root/ansible/playbooks/promote-runner.yml"
rollback_playbook="$repo_root/ansible/playbooks/rollback-runner.yml"

if ! command -v ansible-playbook >/dev/null; then
  echo "ansible-playbook is required" >&2
  exit 1
fi

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

test_home="$tmp/github-home"
mkdir -p "$test_home/.ssh"

fake_ssh="$tmp/ssh"
cat > "$fake_ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$SSH_INVOCATIONS"

actual_control_path=""

for argument in "$@"; do
  if [[ "$argument" == ControlPath=* ]]; then
    actual_control_path="${argument#ControlPath=}"
    actual_control_path="${actual_control_path#\"}"
    actual_control_path="${actual_control_path%\"}"
    break
  fi
done

if [ "$actual_control_path" != "$EXPECTED_CONTROL_PATH" ]; then
  echo "expected Ansible SSH control path: ${EXPECTED_CONTROL_PATH}" >&2
  echo "actual Ansible SSH control path: ${actual_control_path:-missing}" >&2
  printf 'argument: %s\n' "$@" >&2
  exit 1
fi

if [ ! -d "$(dirname "$EXPECTED_CONTROL_PATH")" ]; then
  echo "Ansible SSH control path parent does not exist" >&2
  exit 1
fi

case "$SSH_SCENARIO" in
  success)
    ;;
  transient)
    if [ ! -e "$SSH_TRANSIENT_MARKER" ]; then
      touch "$SSH_TRANSIENT_MARKER"
      exit 255
    fi
    ;;
  remote-failure)
    exit 1
    ;;
  *)
    echo "unexpected SSH scenario: $SSH_SCENARIO" >&2
    exit 2
    ;;
esac

touch "$SSH_MARKER"
printf 'ansible ssh transport ok\n'
EOF
chmod +x "$fake_ssh"

expected_control_path="$test_home/.ssh/vm0-ssh-%C"
run_ansible() {
  local scenario=$1
  local invocation_log=$2
  local ssh_marker=$3
  local output="$tmp/ansible-$scenario-output"
  local started_ns
  local status=0
  shift 3

  started_ns=$(date +%s%N)
  printf 'Ansible SSH scenario %s: started\n' "$scenario" >&2
  HOME="$test_home" \
    ANSIBLE_CONFIG="$ansible_config" \
    ANSIBLE_NOCOLOR=1 \
    ANSIBLE_SSH_CONTROL_PATH="$test_home/.ssh/vm0-ssh-%%C" \
    EXPECTED_CONTROL_PATH="$expected_control_path" \
    SSH_INVOCATIONS="$invocation_log" \
    SSH_MARKER="$ssh_marker" \
    SSH_SCENARIO="$scenario" \
    SSH_TRANSIENT_MARKER="$tmp/transient-failed" \
    ansible-playbook \
    -i "ansible-test.invalid," \
    -e "ansible_ssh_executable=$fake_ssh" \
    "$@" \
    "$playbook" >"$output" 2>&1 || status=$?
  printf 'Ansible SSH scenario %s: %s ms, exit %s\n' \
    "$scenario" "$((($(date +%s%N) - started_ns) / 1000000))" "$status" >&2
  if ((status != 0)); then
    cat "$output" >&2
  fi
  return "$status"
}

assert_invocation_count() {
  local invocation_log=$1
  local expected=$2
  local actual
  actual=$(wc -l < "$invocation_log")
  if [ "$actual" -ne "$expected" ]; then
    echo "expected ${expected} SSH invocation(s), got ${actual}" >&2
    cat "$invocation_log" >&2
    exit 1
  fi
}

success_invocations="$tmp/success-invocations"
success_marker="$tmp/success-ran"
: > "$success_invocations"
run_ansible success "$success_invocations" "$success_marker"

if [ ! -f "$success_marker" ]; then
  echo "expected Ansible to complete an SSH-backed task" >&2
  exit 1
fi
assert_invocation_count "$success_invocations" 1

transient_invocations="$tmp/transient-invocations"
transient_marker="$tmp/transient-ran"
: > "$transient_invocations"
run_ansible transient "$transient_invocations" "$transient_marker" \
  -e "ansible_ssh_retries=1"

if [ ! -f "$transient_marker" ]; then
  echo "expected Ansible to recover from one transient SSH failure" >&2
  exit 1
fi
assert_invocation_count "$transient_invocations" 2

remote_failure_invocations="$tmp/remote-failure-invocations"
: > "$remote_failure_invocations"
if run_ansible remote-failure "$remote_failure_invocations" "$tmp/remote-failure-ran" \
  -e "ansible_ssh_retries=1"; then
  echo "expected a normal remote failure to fail the play" >&2
  exit 1
fi
assert_invocation_count "$remote_failure_invocations" 1

if ! grep -Fq "ansible_ssh_retries: 1" "$promote_playbook"; then
  echo "expected runner promotion to configure one SSH connection retry" >&2
  exit 1
fi
if grep -Fq "ansible_ssh_retries" "$rollback_playbook" "$ansible_config"; then
  echo "expected the SSH connection retry to remain promotion-scoped" >&2
  exit 1
fi

echo "ansible-ssh-control-path-test: ok"
