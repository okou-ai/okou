#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKER="$REPO_ROOT/.github/scripts/runner-behavior-guest-rpc.sh"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"

cat >"$TEST_ROOT/bin/scp" <<'SCP'
#!/usr/bin/env bash
set -euo pipefail
cp -- "$1" "$RPC_CASE/remote-bin"
SCP
cat >"$TEST_ROOT/bin/ssh" <<'SSH'
#!/usr/bin/env bash
set -euo pipefail
shift
if [ "$1" = sudo ] && [ "$2" = rm ]; then
  rm -f -- "$RPC_CASE/remote-bin"
  exit 0
fi
[ "$1" = sudo ] && [ "$2" = bash ] && [ "$3" = -s ] && [ "$4" = -- ]
shift 4
shift # uploaded binary path
source_text=$(cat)
source_text=${source_text//\/var\/lib\/vm0-runner/"$RPC_CASE/fixtures"}
bash -s -- "$RPC_CASE/remote-bin" "$@" <<<"$source_text"
SSH
cat >"$TEST_ROOT/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$RPC_CASE/cleanup"
SYSTEMCTL
cat >"$TEST_ROOT/bin/systemd-run" <<'SYSTEMD_RUN'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$RPC_CASE/launch"
case " $* " in
  *" --property=RuntimeMaxSec=180 "*) ;;
  *) exit 90 ;;
esac
case " $* " in
  *" --ignored --exact packaged_helper_completes_over_fresh_restored_and_reused_firecracker --nocapture --test-threads=1 ") ;;
  *) exit 91 ;;
esac
rootfs_seen=false
snapshot_seen=false
for argument in "$@"; do
  case "$argument" in
    --setenv=OKOU_TEST_RPC_ROOTFS=*) test -s "${argument#*=*=}"; rootfs_seen=true ;;
    --setenv=OKOU_TEST_RPC_SNAPSHOT_DIR=*) test -s "${argument#*=*=}/snapshot.bin"; snapshot_seen=true ;;
  esac
done
test "$rootfs_seen" = true && test "$snapshot_seen" = true
# Both image locks must remain held throughout native execution.
for lock in "$RPC_CASE/fixtures/locks/"*; do
  if flock --exclusive --nonblock "$lock" true; then exit 92; fi
done
exit "$RPC_NATIVE_STATUS"
SYSTEMD_RUN
cat >"$TEST_ROOT/native-test" <<'TEST_BIN'
#!/usr/bin/env bash
set -euo pipefail
test "$*" = '--ignored --list'
echo 'packaged_helper_completes_over_fresh_restored_and_reused_firecracker: test'
TEST_BIN
chmod +x "$TEST_ROOT/bin/"* "$TEST_ROOT/native-test"
ROOTFS_HASH=$(printf 'a%.0s' {1..64})
SNAPSHOT_HASH=$(printf 'b%.0s' {1..64})
FC_VERSION=$(sed -n 's/^pub const FIRECRACKER_VERSION: &str = "\([^"]*\)";$/\1/p' "$REPO_ROOT/crates/runner/src/deps.rs")
KERNEL_VERSION=$(sed -n 's/^pub const KERNEL_VERSION: &str = "\([^"]*\)";$/\1/p' "$REPO_ROOT/crates/runner/src/deps.rs")

for native_status in 0 42; do
  case_dir="$TEST_ROOT/case-$native_status"
  fixture_dir="$case_dir/fixtures"
  snapshot_dir="$fixture_dir/images/$ROOTFS_HASH/snapshots/$SNAPSHOT_HASH"
  mkdir -p "$fixture_dir/firecracker/$FC_VERSION" "$fixture_dir/locks" "$snapshot_dir"
  for fixture in "$fixture_dir/firecracker/$FC_VERSION/firecracker" \
    "$fixture_dir/firecracker/$FC_VERSION/vmlinux-$KERNEL_VERSION" \
    "$fixture_dir/images/$ROOTFS_HASH/rootfs.ext4" \
    "$snapshot_dir/snapshot.bin" "$snapshot_dir/memory.bin" "$snapshot_dir/cow.img"; do
    printf 'immutable fixture\n' >"$fixture"
  done
  status=0
  env PATH="$TEST_ROOT/bin:$PATH" RPC_CASE="$case_dir" RPC_NATIVE_STATUS="$native_status" \
    METAL_USER=test HOST=test JOB_REF=pr-123 DEFAULT_ROOTFS_HASH="$ROOTFS_HASH" \
    DEFAULT_SNAPSHOT_HASH="$SNAPSHOT_HASH" TEST_BIN="$TEST_ROOT/native-test" \
    GITHUB_RUN_ID=17 GITHUB_RUN_ATTEMPT=2 bash "$WORKER" || status=$?
  test "$status" -eq "$native_status"
  test -s "$case_dir/launch" && test -s "$case_dir/cleanup"
  test ! -e "$case_dir/remote-bin"
  test ! -e "$fixture_dir/guest-rpc-tests/pr-123-17-2"
  test "$(cat "$fixture_dir/images/$ROOTFS_HASH/rootfs.ext4")" = 'immutable fixture'
  for lock in "$fixture_dir/locks/"*; do
    flock --exclusive --nonblock "$lock" true
  done
done

if env PATH="$TEST_ROOT/bin:$PATH" METAL_USER=test HOST=test JOB_REF=../escape \
  DEFAULT_ROOTFS_HASH="$ROOTFS_HASH" DEFAULT_SNAPSHOT_HASH="$SNAPSHOT_HASH" \
  TEST_BIN="$TEST_ROOT/native-test" GITHUB_RUN_ID=17 GITHUB_RUN_ATTEMPT=2 \
  bash "$WORKER"; then
  echo 'unsafe artifact identity accepted' >&2
  exit 1
fi

ruby -ryaml - "$REPO_ROOT/.github/workflows/crates.yml" <<'RUBY'
jobs = YAML.load_file(ARGV.fetch(0)).fetch('jobs')
native = jobs.fetch('guest-rpc-firecracker-test')
raise 'native test must follow its selected image and compiled binary' unless native.fetch('needs') == ['runner-build', 'guest-rpc-firecracker-build']
raise 'container steps require Bash' unless native.dig('defaults', 'run', 'shell') == 'bash'
validation = native.fetch('steps').index { |step| step['run'] == 'bash .github/scripts/runner-native-test-artifact.sh validate' }
ssh_setup = native.fetch('steps').index { |step| step['uses'] == './.github/actions/setup-ssh-tunnel' }
raise 'native artifact must be validated before contacting metal' unless validation && ssh_setup && validation < ssh_setup
%w[rootfs snapshot].each do |kind|
  expected = "${{ needs.runner-build.outputs.default-#{kind}-hash }}"
  raise "wrong #{kind} source" unless native.fetch('env').fetch("DEFAULT_#{kind.upcase}_HASH") == expected
end
gate = jobs.fetch('ci-gate-crates')
raise 'missing native gate dependency' unless gate.fetch('needs').include?('guest-rpc-firecracker-test')
raise 'native failure must block' unless gate.fetch('steps').any? { |step| step.fetch('run', '').include?('check_result "guest-rpc-firecracker-test"') }
RUBY
echo 'PASS: native RPC selection, image locks, failure propagation and cleanup'
