#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
worker=${1:-"$repo_root/.github/scripts/runner-behavior-balloon-remote.sh"}
fixture_root=$(mktemp -d)
cleanup() {
  local pid_file pid
  # A worker-cleanup regression must fail the assertion without leaving its
  # controlled peers running after this test exits.
  for pid_file in "$fixture_root"/*/allocator-pid "$fixture_root"/*/submit-pid-*; do
    [ -f "$pid_file" ] || continue
    pid=$(<"$pid_file")
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$fixture_root"
}
trap cleanup EXIT
mkdir -p "$fixture_root/bin"

# Exercise the complete worker with controlled external Runner/Firecracker
# responses. Native CI still owns the real allocation and host-backing proof.
cat >"$fixture_root/bin/sudo" <<'PYTHON'
#!/usr/bin/env python3
import json
import os
import pathlib
import sys
import time

root = pathlib.Path(os.environ["BALLOON_CASE_DIR"])
scenario = os.environ["BALLOON_SCENARIO"]
args = sys.argv[1:]


def increment(name):
    path = root / name
    value = int(path.read_text()) + 1 if path.exists() else 1
    path.write_text(str(value))
    return value


def phase():
    turn = int((root / "turn").read_text())
    if (root / f"finish-{turn}").exists():
        return "parked"
    if turn == 2:
        return "reuse"
    if (root / "released").exists():
        return "released"
    if (root / "allocated").exists():
        return "held"
    return "initial"


def status(idle):
    entry = {"sandbox_id": "sandbox", "phase": "running"}
    path = root / "runner/runners/test-balloon/status.json"
    path.write_text(json.dumps({
        "active_runs": [] if idle else [entry],
        "idle_sandboxes": [entry] if idle else [],
    }))


if args[0].endswith("/runner"):
    if args[1:3] == ["service", "stop"]:
        increment("stops")
    elif args[1:3] == ["service", "start"]:
        pass
    elif args[1:3] == ["local", "submit"]:
        turn = increment("turn")
        (root / f"submit-pid-{turn}").write_text(str(os.getpid()))
        status(False)
        while not (root / f"finish-{turn}").exists():
            time.sleep(0.01)
        status(True)
    elif args[1] == "exec":
        command = args[args.index("--") + 1:]
        if command[0] == "python3":
            (root / "allocator-pid").write_text(str(os.getpid()))
            (root / "allocated").touch()
            if scenario == "allocator-early-exit":
                sys.exit(42)
            if scenario != "allocator-not-ready":
                (root / "ready").touch()
            while not (root / "released").exists():
                time.sleep(0.01)
            if scenario == "allocator-failure":
                sys.exit(42)
        elif command[:2] == ["test", "-f"]:
            sys.exit(0 if (root / "ready").exists() else 1)
        elif command == ["touch", "/tmp/balloon-alloc-release"]:
            (root / "released").touch()
        elif command == ["touch", "/tmp/balloon-test-finish"]:
            turn = int((root / "turn").read_text())
            (root / f"finish-{turn}").touch()
        else:
            raise RuntimeError(f"unexpected Guest command: {command}")
    else:
        raise RuntimeError(f"unexpected Runner command: {args}")
elif args[0] == "ps":
    print(f"999 firecracker --api-sock {root}/sock/sandbox/api.sock")
elif args[0] == "curl":
    current = phase()
    if args[-1].endswith("/balloon/statistics"):
        sample = increment(f"samples-{current}")
        target = actual = 0
        if scenario == f"{current}-statistics-failure":
            sys.exit(42)
        if current in ("initial", "reuse"):
            if scenario == f"{current}-late-convergence" and sample == 2:
                actual = 8
            if scenario == f"{current}-nonconvergence" and sample >= 2:
                actual = 8
            if scenario == f"{current}-target" and sample == 2:
                target = 1
        if scenario == f"{current}-target":
            if current not in ("initial", "reuse"):
                target = 1
        if scenario == f"{current}-actual":
            actual = 1
        if scenario == "held-after-rss" and current == "held":
            if (root / "baseline-read").exists():
                actual = 1
        print(json.dumps({"target_pages": target, "actual_pages": actual}))
    elif args[-1].endswith("/balloon"):
        print('{"free_page_reporting":true,"deflate_on_oom":true}')
    elif args[-1] == "http://localhost/":
        print('{"state":"Paused"}')
    else:
        raise RuntimeError(f"unexpected API request: {args}")
elif args[0] == "awk":
    current = phase()
    if current == "held":
        (root / "baseline-read").touch()
        print(640 * 1024)
    elif current == "released":
        sample = increment("rss-released")
        if scenario == "reporting-no-return" or sample == 1:
            print(640 * 1024)
        else:
            print(300 * 1024)
    elif current == "parked":
        print(300 * 1024)
    else:
        raise RuntimeError(f"unexpected RSS phase: {current}")
elif args[0] == "jq":
    os.execvp("jq", args)
else:
    raise RuntimeError(f"unexpected sudo command: {args}")
PYTHON
chmod +x "$fixture_root/bin/sudo"

# Advance the worker's polling clock instead of waiting through observation
# windows. Mock process peers use real bounded synchronization independently.
cat >"$fixture_root/clock.bash" <<'BASH'
sleep() {
  SECONDS=$((SECONDS + $1))
  /bin/sleep 0.01
}
BASH

run_case() {
  local scenario=$1 expected_status=$2 expected_message=$3
  local case_dir="$fixture_root/$scenario" status=0 source
  mkdir -p "$case_dir/runner/runners/test-balloon" "$case_dir/sock/sandbox"
  BALLOON_CASE_DIR="$case_dir" python3 - <<'PYTHON'
import os
import pathlib
import socket

root = pathlib.Path(os.environ["BALLOON_CASE_DIR"])
(root / "runner/runners/test-balloon/status.json").write_text(
    '{"active_runs":[],"idle_sandboxes":[]}'
)
sock = socket.socket(socket.AF_UNIX)
sock.bind(str(root / "sock/sandbox/control.sock"))
sock.close()
PYTHON
  source=$(<"$worker")
  source=${source//\/var\/lib\/vm0-runner/"$case_dir/runner"}
  source=${source//\/run\/vm0\/sock/"$case_dir/sock"}
  env PATH="$fixture_root/bin:$PATH" BASH_ENV="$fixture_root/clock.bash" \
    BALLOON_CASE_DIR="$case_dir" BALLOON_SCENARIO="$scenario" \
    timeout 15 bash -c "$source" -- "$fixture_root/bin" test \
    >"$case_dir/output" 2>&1 || status=$?
  if [ "$status" -ne "$expected_status" ] \
    || ! grep -Fq "$expected_message" "$case_dir/output"; then
    cat "$case_dir/output" >&2
    echo "FAIL: $scenario expected status $expected_status ($expected_message), got $status" >&2
    exit 1
  fi
  # The worker must stop its service and physically join both owned peers on
  # success or failure, including allocator/readiness/reporting failures.
  BALLOON_CASE_DIR="$case_dir" python3 - <<'PYTHON'
import os
import pathlib

root = pathlib.Path(os.environ["BALLOON_CASE_DIR"])
assert int((root / "stops").read_text()) >= 2, "service was not stopped"
for path in root.glob("*-pid*"):
    try:
        os.kill(int(path.read_text()), 0)
    except ProcessLookupError:
        continue
    raise AssertionError(f"owned process survived worker exit: {path.name}")
PYTHON
  echo "PASS: $scenario"
}

run_case success 0 '=== Balloon test passed ==='
for boundary in initial reuse; do
  run_case "$boundary-late-convergence" 0 '=== Balloon test passed ==='
  run_case "$boundary-nonconvergence" 1 'active balloon pages did not converge'
  run_case "$boundary-target" 1 'active balloon target changed'
done
for phase in held released; do
  message='active capacity changed'
  if [ "$phase" = released ]; then
    message='runtime reclamation used inflation'
  fi
  run_case "$phase-target" 1 "$message"
  run_case "$phase-actual" 1 "$message"
  run_case "$phase-statistics-failure" 1 'balloon statistics unavailable'
done
run_case held-after-rss 1 'active capacity changed'
run_case allocator-early-exit 1 'allocator exited before readiness'
run_case allocator-not-ready 1 'allocator did not become ready'
run_case allocator-failure 1 'bounded allocation failed'
run_case reporting-no-return 1 'free-page reporting did not return backing'

echo 'runner-behavior-balloon-test: ok'
