#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
driver=${1:-"$repo_root/crates/runner/tests/behavior/runner-behavior-keep-alive.sh"}
fixture_root=$(mktemp -d)
trap 'rm -rf "$fixture_root"' EXIT
mkdir -p "$fixture_root/bin"

# Run the actual driver's preflight SSH program. Only external host commands
# are controlled; their destructive paths map to independent fixture resources.
cat > "$fixture_root/bin/ssh" <<'SSH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 8 ] && [ "$2" = bash ] && [ "$3" = -s ]; then
  shift
  exec "$@"
fi
if [ "$#" -eq 2 ]; then
  case "$2" in
    *"runner config"*)
      touch "$PREFLIGHT_CASE_DIR/config"
      exit 0
      ;;
    *"worker.XXXXXX"*)
      cat >/dev/null
      touch "$PREFLIGHT_CASE_DIR/staging"
      # The existing durable regression owns launch/status behavior. Stop this
      # fixture at its external staging boundary, before any native execution.
      exit 78
      ;;
  esac
fi
echo "unexpected SSH boundary" >&2
exit 2
SSH

cat > "$fixture_root/bin/sudo" <<'PYTHON'
#!/usr/bin/env python3
import os
import pathlib
import shutil
import sys

root = pathlib.Path(os.environ["PREFLIGHT_CASE_DIR"])
scenario = root.name
args = sys.argv[1:]
unit = "vm0-runner-preflight-keepalive.service"

if args[0].endswith("/runner") and args[1:3] == ["service", "stop"]:
    sys.exit(23 if scenario in ("stop-and-query-fail", "stop-fail-inactive") else 0)
elif args[0] == "systemctl" and unit in args:
    if scenario == "stop-and-query-fail":
        print("controlled system bus failure", file=sys.stderr)
        sys.exit(1)
    if scenario == "failed-query-inactive":
        print("inactive")
        sys.exit(1)
    state = {
        "active": "active",
        "deactivating": "deactivating",
        "unknown": "unknown",
        "empty": "",
        "failed": "failed",
    }.get(scenario, "inactive")
    if args[1] == "show":
        print(state)
    elif args[1] == "is-active":
        sys.exit(0 if state == "active" else 3)
    else:
        raise RuntimeError(f"unexpected systemctl query: {args}")
elif args[0] == "rm":
    paths = {
        "/var/lib/vm0-runner/groups/vm0/keepalive-preflight": root / "group",
        "/var/lib/vm0-runner/runners/preflight-keepalive": root / "runner",
    }
    requested = [arg for arg in args[1:] if arg not in ("-rf", "--")]
    if len(requested) != 2 or set(requested) != set(paths):
        raise RuntimeError("refused removal outside owned fixture paths")
    for path in requested:
        shutil.rmtree(paths[path])
else:
    raise RuntimeError(f"unexpected host command: {args}")
PYTHON

# Host waits stay at the real command boundary without delaying local fixtures.
cat > "$fixture_root/bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
exit 0
SLEEP
chmod +x "$fixture_root/bin/"*

run_case() {
  local scenario=$1 expectation=$2 case_dir status=0
  case_dir="$fixture_root/$scenario"
  mkdir -p "$case_dir/group" "$case_dir/runner"
  printf 'group state\n' > "$case_dir/group/marker"
  printf 'runner state\n' > "$case_dir/runner/marker"

  PATH="$fixture_root/bin:$PATH" PREFLIGHT_CASE_DIR="$case_dir" \
    METAL_USER=fixture HOST=fixture.invalid BIN_DIR=/fixture/bin JOB_REF=preflight \
    DEFAULT_ROOTFS_HASH=fixture-rootfs DEFAULT_SNAPSHOT_HASH=fixture-snapshot \
    OFFICIAL_RUNNER_SECRET=fixture-token GITHUB_RUN_ID=$$ GITHUB_RUN_ATTEMPT=1 \
    timeout 10 bash "$driver" > "$case_dir/output" 2>&1 || status=$?

  if [ "$expectation" = retained ]; then
    if [ "$status" -eq 0 ] || [ "$status" -eq 124 ] \
      || [ ! -f "$case_dir/group/marker" ] || [ ! -f "$case_dir/runner/marker" ] \
      || [ -e "$case_dir/config" ] || [ -e "$case_dir/staging" ]; then
      echo "FAIL: $scenario must fail while preserving state and blocking preparation" >&2
      cat "$case_dir/output" >&2
      exit 1
    fi
  elif [ "$status" -ne 78 ] || [ -e "$case_dir/group" ] || [ -e "$case_dir/runner" ] \
    || [ ! -f "$case_dir/config" ] || [ ! -f "$case_dir/staging" ]; then
    echo "FAIL: $scenario must clean confirmed stopped state and reach durable staging" >&2
    cat "$case_dir/output" >&2
    exit 1
  fi
  echo "PASS: $scenario ($expectation)"
}

run_case stop-and-query-fail retained
run_case failed-query-inactive retained
run_case active retained
run_case deactivating retained
run_case unknown retained
run_case empty retained
# systemctl show also reports inactive successfully for never-created or
# collected transient units, so initial runs use this same terminal response.
run_case inactive prepared
run_case failed prepared
run_case stop-fail-inactive prepared
