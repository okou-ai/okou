#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
script="$repo_root/ansible/files/vm0-monitoring-runner-collect.py"
playbook="$repo_root/ansible/playbooks/provision-monitoring.yml"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

runners_dir="$tmp_root/runners"
textfile_dir="$tmp_root/textfile"
output_file="$textfile_dir/runner-status.prom"
stderr_file="$tmp_root/stderr.log"

uuid_a="00000000-0000-4000-8000-000000000001"
uuid_b="00000000-0000-4000-8000-000000000002"
uuid_c="00000000-0000-4000-8000-000000000003"
uuid_d="00000000-0000-4000-8000-000000000004"
uuid_e="00000000-0000-4000-8000-000000000005"
uuid_f="00000000-0000-4000-8000-000000000006"
uuid_g="00000000-0000-4000-8000-000000000007"
uuid_h="00000000-0000-4000-8000-000000000008"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

reset_dirs() {
  rm -rf "$runners_dir" "$textfile_dir" "$stderr_file"
  mkdir -p "$textfile_dir"
}

run_with_path_env() {
  env \
    -u OKOU_RUNNERS_DIR \
    -u OKOU_MONITORING_TEXTFILE_DIR \
    "$@" \
    python3 -I -B "$script" status 2>"$stderr_file"
}

run_collector() {
  run_with_path_env \
    OKOU_RUNNERS_DIR="$runners_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"

  [ -f "$output_file" ] || fail "metrics output file was not created"
}

assert_line() {
  local expected="$1"
  grep -qxF "$expected" "$output_file" || fail "missing line: $expected"
}

assert_playbook_contains() {
  local expected="$1"
  grep -qF "$expected" "$playbook" || fail "playbook is missing: $expected"
}

assert_stderr_empty() {
  [ ! -s "$stderr_file" ] || fail "collector emitted unexpected diagnostics"
}

assert_output_absent() {
  [ ! -e "$output_file" ] || fail "collector published output unexpectedly"
}

assert_zero_snapshot() {
  local state
  local mode
  local result

  for state in active idle blank preparing unknown; do
    assert_line "vm0_runner_sandboxes{state=\"$state\"} 0"
  done
  for mode in starting running draining stopping unknown; do
    assert_line "vm0_runner_instances{mode=\"$mode\"} 0"
  done
  for result in included stopped invalid; do
    assert_line "vm0_runner_status_files{result=\"$result\"} 0"
  done
  assert_line "vm0_runner_status_collection_success 1"
}

test_missing_and_empty_runner_roots_emit_zero_metrics() {
  reset_dirs
  run_collector
  assert_zero_snapshot

  mkdir -p "$runners_dir"
  run_collector
  assert_zero_snapshot
}

test_aggregates_current_and_future_statuses() {
  reset_dirs
  mkdir -p \
    "$runners_dir/current" \
    "$runners_dir/draining" \
    "$runners_dir/future" \
    "$runners_dir/stopped"

  cat >"$runners_dir/current/status.json" <<EOF
{
  "mode": "running",
  "active_runs": [
    {"sandbox_id": "$uuid_a", "phase": "running"},
    {"sandbox_id": "$uuid_b", "phase": "preparing"},
    {"sandbox_id": "$uuid_b", "phase": "waiting"},
    {"sandbox_id": "$uuid_c", "phase": "waiting"},
    {"sandbox_id": "$uuid_e", "phase": "running"},
    {"sandbox_id": "$uuid_e", "phase": "preparing"}
  ],
  "idle_sandboxes": [
    {"sandbox_id": "$uuid_a", "reuse_key": "overlap"},
    {"sandbox_id": "$uuid_d", "reuse_key": "idle"}
  ]
}
EOF

  cat >"$runners_dir/draining/status.json" <<EOF
{
  "mode": "draining",
  "active_runs": [
    {"run_id": "draining-run", "sandbox_id": "$uuid_f"},
    {"run_id": "duplicate-idle", "sandbox_id": "$uuid_d"}
  ],
  "idle_sandboxes": [
    {"sandbox_id": "$uuid_g", "session_id": "session"}
  ]
}
EOF

  cat >"$runners_dir/future/status.json" <<EOF
{
  "mode": "paused",
  "active_runs": [
    {"sandbox_id": "$uuid_h", "phase": "running"}
  ]
}
EOF

  cat >"$runners_dir/stopped/status.json" <<'EOF'
{
  "mode": "stopped",
  "active_runs": "ignored because the runner is stopped"
}
EOF

  run_collector

  assert_line 'vm0_runner_sandboxes{state="active"} 3'
  assert_line 'vm0_runner_sandboxes{state="idle"} 3'
  assert_line 'vm0_runner_sandboxes{state="preparing"} 1'
  assert_line 'vm0_runner_sandboxes{state="unknown"} 1'
  assert_line 'vm0_runner_instances{mode="running"} 1'
  assert_line 'vm0_runner_instances{mode="draining"} 1'
  assert_line 'vm0_runner_instances{mode="unknown"} 1'
  assert_line 'vm0_runner_status_files{result="included"} 3'
  assert_line 'vm0_runner_status_files{result="stopped"} 1'
  assert_line 'vm0_runner_status_files{result="invalid"} 0'
  assert_line 'vm0_runner_status_collection_success 1'
  if grep -qE "sandbox_id|run_id|reuse_key|session_id|$uuid_a|draining-run" \
    "$output_file"; then
    fail "identity-level data leaked into metrics"
  fi
}

test_canonical_idle_field_behavior() {
  reset_dirs
  mkdir -p \
    "$runners_dir/canonical" \
    "$runners_dir/canonical-empty" \
    "$runners_dir/omitted"

  printf '%s\n' \
    "{\"mode\":\"running\",\"idle_sandboxes\":[{\"sandbox_id\":\"$uuid_a\"}]}" \
    >"$runners_dir/canonical/status.json"
  printf '%s\n' \
    "{\"mode\":\"running\",\"idle_sandboxes\":[]}" \
    >"$runners_dir/canonical-empty/status.json"
  printf '%s\n' '{"mode":"running"}' \
    >"$runners_dir/omitted/status.json"

  run_collector

  assert_line 'vm0_runner_sandboxes{state="active"} 0'
  assert_line 'vm0_runner_sandboxes{state="idle"} 1'
  assert_line 'vm0_runner_sandboxes{state="blank"} 0'
  assert_line 'vm0_runner_sandboxes{state="preparing"} 0'
  assert_line 'vm0_runner_sandboxes{state="unknown"} 0'
  assert_line 'vm0_runner_instances{mode="running"} 3'
  assert_line 'vm0_runner_status_files{result="included"} 3'
  assert_line 'vm0_runner_status_files{result="invalid"} 0'
  assert_line 'vm0_runner_status_collection_success 1'
}

test_explicit_blank_inventory_with_overlap() {
  local format
  local idle
  local blank
  for format in explicit overlap; do
    reset_dirs
    mkdir -p "$runners_dir/current"
    idle="{\"sandbox_id\":\"$uuid_a\",\"reuse_key\":\"thread:exact\"}"
    blank="\"blank_sandboxes\":[{\"sandbox_id\":\"$uuid_b\"}],"
    if [ "$format" = overlap ]; then
      idle+=",{\"sandbox_id\":\"$uuid_b\",\"reuse_key\":\"overlapping-mirror\"}"
    fi
    printf '%s\n' "{\"mode\":\"running\",$blank\"idle_sandboxes\":[$idle]}" \
      >"$runners_dir/current/status.json"

    run_collector

    assert_line 'vm0_runner_sandboxes{state="idle"} 1'
    assert_line 'vm0_runner_sandboxes{state="blank"} 1'
    assert_line 'vm0_runner_sandboxes{state="active"} 0'
    assert_line 'vm0_runner_sandboxes{state="preparing"} 0'
    assert_line 'vm0_runner_sandboxes{state="unknown"} 0'
    assert_line 'vm0_runner_status_files{result="included"} 1'
    assert_line 'vm0_runner_status_collection_success 1'
    assert_stderr_empty
    if grep -qE "sandbox_id|run_id|reuse_key|$uuid_a|$uuid_b" "$output_file"; then
      fail "blank inventory leaked identity-level data into metrics"
    fi
  done
}

test_mixed_blank_inventory_deduplicates_by_uuid_and_lifecycle() {
  reset_dirs
  mkdir -p "$runners_dir/draining" "$runners_dir/current" "$runners_dir/stopped"
  cat >"$runners_dir/draining/status.json" <<EOF
{
  "mode": "draining",
  "active_runs": [
    {"sandbox_id":"$uuid_b","phase":"running"},
    {"sandbox_id":"$uuid_d","phase":"preparing"},
    {"sandbox_id":"$uuid_e","phase":"future-phase"}
  ],
  "idle_sandboxes": [
    {"sandbox_id":"$uuid_c","reuse_key":"thread:exact"},
    {"sandbox_id":"$uuid_g","reuse_key":"thread:another-exact"},
    {"sandbox_id":"$uuid_h"}
  ],
  "blank_sandboxes": [{"sandbox_id":"$uuid_a"}]
}
EOF
  cat >"$runners_dir/current/status.json" <<EOF
{
  "mode": "running",
  "idle_sandboxes": [{"sandbox_id":"$uuid_f","reuse_key":"overlap"}],
  "blank_sandboxes": [
    {"sandbox_id":"$uuid_a"}, {"sandbox_id":"$uuid_b"},
    {"sandbox_id":"$uuid_c"}, {"sandbox_id":"$uuid_d"},
    {"sandbox_id":"$uuid_e"}, {"sandbox_id":"$uuid_f"},
    {"sandbox_id":"00000000000040008000000000000006"}
  ]
}
EOF
  printf '%s\n' '{"mode":"stopped","blank_sandboxes":null}' \
    >"$runners_dir/stopped/status.json"

  run_collector

  assert_line 'vm0_runner_sandboxes{state="idle"} 3'
  assert_line 'vm0_runner_sandboxes{state="blank"} 2'
  assert_line 'vm0_runner_sandboxes{state="active"} 1'
  assert_line 'vm0_runner_sandboxes{state="preparing"} 1'
  assert_line 'vm0_runner_sandboxes{state="unknown"} 1'
  assert_line 'vm0_runner_status_files{result="included"} 2'
  assert_line 'vm0_runner_status_files{result="stopped"} 1'
  assert_line 'vm0_runner_status_collection_success 1'
  assert_stderr_empty
}

test_malformed_blank_inventory_invalidates_only_its_status_file() {
  reset_dirs
  mkdir -p "$runners_dir/valid" "$runners_dir/invalid"
  printf '%s\n' "{\"mode\":\"running\",\"idle_sandboxes\":[{\"sandbox_id\":\"$uuid_a\"}]}" \
    >"$runners_dir/valid/status.json"
  local blank
  for blank in null '{}' '"invalid"' '[null]' '[{}]' \
    '[{"sandbox_id":1}]' '[{"sandbox_id":""}]' '[{"sandbox_id":"not-a-uuid"}]'; do
    printf '%s\n' "{\"mode\":\"running\",\"blank_sandboxes\":$blank}" \
      >"$runners_dir/invalid/status.json"

    run_collector

    assert_line 'vm0_runner_sandboxes{state="idle"} 1'
    assert_line 'vm0_runner_sandboxes{state="blank"} 0'
    assert_line 'vm0_runner_status_files{result="included"} 1'
    assert_line 'vm0_runner_status_files{result="invalid"} 1'
    assert_line 'vm0_runner_status_collection_success 0'
    grep -q 'invalid/status.json' "$stderr_file" || fail "malformed blank was not reported"
  done
}

test_invalid_files_publish_partial_metrics() {
  reset_dirs
  mkdir -p \
    "$runners_dir/valid" \
    "$runners_dir/malformed-json" \
    "$runners_dir/malformed-shape" \
    "$runners_dir/malformed-canonical" \
    "$runners_dir/invalid-id"

  cat >"$runners_dir/valid/status.json" <<EOF
{"mode":"starting","active_runs":[{"sandbox_id":"$uuid_a","phase":"preparing"}]}
EOF
  printf '{' >"$runners_dir/malformed-json/status.json"
  printf '%s\n' '{"mode":"running","active_runs":{}}' \
    >"$runners_dir/malformed-shape/status.json"
  printf '%s\n' \
    "{\"mode\":\"running\",\"idle_sandboxes\":null}" \
    >"$runners_dir/malformed-canonical/status.json"
  printf '%s\n' \
    '{"mode":"running","idle_sandboxes":[{"sandbox_id":"not-a-uuid"}]}' \
    >"$runners_dir/invalid-id/status.json"

  run_collector

  assert_line 'vm0_runner_sandboxes{state="preparing"} 1'
  assert_line 'vm0_runner_instances{mode="starting"} 1'
  assert_line 'vm0_runner_status_files{result="included"} 1'
  assert_line 'vm0_runner_status_files{result="invalid"} 4'
  assert_line 'vm0_runner_status_collection_success 0'
  grep -q 'malformed-json/status.json' "$stderr_file" ||
    fail "malformed JSON diagnostic was not reported"
  grep -q 'malformed-shape/status.json' "$stderr_file" ||
    fail "malformed shape diagnostic was not reported"
  grep -q 'malformed-canonical/status.json' "$stderr_file" ||
    fail "malformed canonical diagnostic was not reported"
  grep -q 'invalid-id/status.json' "$stderr_file" ||
    fail "invalid UUID diagnostic was not reported"
}

test_rejects_runner_and_status_symlinks() {
  reset_dirs
  mkdir -p "$runners_dir" "$tmp_root/outside-runner" "$runners_dir/status-link"
  printf '%s\n' '{"mode":"running"}' >"$tmp_root/outside-runner/status.json"
  ln -s "$tmp_root/outside-runner" "$runners_dir/runner-link"
  ln -s "$tmp_root/outside-runner/status.json" \
    "$runners_dir/status-link/status.json"

  run_collector

  assert_line 'vm0_runner_status_files{result="included"} 0'
  assert_line 'vm0_runner_status_files{result="invalid"} 2'
  assert_line 'vm0_runner_status_collection_success 0'
  grep -q 'runner directory symlink' "$stderr_file" ||
    fail "runner symlink diagnostic was not reported"
  grep -q 'status file symlink' "$stderr_file" ||
    fail "status symlink diagnostic was not reported"
}

test_output_is_deterministic_and_replaced_atomically() {
  reset_dirs
  mkdir -p "$runners_dir/current"
  printf '%s\n' \
    "{\"mode\":\"running\",\"idle_sandboxes\":[{\"sandbox_id\":\"$uuid_a\"}]}" \
    >"$runners_dir/current/status.json"
  printf '%s\n' 'stale output' >"$output_file"

  run_collector
  cp "$output_file" "$tmp_root/first-output.prom"
  run_collector

  cmp -s "$tmp_root/first-output.prom" "$output_file" ||
    fail "collector output changed between identical runs"
  [ "$(stat -c '%a' "$output_file")" = "644" ] ||
    fail "metrics output permissions are not 0644"
  if find "$textfile_dir" -maxdepth 1 -name '.runner-status.prom.*' | grep -q .; then
    fail "temporary metric files were not cleaned up"
  fi
  assert_line 'vm0_runner_sandboxes{state="idle"} 1'
}

test_runners_dir_canonical_and_defaults() {
  reset_dirs
  mkdir -p "$runners_dir/canonical-runner"
  printf '%s\n' '{"mode":"running"}' \
    >"$runners_dir/canonical-runner/status.json"

  run_with_path_env \
    OKOU_RUNNERS_DIR="$runners_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"
  assert_line 'vm0_runner_instances{mode="running"} 1'
  assert_line 'vm0_runner_status_files{result="included"} 1'
  assert_stderr_empty

  run_with_path_env \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"
  assert_zero_snapshot
  assert_stderr_empty

  run_with_path_env \
    OKOU_RUNNERS_DIR="" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"
  assert_zero_snapshot
  assert_stderr_empty
}

test_monitoring_textfile_dir_canonical_and_defaults() {
  reset_dirs
  mkdir -p "$runners_dir/canonical-runner"
  printf '%s\n' '{"mode":"running"}' \
    >"$runners_dir/canonical-runner/status.json"

  run_with_path_env \
    OKOU_RUNNERS_DIR="$runners_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"
  assert_line 'vm0_runner_instances{mode="running"} 1'
  assert_stderr_empty

  rm -f "$output_file"
  if run_with_path_env OKOU_RUNNERS_DIR="$runners_dir"; then
    fail "expected the absent canonical textfile path to use the missing default"
  fi
  grep -qF \
    'missing textfile directory: /var/lib/vm0-monitoring/textfile-collector' \
    "$stderr_file" || fail "absent canonical textfile path did not use the fixed default"
  assert_output_absent

  if run_with_path_env \
    OKOU_RUNNERS_DIR="$runners_dir" \
    OKOU_MONITORING_TEXTFILE_DIR=""; then
    fail "expected an empty canonical textfile path to use the missing default"
  fi
  grep -qF \
    'missing textfile directory: /var/lib/vm0-monitoring/textfile-collector' \
    "$stderr_file" || fail "empty canonical textfile path did not use the fixed default"
  assert_output_absent
}

test_missing_textfile_dir_fails() {
  rm -rf "$runners_dir" "$textfile_dir"

  if run_with_path_env \
    OKOU_RUNNERS_DIR="$runners_dir" \
    OKOU_MONITORING_TEXTFILE_DIR="$textfile_dir"; then
    fail "expected missing textfile directory to fail"
  fi

  grep -q 'missing textfile directory' "$stderr_file" ||
    fail "missing textfile directory error was not reported"
}

test_playbook_provisions_collector_identity_and_cadence() {
  assert_playbook_contains 'src: ../files/vm0-monitoring-runner-collect.py'
  assert_playbook_contains 'dest: /usr/local/bin/vm0-monitoring-runner-collect'
  assert_playbook_contains 'ExecStart=/usr/bin/python3 -I -B /usr/local/bin/vm0-monitoring-runner-collect status'
  assert_playbook_contains 'dest: /etc/systemd/system/vm0-monitoring-runner-status-collect.service'
  assert_playbook_contains 'dest: /etc/systemd/system/vm0-monitoring-runner-status-collect.timer'
  assert_playbook_contains 'name: vm0-monitoring-runner-status-collect.timer'
  assert_playbook_contains 'OnUnitActiveSec=15s'
  assert_playbook_contains 'AccuracySec=1s'
}

test_missing_and_empty_runner_roots_emit_zero_metrics
test_aggregates_current_and_future_statuses
test_canonical_idle_field_behavior
test_explicit_blank_inventory_with_overlap
test_mixed_blank_inventory_deduplicates_by_uuid_and_lifecycle
test_malformed_blank_inventory_invalidates_only_its_status_file
test_invalid_files_publish_partial_metrics
test_rejects_runner_and_status_symlinks
test_output_is_deterministic_and_replaced_atomically
test_runners_dir_canonical_and_defaults
test_monitoring_textfile_dir_canonical_and_defaults
test_missing_textfile_dir_fails
test_playbook_provisions_collector_identity_and_cadence

echo "vm0 monitoring runner status collector tests passed"
