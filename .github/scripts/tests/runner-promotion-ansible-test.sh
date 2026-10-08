#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
ansible_config="$repo_root/ansible/ansible.cfg"
inventory="$script_dir/fixtures/runner-promotion-local.ini"
promote_playbook="$repo_root/ansible/playbooks/promote-runner.yml"
rollback_playbook="$repo_root/ansible/playbooks/rollback-runner.yml"
gc_task="$repo_root/ansible/tasks/garbage-collect-runner.yml"
release_workflow="$repo_root/.github/workflows/release-please.yml"

for command in ansible-playbook yq; do
  if ! command -v "$command" >/dev/null; then
    echo "$command is required" >&2
    exit 1
  fi
done

assert_contains() {
  local file=$1
  local expected=$2
  if ! grep -Fq -- "$expected" "$file"; then
    echo "expected ${file} to contain: ${expected}" >&2
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

assert_tree_contains() {
  local dir=$1
  local expected=$2
  if ! grep -RFq -- "$expected" "$dir"; then
    echo "expected files under ${dir} to contain: ${expected}" >&2
    find "$dir" -type f -maxdepth 1 -print -exec cat {} \; >&2
    exit 1
  fi
}

case "$(uname -m)" in
  x86_64)
    runner_target=x86_64-unknown-linux-musl
    ;;
  aarch64)
    runner_target=aarch64-unknown-linux-musl
    ;;
  *)
    echo "unsupported test architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

test_home="$tmp/home"
data_dir="$tmp/vm0-runner"
fake_bin="$data_dir/fake-bin"
runner_release=v999.0.0
runner_bin_dir="$data_dir/bin/$runner_release"
invocation_log="$data_dir/runner-invocations"
gc_arrivals="$data_dir/gc-arrivals"
mkdir -p \
  "$test_home" \
  "$data_dir/locks" \
  "$data_dir/runners/$runner_release" \
  "$gc_arrivals" \
  "$fake_bin" \
  "$runner_bin_dir"

fake_runner="$runner_bin_dir/runner"
cat > "$fake_runner" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

data_dir="$(cd "$(dirname "$0")/../.." && pwd)"
invocation_log="$data_dir/runner-invocations"
printf '%s\n' "$*" >> "$invocation_log"

case "${1:-}" in
  service)
    case "${2:-}" in
      install)
        exit 0
        ;;
      wait-running)
        if [ -f "$data_dir/fail-wait-running" ]; then
          echo "target readiness failed" >&2
          exit 41
        fi
        exit 0
        ;;
      drain)
        service_name=${4:-}
        if [ -f "$data_dir/fail-drain-$service_name" ]; then
          echo "drain acknowledgement timed out for $service_name" >&2
          exit 42
        fi
        exit 0
        ;;
      stop)
        exit 0
        ;;
    esac
    ;;
  doctor)
    exit 0
    ;;
  gc)
    if [ "$*" != "gc --keep-latest 6 --protect-version v999.0.0" ]; then
      echo "unexpected gc arguments: $*" >&2
      exit 1
    fi

    touch "$data_dir/gc-arrivals/$BASHPID"
    exec 9> "$data_dir/locks/deployment-gc.lock"
    flock --exclusive 9

    active_dir="$data_dir/gc-active"
    if ! mkdir "$active_dir"; then
      echo "runner gc invocations overlapped" >&2
      exit 1
    fi
    trap 'rmdir "$active_dir"' EXIT

    arrivals_ready=false
    for ((attempt = 0; attempt < 1000; attempt++)); do
      arrival_count=$(
        find "$data_dir/gc-arrivals" -mindepth 1 -maxdepth 1 -type f -print |
          wc -l
      )
      if [ "$arrival_count" -ge 2 ]; then
        arrivals_ready=true
        break
      fi
      /bin/sleep 0.01
    done
    if [ "$arrivals_ready" != "true" ]; then
      echo "timed out waiting for both gc lock contenders" >&2
      exit 1
    fi
    exit 0
    ;;
esac

echo "unexpected runner invocation: $*" >&2
exit 1
EOF
chmod +x "$fake_runner"

fake_systemctl="$fake_bin/systemctl"
cat > "$fake_systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

data_dir="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\n' "$*" >> "$data_dir/systemctl-invocations"

if [ -f "$data_dir/fail-service-discovery" ]; then
  echo "systemctl discovery unavailable" >&2
  exit 43
fi

case "${1:-}" in
  list-units)
    cat <<'UNITS'
vm0-runner-v999.0.0.service loaded active running VM0 target
vm0-runner-v100.0.0.service loaded active running VM0 old running
vm0-runner-v101.0.0.service loaded activating start VM0 old activating
UNITS
    ;;
  list-unit-files)
    cat <<'UNITS'
vm0-runner-v999.0.0.service enabled
vm0-runner-v102.0.0.service enabled
UNITS
    ;;
  *)
    echo "unexpected systemctl invocation: $*" >&2
    exit 44
    ;;
esac
EOF
chmod +x "$fake_systemctl"

for playbook in "$promote_playbook" "$rollback_playbook"; do
  HOME="$test_home" \
    ANSIBLE_CONFIG="$ansible_config" \
    ANSIBLE_NOCOLOR=1 \
    ansible-playbook -i "$inventory" --syntax-check "$playbook" >/dev/null
done

assert_contains "$promote_playbook" "include_tasks: ../tasks/garbage-collect-runner.yml"
assert_contains "$rollback_playbook" "include_tasks: ../tasks/garbage-collect-runner.yml"
assert_contains "$gc_task" '      - "{{ bin_dir }}/runner"'
if grep -Fq -- "flock" "$gc_task"; then
  echo "shared GC task must rely on runner-owned serialization" >&2
  cat "$gc_task" >&2
  exit 1
fi

run_promotion() {
  local output=$1
  local warning_dir=$2
  HOME="$test_home" \
    PATH="$fake_bin:$PATH" \
    ANSIBLE_CONFIG="$ansible_config" \
    ANSIBLE_NOCOLOR=1 \
    ansible-playbook \
      -i "$inventory" \
      --forks 2 \
      -e "data_dir=$data_dir" \
      -e "runner_host_env_file=$tmp/host.env" \
      -e "runner_version=999.0.0" \
      -e "runner_target=$runner_target" \
      -e "promotion_warning_dir=$warning_dir" \
      "$promote_playbook" >"$output" 2>&1
}

reset_case() {
  rm -f "$invocation_log" "$data_dir/systemctl-invocations"
  find "$gc_arrivals" -mindepth 1 -maxdepth 1 -type f -delete
}

normal_warning_dir="$tmp/normal-warnings"
mkdir -p "$normal_warning_dir"
if ! run_promotion "$tmp/promote-output" "$normal_warning_dir"; then
  cat "$tmp/promote-output" >&2
  exit 1
fi

assert_line_count "$invocation_log" 2 \
  "gc --keep-latest 6 --protect-version $runner_release"
assert_line_count "$invocation_log" 4 "doctor --name $runner_release"
assert_line_count "$invocation_log" 2 \
  "service wait-running --name $runner_release --timeout-secs 120"
assert_line_count "$invocation_log" 0 "service drain --name $runner_release"
for old_release in v100.0.0 v101.0.0 v102.0.0; do
  assert_line_count "$invocation_log" 2 "service drain --name $old_release"
done
if find "$normal_warning_dir" -mindepth 1 -maxdepth 1 -type f -print -quit | grep -q .; then
  echo "normal promotion unexpectedly wrote warnings" >&2
  find "$normal_warning_dir" -type f -maxdepth 1 -print -exec cat {} \; >&2
  exit 1
fi

reset_case
touch "$data_dir/fail-drain-v101.0.0"
drain_warning_dir="$tmp/drain-warnings"
mkdir -p "$drain_warning_dir"
if ! run_promotion "$tmp/drain-warning-output" "$drain_warning_dir"; then
  cat "$tmp/drain-warning-output" >&2
  exit 1
fi
rm -f "$data_dir/fail-drain-v101.0.0"

for old_release in v100.0.0 v101.0.0 v102.0.0; do
  assert_line_count "$invocation_log" 2 "service drain --name $old_release"
done
assert_tree_contains "$drain_warning_dir" '"service": "vm0-runner-v101.0.0.service"'
assert_tree_contains "$drain_warning_dir" '"version": "v101.0.0"'
assert_tree_contains "$drain_warning_dir" '"state": "drain_failed"'
assert_tree_contains "$drain_warning_dir" '"error": "drain acknowledgement timed out for v101.0.0"'

reset_case
touch "$data_dir/fail-service-discovery"
discovery_warning_dir="$tmp/discovery-warnings"
mkdir -p "$discovery_warning_dir"
if ! run_promotion "$tmp/discovery-warning-output" "$discovery_warning_dir"; then
  cat "$tmp/discovery-warning-output" >&2
  exit 1
fi
rm -f "$data_dir/fail-service-discovery"

assert_line_count "$invocation_log" 0 "service drain --name v100.0.0"
assert_line_count "$invocation_log" 2 \
  "gc --keep-latest 6 --protect-version $runner_release"
assert_tree_contains "$discovery_warning_dir" '"service": "vm0-runner-*.service"'
assert_tree_contains "$discovery_warning_dir" '"state": "enumeration_failed"'
assert_tree_contains "$discovery_warning_dir" '"error": "systemctl discovery unavailable"'

reset_case
touch "$data_dir/fail-wait-running"
readiness_warning_dir="$tmp/readiness-warnings"
mkdir -p "$readiness_warning_dir"
if run_promotion "$tmp/readiness-failure-output" "$readiness_warning_dir"; then
  echo "target readiness failure unexpectedly succeeded" >&2
  cat "$tmp/readiness-failure-output" >&2
  exit 1
fi
rm -f "$data_dir/fail-wait-running"
assert_contains "$tmp/readiness-failure-output" \
  "Runner $runner_release failed readiness or health checks."

assert_contains "$release_workflow" "id: promote-runner"
assert_contains "$release_workflow" 'shell: bash'
assert_contains "$release_workflow" 'GITHUB_STEP_SUMMARY'
assert_contains "$release_workflow" \
  "steps.promote-runner.outputs.has_warnings != 'true'"
assert_contains "$release_workflow" \
  "steps.promote-runner.outputs.has_warnings == 'true'"

promotion_script="$(
  yq -r '.jobs.promote-runner-production.steps[] | select(.id == "promote-runner") | .run' \
    "$release_workflow"
)"
cat > "$fake_bin/ansible-playbook" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$PROMOTION_WORKFLOW_CASE" in
  empty)
    ;;
  warnings)
    cp "$PROMOTION_TEST_WARNING_SOURCE/"*.json "$RUNNER_TEMP/runner-promotion-warnings/"
    ;;
  missing-directory)
    rmdir "$RUNNER_TEMP/runner-promotion-warnings"
    ;;
  *)
    echo "unexpected workflow test case: $PROMOTION_WORKFLOW_CASE" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$fake_bin/ansible-playbook"

run_promotion_workflow() (
  local case_name=$1
  local work_dir="$tmp/workflow-$case_name"
  mkdir -p "$work_dir"
  cd "$repo_root"
  PATH="$fake_bin:$PATH" \
    RUNNER_TEMP="$work_dir" \
    GITHUB_OUTPUT="$work_dir/output" \
    GITHUB_STEP_SUMMARY="$work_dir/summary" \
    RUNNER_HOSTS=promotion-test \
    AWS_METAL_RUNNER_USER=runner-test \
    SENTRY_DSN_RUNNER='' \
    AXIOM_TOKEN_TELEMETRY='' \
    RUNNER_VERSION=999.0.0 \
    RUNNER_TARGET="$runner_target" \
    PROMOTION_WORKFLOW_CASE="$case_name" \
    PROMOTION_TEST_WARNING_SOURCE="$drain_warning_dir" \
    bash --noprofile --norc -e -o pipefail -c "$promotion_script" >"$work_dir/log" 2>&1
)

for workflow_case in empty warnings; do
  if ! run_promotion_workflow "$workflow_case"; then
    cat "$tmp/workflow-$workflow_case/log" >&2
    exit 1
  fi
done
assert_line_count "$tmp/workflow-empty/output" 1 'has_warnings=false'
assert_line_count "$tmp/workflow-warnings/output" 1 'has_warnings=true'
assert_contains "$tmp/workflow-warnings/summary" '## Runner promotion warnings'
assert_contains "$tmp/workflow-warnings/summary" \
  '"error": "drain acknowledgement timed out for v101.0.0"'
for host in runner-promotion-a runner-promotion-b; do
  assert_contains "$tmp/workflow-warnings/summary" "\"host\": \"$host\""
done

if run_promotion_workflow missing-directory; then
  echo "warning discovery failure unexpectedly succeeded" >&2
  cat "$tmp/workflow-missing-directory/log" >&2
  exit 1
fi
if [ -s "$tmp/workflow-missing-directory/output" ]; then
  echo "warning discovery failure must not publish a success output" >&2
  cat "$tmp/workflow-missing-directory/output" >&2
  exit 1
fi

echo "runner-promotion-ansible-test: ok"
