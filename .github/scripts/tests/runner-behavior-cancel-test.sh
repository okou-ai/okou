#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cancel_script=${1:-"$repo_root/.github/scripts/runner-behavior-cancel-remote.sh"}
fixture_root=$(mktemp -d)
declare -a worker_pids=()
declare -a held_fds=()

cleanup() {
  local pid
  for pid in "${worker_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$fixture_root"
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

wait_for_file() {
  local path=$1 deadline=$((SECONDS + 10))
  until [ -e "$path" ]; do
    [ "$SECONDS" -lt "$deadline" ] || fail "timed out waiting for $path"
    sleep 0.01
  done
}

mkdir -p "$fixture_root/bin" "$fixture_root/locks" "$fixture_root/tmp"
for index in $(seq 0 63); do
  touch "$fixture_root/locks/vm0-netns-pool-${index}.lock"
done

cat >"$fixture_root/bin/sudo" <<'SUDO'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = bash ]; then
  printf '%s\n' "$4" >"$MOCK_CASE_DIR/lock-info-path"
fi
exec "$@"
SUDO

cat >"$fixture_root/bin/runner" <<'RUNNER'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'service start')
    # Hold the external service-start boundary while the test drives the real
    # helper's release protocol, then exercise the worker's failure cleanup.
    touch "$MOCK_CASE_DIR/entered"
    IFS= read -r -t 10 outcome <"$MOCK_CASE_DIR/release"
    [ "$outcome" = fail ]
    exit 42
    ;;
  'service stop' | 'service logs') exit 0 ;;
  *) echo "unexpected runner command: $*" >&2; exit 2 ;;
esac
RUNNER

cat >"$fixture_root/bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
set -euo pipefail
if [ "${MOCK_PARTIAL:-false}" = true ] && [ "$1" = 1 ]; then
  # The capacity retry is an explicit boundary after partial claims close.
  touch "$MOCK_CASE_DIR/retrying"
  IFS= read -r -t 10 outcome <"$MOCK_CASE_DIR/release"
  [ "$outcome" = continue ]
else
  exec /bin/sleep "$@"
fi
SLEEP

for command in ip iptables iptables-save iptables-restore ip6tables-save ip6tables-restore; do
  ln -s /bin/true "$fixture_root/bin/$command"
done
chmod +x "$fixture_root/bin/sudo" "$fixture_root/bin/runner" "$fixture_root/bin/sleep"

# Execute the complete worker, mapping only its external host filesystem into
# this fixture. Keep the embedded helper and all flock operations real.
worker_source=$(<"$cancel_script")
worker_source=${worker_source//\/var\/lock/"$fixture_root/locks"}
worker_source=${worker_source//\/var\/lib\/vm0-runner/"$fixture_root/home"}
worker_source=${worker_source//\/tmp\/vm0-/"$fixture_root/tmp/vm0-"}

start_worker() {
  local name=$1 partial=${2:-false}
  mkdir -p "$fixture_root/$name"
  mkfifo "$fixture_root/$name/release"
  local release_fd
  exec {release_fd}<>"$fixture_root/$name/release"
  held_fds+=("$release_fd")
  env PATH="$fixture_root/bin:$PATH" MOCK_CASE_DIR="$fixture_root/$name" \
    MOCK_PARTIAL="$partial" \
    timeout 20 bash -c "$worker_source" -- "$fixture_root/bin" "$name" \
    >"$fixture_root/$name/output" 2>&1 &
  worker_pids+=("$!")
}

fixture_dir() {
  local info_path
  info_path=$(<"$fixture_root/$1/lock-info-path")
  printf '%s\n' "${info_path%/*}"
}

finish_failed_worker() {
  local name=$1 pid=$2 status=0
  printf 'fail\n' >"$fixture_root/$name/release"
  wait "$pid" || status=$?
  [ "$status" -eq 42 ] || {
    cat "$fixture_root/$name/output"
    fail "$name did not preserve service-start failure: $status"
  }
}

assert_claims_available() {
  local index
  for index in "$@"; do
    flock -n "$fixture_root/locks/vm0-ci-cancel-pool-${index}.lock" true \
      || fail "CI reservation leaked for pool $index"
    flock -n "$fixture_root/locks/vm0-netns-pool-${index}.lock" true \
      || fail "kernel pool lock leaked for pool $index"
  done
}

start_worker first
wait_for_file "$fixture_root/first/entered"
first_dir=$(fixture_dir first)
mapfile -t first_indexes <"$first_dir/pool-indexes"
touch "$first_dir/release-capacity" "$first_dir/release-idle"
wait_for_file "$first_dir/idle-released"
for index in "${first_indexes[@]:0:3}"; do
  flock -n "$fixture_root/locks/vm0-netns-pool-${index}.lock" true \
    || fail "fixture did not release idle pool $index for real reconciliation"
done
if flock -n "$fixture_root/locks/vm0-netns-pool-${first_indexes[3]}.lock" true; then
  fail "active fixture pool was released prematurely"
fi

start_worker second
wait_for_file "$fixture_root/second/entered"
second_dir=$(fixture_dir second)
mapfile -t second_indexes <"$second_dir/pool-indexes"
for first_index in "${first_indexes[@]}"; do
  for second_index in "${second_indexes[@]}"; do
    [ "$first_index" -ne "$second_index" ] \
      || fail "concurrent fixture stole pool $first_index during the idle handoff"
  done
done
echo "PASS: concurrent fixtures keep disjoint claims across kernel-lock release"

finish_failed_worker first "${worker_pids[0]}"
finish_failed_worker second "${worker_pids[1]}"
worker_pids=()
assert_claims_available $(seq 0 63)
echo "PASS: failed service startup releases fixture and kernel claims"

# Leave only four free indexes: the five-index attempt must release every
# partial claim before waiting, including claims for busy kernel indexes.
for index in $(seq 0 59); do
  exec {pool_fd}>>"$fixture_root/locks/vm0-netns-pool-${index}.lock"
  flock -n "$pool_fd"
  held_fds+=("$pool_fd")
done
start_worker partial true
wait_for_file "$fixture_root/partial/retrying"
for index in $(seq 0 63); do
  flock -n "$fixture_root/locks/vm0-ci-cancel-pool-${index}.lock" true \
    || fail "partial attempt retained CI claim for pool $index"
done
assert_claims_available 60 61 62 63
partial_dir=$(fixture_dir partial)
touch "$partial_dir/release-capacity"
printf 'continue\n' >"$fixture_root/partial/release"
partial_status=0
wait "${worker_pids[0]}" || partial_status=$?
worker_pids=()
[ "$partial_status" -eq 1 ] || fail "partial helper exit was not reported: $partial_status"
grep -F 'namespace pool reservation helper completed with status 0' \
  "$fixture_root/partial/output" >/dev/null \
  || fail "partial helper exit was not diagnosed"
for fd in "${held_fds[@]}"; do
  exec {fd}>&-
done
assert_claims_available $(seq 0 63)
echo "PASS: partial reservation and early helper exit release every claim"
