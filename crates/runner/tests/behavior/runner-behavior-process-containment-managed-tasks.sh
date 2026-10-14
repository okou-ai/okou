#!/usr/bin/env bash
set -euo pipefail

BIN_DIR=$1
GROUP=$2
CHAT_THREAD_ID=$(cat /proc/sys/kernel/random/uuid)

fail() { echo "FAIL: $1" >&2; exit 1; }

# All native task/consumer resources live within this single guest operation.
TASK_PROMPT=$(cat <<'PROMPT'
set -eu
marker=/tmp/vm0-process-containment
rm -rf "$marker"
mkdir -p "$marker"
relative=$(awk -F: '$1 == "0" { print $3 }' /proc/self/cgroup)
case "$relative" in
  /vm0-exec/exec-*/workload/tools/tool-*) ;;
  *) echo "managed-task scenario is outside a Bash tool cgroup: $relative" >&2; exit 1 ;;
esac
tools=${relative%/*}
workload=${tools%/tools}
operation=${workload%/workload}
parent="/sys/fs/cgroup$operation"

# The packaged native helper and actual broker are the task boundary. These
# ordinary processes need no Pi session, provider credential or subagent command.
python3 - "$parent/workload/runtime" "$relative" <<'MANAGED_TASK_PY'
import errno
import json
import os
import pathlib
import select
import shutil
import subprocess
import sys
import time

helper = "/usr/local/bin/guest-task-exec"
main_runtime = pathlib.Path(sys.argv[1])
parent_tool = sys.argv[2]
main_pids = (main_runtime / "cgroup.procs").read_text()
main_min = (main_runtime / "memory.min").read_text()

nested_support = r'''
import json, os, pathlib, select, subprocess
children = {}
def delegation_action(action):
    if action == "nested":
        r, w = os.pipe()
        child = subprocess.Popen(["/usr/local/bin/guest-task-exec", "--report-fd", str(w), "--",
                                  "python3", "-u", "-c", os.environ["TASK_NESTED_PROGRAM"]],
                                 pass_fds=(w,), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        os.close(w)
        assert select.select([r], [], [], 10)[0], "nested admission timed out"
        with os.fdopen(r) as report:
            metadata = json.loads(report.readline())
        assert metadata["pid"] == child.pid
        assert select.select([child.stdout], [], [], 10)[0], "nested runtime not ready"
        ready = json.loads(child.stdout.readline())
        children[metadata["handle"]] = child
        print(json.dumps({"nested": dict(metadata, **ready)}), flush=True)
        return True
    if action.startswith("child "):
        _, handle, command = action.split(" ", 2)
        child = children[handle]
        child.stdin.write(command + "\n")
        child.stdin.flush()
        assert select.select([child.stdout], [], [], 15)[0], "nested command timed out"
        print(child.stdout.readline().strip(), flush=True)
        return True
    if action.startswith("stop "):
        handle = action.split(" ", 1)[1]
        stopped = subprocess.run(["/usr/local/bin/guest-task-exec", "stop", handle],
                                 capture_output=True, timeout=20)
        if stopped.returncode == 0 and handle in children:
            children[handle].wait(timeout=5)
        print(json.dumps({"stop_code": stopped.returncode}), flush=True)
        return True
    return False
'''

nested_program = r'''
import json, os, pathlib, signal, subprocess, sys
exec(os.environ["TASK_NESTED_SUPPORT"])
relative = pathlib.Path("/proc/self/cgroup").read_text().strip().removeprefix("0::")
assert relative.endswith("/runtime") and relative.count("/tools/task-") >= 2
assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "0"
signal.signal(signal.SIGTERM, signal.SIG_IGN)
detached = subprocess.Popen(["/usr/bin/setsid", "/bin/bash", "-c", "trap '' TERM; while :; do sleep 1; done"],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
lines = subprocess.check_output(["/usr/local/bin/guest-tool-exec", "-c", "cat /proc/self/cgroup; cat /proc/self/oom_score_adj"],
                                text=True, timeout=10).splitlines()
assert lines[0].startswith("0::" + relative.removesuffix("/runtime") + "/tools/tool-")
assert lines[1] == "1000"
print(json.dumps({"runtime": relative, "tool": lines[0][3:], "detached": detached.pid}), flush=True)
for action in sys.stdin:
    action = action.strip()
    if delegation_action(action):
        continue
    if action == "exit":
        sys.exit(0)
    if action == "runtime_oom":
        leaf = "/sys/fs/cgroup" + relative
        subprocess.run(["sudo", "sh", "-c", 'echo 50331648 > "$1/memory.max"', "sh", leaf], check=True)
        print(json.dumps({"nested_runtime_oom_armed": True}), flush=True)
        a = bytearray(134217728)
        raise AssertionError("nested runtime OOM did not occur")
    if action == "pending":
        pending = r"""
import array, json, os, socket
stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
stream.settimeout(15)
stream.connect("\0" + os.environ["OKOU_TOOL_CGROUP_PROCS_ENDPOINT"])
fds = array.array("i")
marker, control, flags, _ = stream.recvmsg(1, socket.CMSG_SPACE(fds.itemsize))
assert marker == b"T" and not flags & socket.MSG_CTRUNC
for level, kind, data in control:
    assert (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS)
    fds.frombytes(data)
assert len(fds) == 1
print(json.dumps({"placement_pending": True}), flush=True)
assert stream.recv(1) == b"", "closed ancestor allowed a tool ACK"
os.close(fds[0])
"""
        peer = subprocess.Popen(["python3", "-u", "-c", pending], stdout=subprocess.PIPE, text=True)
        assert json.loads(peer.stdout.readline())["placement_pending"]
        print(json.dumps({"placement_pending": True}), flush=True)
        assert peer.wait(timeout=10) == 0
'''
os.environ["TASK_NESTED_SUPPORT"] = nested_support
os.environ["TASK_NESTED_PROGRAM"] = nested_program

runtime_program = r'''
import errno, json, os, pathlib, signal, subprocess, sys
exec(os.environ["TASK_NESTED_SUPPORT"])
assert os.geteuid() != 0
assert sys.argv[1:] == ["ordinary task arg", ""]
assert os.environ["TASK_SENTINEL"] == "preserved"
assert os.read(int(os.environ["APP_FD"]), 3) == b"ipc"
os.close(int(os.environ["APP_FD"]))
try:
    os.fstat(int(os.environ["REPORT_FD"]))
except OSError as error:
    assert error.errno == errno.EBADF
else:
    raise AssertionError("private startup FD leaked across exec")
relative = pathlib.Path("/proc/self/cgroup").read_text().strip().removeprefix("0::")
assert relative.endswith("/runtime") and "/tools/task-" in relative
assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "0"
signal.signal(signal.SIGTERM, signal.SIG_IGN)
detached = subprocess.Popen(["/usr/bin/setsid", "/bin/bash", "-c", "trap '' TERM; while :; do sleep 1; done"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
command = ["/usr/local/bin/guest-tool-exec", "-c", "cat /proc/self/cgroup; cat /proc/self/oom_score_adj"]
lines = subprocess.check_output(command, text=True, timeout=10).splitlines()
assert lines[0].startswith("0::" + relative.removesuffix("/runtime") + "/tools/tool-")
assert lines[1] == "1000"
print(json.dumps({"runtime": relative, "tool": lines[0][3:], "detached": detached.pid}), flush=True)
for action in sys.stdin:
    if delegation_action(action.strip()):
        continue
    if action.strip() == "exit":
        sys.exit(0)
    if action.strip() == "oom":
        # Test-only leaf limit: production adds no per-task quota or protection.
        oom = """leaf=/sys/fs/cgroup$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup); sudo sh -c 'echo 50331648 > "$1/memory.max"' sh "$leaf"; python3 -c 'a=bytearray(134217728); print(len(a))'"""
        result = subprocess.run(["/usr/local/bin/guest-tool-exec", "-c", oom], timeout=10)
        assert result.returncode in (-9, 137), result.returncode
        print(json.dumps({"tool_oom_survived": True}), flush=True)
    if action.strip() == "runtime_oom":
        leaf = "/sys/fs/cgroup" + relative
        subprocess.run(["sudo", "sh", "-c", 'echo 50331648 > "$1/memory.max"', "sh", leaf], check=True)
        a = bytearray(134217728)
        raise AssertionError("task runtime OOM did not occur")
    if action.strip() == "crash":
        os.kill(os.getpid(), signal.SIGKILL)
    if action.strip() == "pending_task_exit":
        # Hold a real nested task handoff across creator exit, then confirm it.
        # The closed ancestor must prevent ACK, not merely clean up a running target.
        pending = r"""
import array, json, os, pathlib, socket, struct
stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
stream.settimeout(10)
stream.connect("\0" + os.environ["OKOU_TOOL_CGROUP_PROCS_ENDPOINT"] + "-tasks")
payload = b'\x01{"op":"launch"}'
stream.sendall(struct.pack("!I", len(payload)) + payload)
def receive(size):
    value = b""
    while len(value) < size:
        part = stream.recv(size - len(value))
        assert part, "nested admission closed before descriptor handoff"
        value += part
    return value
reply = receive(struct.unpack("!I", receive(4))[0])
assert reply[0] == 1
task = json.loads(reply[1:])["task"]
fds = array.array("i")
marker, control, flags, _ = stream.recvmsg(1, socket.CMSG_SPACE(fds.itemsize))
assert marker == b"T" and not flags & socket.MSG_CTRUNC
for level, kind, data in control:
    assert (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS)
    fds.frombytes(data)
assert len(fds) == 1
os.write(fds[0], b"0")
os.close(fds[0])
runtime = pathlib.Path("/proc/self/cgroup").read_text().strip()[3:]
print(json.dumps(dict(task, runtime=runtime)), flush=True)
with open(os.environ["TASK_PENDING_GATE"], "rb", buffering=0) as gate:
    assert gate.read(1) == b"1"
stream.sendall(b"C")
if stream.recv(1) == b"A":
    pathlib.Path(os.environ["TASK_PENDING_GATE"] + ".acked").touch()
    raise AssertionError("exited creator admitted its nested task")
"""
        peer = subprocess.Popen(["python3", "-u", "-c", pending], stdout=subprocess.PIPE, text=True)
        assert select.select([peer.stdout], [], [], 10)[0]
        print(peer.stdout.readline().strip(), flush=True)
        sys.exit(0)
    if action.strip() == "pending":
        # A real protocol peer observes the production broker's FD handoff but
        # withholds confirmation. Stop must fence and drain this admission;
        # publishing child spawn alone does not prove a handoff is in flight.
        pending = """
import array, json, os, socket, sys
stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
stream.settimeout(15)
stream.connect("\\0" + os.environ["OKOU_TOOL_CGROUP_PROCS_ENDPOINT"])
fds = array.array("i")
marker, control, flags, _ = stream.recvmsg(1, socket.CMSG_SPACE(fds.itemsize))
assert marker == b"T" and not flags & socket.MSG_CTRUNC
for level, kind, data in control:
    assert (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS)
    fds.frombytes(data)
assert len(fds) == 1
assert os.readlink("/proc/self/fd/" + str(fds[0])).endswith("/cgroup.procs")
print(json.dumps({"placement_pending": True}), flush=True)
assert stream.recv(1) == b"", "unconfirmed tool received an ACK"
os.close(fds[0])
"""
        peer = subprocess.Popen(["python3", "-u", "-c", pending], stdout=subprocess.PIPE, text=True)
        observed = peer.stdout.readline()
        assert observed and json.loads(observed)["placement_pending"]
        print(json.dumps({"placement_pending": True}), flush=True)
        assert peer.wait(timeout=10) == 0
        print(json.dumps({"placement_drained": True}), flush=True)
'''


def startup(program, extra=(), env=None):
    report_read, report_write = os.pipe()
    child_env = dict(os.environ) if env is None else env
    child_env["REPORT_FD"] = str(report_write)
    process = subprocess.Popen([helper, "--report-fd", str(report_write), "--", *program], pass_fds=(report_write, *extra), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=child_env)
    os.close(report_write)
    if not select.select([report_read], [], [], 10)[0]:
        raise AssertionError("task private startup acknowledgement timed out")
    with os.fdopen(report_read) as report:
        line = report.readline()
    if not line:
        return process, None
    metadata = json.loads(line)
    assert metadata["pid"] == process.pid
    return process, metadata


def read_json(process):
    assert select.select([process.stdout], [], [], 15)[0], "task program response timed out"
    line = process.stdout.readline()
    assert line, f"task exited unexpectedly: {process.poll()}"
    return json.loads(line)


def launch():
    app_read, app_write = os.pipe()
    os.write(app_write, b"ipc")
    os.close(app_write)
    env = dict(os.environ, TASK_SENTINEL="preserved", APP_FD=str(app_read))
    process, metadata = startup(["python3", "-u", "-c", runtime_program, "ordinary task arg", ""], (app_read,), env)
    os.close(app_read)
    assert metadata is not None
    ready = read_json(process)
    task = pathlib.Path("/sys/fs/cgroup" + ready["runtime"]).parent
    assert task.name == "task-" + metadata["handle"]
    for node, oom_group in [(task, "0"), (task / "runtime", "1"), (task / "tools", "0")]:
        assert (node / "memory.oom.group").read_text().strip() == oom_group
        assert (node / "memory.min").read_text().strip() == "0"
    assert not (task / "cgroup.procs").read_text().strip()
    assert not (task / "tools/cgroup.procs").read_text().strip()
    return process, metadata, ready, task


def gone(task):
    deadline = time.monotonic() + 15
    while task.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not task.exists(), f"owned task subtree leaked: {task}"


def stop(task):
    process, metadata, ready, path = task
    subprocess.run([helper, "stop", metadata["handle"]], check=True, timeout=20)
    process.wait(timeout=5)
    gone(path)
    stale = subprocess.run([helper, "stop", metadata["handle"]], timeout=10, capture_output=True)
    assert stale.returncode == 0, "proven cleanup was not idempotent"
    gone(pathlib.Path(f"/proc/{ready['detached']}"))


def command(process, action):
    process.stdin.write(action + "\n")
    process.stdin.flush()
    return read_json(process)


def nested_path(parent, child):
    path = pathlib.Path("/sys/fs/cgroup" + child["runtime"]).parent
    assert path == parent / "tools" / ("task-" + child["handle"])
    for node, oom_group in [(path, "0"), (path / "runtime", "1"), (path / "tools", "0")]:
        assert (node / "memory.oom.group").read_text().strip() == oom_group
        assert (node / "memory.min").read_text().strip() == "0"
    assert not (path / "cgroup.procs").read_text().strip()
    assert not (path / "tools/cgroup.procs").read_text().strip()
    return path


a, b = launch(), launch()  # Deliberately one starter Bash, not two tool owners.
assert a[1]["handle"] != b[1]["handle"] and a[3] != b[3]
a[0].stdin.write("oom\n")
a[0].stdin.flush()
assert read_json(a[0])["tool_oom_survived"]
assert a[0].poll() is None and b[0].poll() is None
n = command(a[0], "nested")["nested"]
np = nested_path(a[3], n)
g = command(a[0], "child " + n["handle"] + " nested")["nested"]
gp = nested_path(np, g)
assert command(a[0], "stop " + b[1]["handle"])["stop_code"] == 125
assert b[0].poll() is None
assert command(a[0], "child " + n["handle"] + " stop " + g["handle"])["stop_code"] == 0
gone(gp)
gone(pathlib.Path(f"/proc/{g['detached']}"))
assert pathlib.Path(f"/proc/{n['pid']}").exists() and a[0].poll() is None
g2 = command(a[0], "child " + n["handle"] + " nested")["nested"]
gp2 = nested_path(np, g2)
assert g2["handle"] != g["handle"]
assert command(a[0], "child " + n["handle"] + " stop " + g["handle"])["stop_code"] == 0
assert pathlib.Path(f"/proc/{g2['pid']}").exists(), "retired handle stopped a replacement"
assert command(a[0], "child " + n["handle"] + " child " + g2["handle"] + " runtime_oom")["nested_runtime_oom_armed"]
gone(gp2)
gone(pathlib.Path(f"/proc/{g2['detached']}"))
assert a[0].poll() is None and pathlib.Path(f"/proc/{n['pid']}").exists()
g3 = command(a[0], "child " + n["handle"] + " nested")["nested"]
gp3 = nested_path(np, g3)
assert command(a[0], "child " + n["handle"] + " child " + g3["handle"] + " pending")["placement_pending"]
stop(a)  # Runtime/descendant ignore TERM: task-only cgroup.kill is required.
for child in (n, g3):
    gone(pathlib.Path(f"/proc/{child['pid']}"))
    gone(pathlib.Path(f"/proc/{child['detached']}"))
gone(gp3)
assert b[0].poll() is None
assert (main_runtime / "cgroup.procs").read_text() == main_pids
assert (main_runtime / "memory.min").read_text() == main_min
assert pathlib.Path("/proc/self/cgroup").read_text().strip() == "0::" + parent_tool
b[0].stdin.write("exit\n")
b[0].stdin.flush()
assert b[0].wait(timeout=5) == 0
gone(b[3])  # The runtime socket is long closed; pidfd lifetime owns descendants.

c = launch()
cn = command(c[0], "nested")["nested"]
cnp = nested_path(c[3], cn)
c[0].stdin.write("runtime_oom\n")
c[0].stdin.flush()
assert c[0].wait(timeout=10) in (-9, 137)
gone(c[3])
gone(cnp)
gone(pathlib.Path(f"/proc/{cn['pid']}"))
assert (main_runtime / "cgroup.procs").read_text() == main_pids

pending = launch()
pending[0].stdin.write("pending\n")
pending[0].stdin.flush()
assert read_json(pending[0])["placement_pending"]
stop(pending)
assert read_json(pending[0])["placement_drained"]

for action in ("exit", "crash"):
    ancestor = launch()
    child = command(ancestor[0], "nested")["nested"]
    child_path = nested_path(ancestor[3], child)
    ancestor[0].stdin.write(action + "\n")
    ancestor[0].stdin.flush()
    assert ancestor[0].wait(timeout=5) == (0 if action == "exit" else -9)
    gone(ancestor[3])
    gone(child_path)
    gone(pathlib.Path(f"/proc/{child['pid']}"))
    gone(pathlib.Path(f"/proc/{child['detached']}"))

gate = pathlib.Path("/tmp/vm0-process-containment/pending-task-gate")
os.mkfifo(gate, 0o600)
os.environ["TASK_PENDING_GATE"] = str(gate)
ancestor = launch()
unconfirmed = command(ancestor[0], "pending_task_exit")
assert ancestor[0].wait(timeout=5) == 0
unconfirmed_path = nested_path(ancestor[3], unconfirmed)
with gate.open("wb", buffering=0) as release_gate:
    release_gate.write(b"1")
gone(ancestor[3])
gone(unconfirmed_path)
gone(pathlib.Path(f"/proc/{unconfirmed['pid']}"))
assert not pathlib.Path(str(gate) + ".acked").exists()
gate.unlink()

failed, metadata = startup(["/no/such/managed-task-program"])
assert metadata is not None and failed.wait(timeout=10) == 126
failed_task = main_runtime.parent / "tools" / ("task-" + metadata["handle"])
gone(failed_task)

# An unavailable/stopped broker never runs the target and produces no startup
# record. No unmanaged or protected-main-runtime fallback is permitted.
no_cap_env = dict(os.environ)
no_cap_env["OKOU_TOOL_CGROUP_PROCS_ENDPOINT"] += "-unavailable"
unavailable, metadata = startup(["/bin/sh", "-c", "echo unsafe-target-ran"], env=no_cap_env)
assert metadata is None and unavailable.wait(timeout=10) == 125
assert unavailable.stdout.read() == ""

# Actual expected-UID authentication, not a test role/environment flag.
root_probe = r'''
import os, subprocess
assert os.geteuid() == 0
r, w = os.pipe()  # Created after sudo, which otherwise closes inherited FDs.
p = subprocess.Popen(["/usr/local/bin/guest-task-exec", "--report-fd", str(w), "--", "/bin/echo", "unsafe-target-ran"], pass_fds=(w,), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
os.close(w)
out, err = p.communicate(timeout=10)
with os.fdopen(r) as report:
    assert report.read() == ""
assert p.returncode == 125 and out == ""
assert "task caller UID mismatch" in err
'''
subprocess.run(["sudo", "--preserve-env=OKOU_TOOL_CGROUP_PROCS_ENDPOINT", "python3", "-c", root_probe], check=True, timeout=15)

# Exercise the shipped image-batch consumer through the public CLI entry point.
# Only its target entrypoint is an ordinary fixture, so no paid provider runs.
# The native helper, private Node pipe, admission and lifecycle owner are real.
batch_root = pathlib.Path("/tmp/vm0-process-containment/image-batch")
batch_root.mkdir()
cli = shutil.which("okou")
assert cli, "source-bound CLI is missing from the Guest image"
cli_entrypoint = json.loads(pathlib.Path("/usr/local/lib/okou-cli/installed.json").read_text())["entrypoint"]
assert pathlib.Path(cli_entrypoint).is_file(), "installed CLI entrypoint is missing"
worker = batch_root / "okou.js"
worker.write_text(r'''
const fs = require("node:fs");
const path = require("node:path");
const [, , , manifest, state] = process.argv.slice(2);
const relative = fs.readFileSync("/proc/self/cgroup", "utf8").trim().slice(3);
const score = fs.readFileSync("/proc/self/oom_score_adj", "utf8").trim();
const ready = { pid: process.pid, runtime: relative, score };
const release = path.join(state, "release-worker");
let finished = false;
function complete() {
  if (finished) return;
  finished = true;
  watcher.close();
  const id = fs.readFileSync(manifest, "utf8").split("\t", 1)[0];
  fs.writeFileSync(path.join(state, "results.tsv"), id + "\thttps://cdn.example/fixture.png\n");
  fs.writeFileSync(path.join(state, "done.tmp"), "0\n");
  fs.renameSync(path.join(state, "done.tmp"), path.join(state, "done"));
}
const watcher = fs.watch(state, (_event, filename) => {
  if (filename === "release-worker") complete();
});
console.log("image-batch-worker-output");
fs.writeFileSync(path.join(state, "worker-runtime.json.tmp"), JSON.stringify(ready));
fs.renameSync(path.join(state, "worker-runtime.json.tmp"), path.join(state, "worker-runtime.json"));
if (fs.existsSync(release)) complete();
''')
driver = batch_root / "driver.mjs"
driver.write_text('''
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
process.argv[1] = process.env.BATCH_TEST_WORKER;
await import(pathToFileURL(realpathSync(process.env.BATCH_TEST_CLI)).href);
''')
manifest = batch_root / "images.tsv"
manifest.write_text("hero\tA synthetic test image\n")
batch_env = dict(os.environ, BATCH_TEST_WORKER=str(worker), BATCH_TEST_CLI=cli_entrypoint,
                 OKOU_TOKEN="synthetic-image-batch-test-token", SENTRY_DSN="",
                 OKOU_API_BACKEND_URL="http://127.0.0.1:9", OKOU_DISABLED_PAID_TOOLS="[]")
node = shutil.which("node")
assert node, "Guest Node executable is missing"
batch_tasks = []
for name in ("first", "second"):
    state = batch_root / name
    started = subprocess.run([node, str(driver), "generate", "image-batch", "start", str(manifest), str(state)],
                             env=batch_env, check=True, capture_output=True, text=True, timeout=40)
    assert "Image batch started:" in started.stdout
    assert "image-batch-worker-output" not in started.stdout
    deadline = time.monotonic() + 10
    ready_path = state / "worker-runtime.json"
    while not ready_path.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    ready = json.loads(ready_path.read_text())
    assert ready["pid"] == int((state / "pid").read_text())
    assert ready["score"] == "0"
    task_path = pathlib.Path("/sys/fs/cgroup" + ready["runtime"]).parent
    assert task_path.parent == main_runtime.parent / "tools"
    assert task_path.name.startswith("task-") and ready["runtime"].endswith("/runtime")
    assert (task_path / "runtime/cgroup.procs").read_text().strip() == str(ready["pid"])
    status = pathlib.Path(f"/proc/{ready['pid']}/status").read_text()
    assert next(line.split(":", 1)[1].strip() for line in status.splitlines() if line.startswith("PPid:")) == "1"
    assert not (state / "done").exists(), "start waited for the worker to finish"
    batch_tasks.append((state, task_path, ready["pid"]))
assert batch_tasks[0][1] != batch_tasks[1][1]
for state, task_path, pid in batch_tasks:
    (state / "release-worker").touch()
    waited = subprocess.run([cli, "generate", "image-batch", "wait", str(state), "--timeout", "10"],
                            env=batch_env, check=True, capture_output=True, text=True, timeout=20)
    assert "hero\thttps://cdn.example/fixture.png" in waited.stdout
    assert "Image batch joined:" in waited.stdout
    assert "image-batch-worker-output" in (state / "output.log").read_text()
    gone(task_path)
    gone(pathlib.Path(f"/proc/{pid}"))
print("image-batch-native-task-consumer-passed", flush=True)

# The actual packaged Pi loop, model/session factories and Bash wrapper run
# against a local provider fixture. A creates B through its real scoped Bash;
# an unrelated sibling remains alive when A's complete subtree is stopped.
import http.server
import shlex
import threading
import uuid

pi_root = pathlib.Path("/tmp/vm0-process-containment/pi-subagents")
pi_root.mkdir()
pi_launch = pi_root / "launch.json"
pi_launch.write_text(json.dumps({"schemaVersion": 1, "appendSystemPrompt": "Native Guest subagent fixture",
                               "launchConfig": {"schemaVersion": 2}}))
labels = ("NATIVE_TASK_A", "NATIVE_TASK_B", "NATIVE_TASK_C")
requests = {label: 0 for label in labels}
active = {label: threading.Event() for label in labels}
release = {label: threading.Event() for label in labels}
failures = []


class PiProvider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert self.headers["Authorization"] == "Bearer synthetic-subagent-key"
            assert body["model"] == "deepseek/deepseek-v4.1-flash"
            assert body["reasoning"]["effort"] == "high"
            initial = next(message for message in body["messages"] if message["role"] == "user")
            label = next(label for label in labels if label in json.dumps(initial["content"]))
            requests[label] += 1
            if requests[label] == 1:
                observed = pi_root / (label + ".tool.json")
                source = "import json,pathlib; print(json.dumps({'cgroup':pathlib.Path('/proc/self/cgroup').read_text().strip()[3:], 'score':pathlib.Path('/proc/self/oom_score_adj').read_text().strip()}))"
                command = "python3 -c " + shlex.quote(source) + " > " + shlex.quote(str(observed))
                if label == "NATIVE_TASK_A":
                    command += "; " + shlex.quote(cli) + " subagent start NATIVE_TASK_B > " + shlex.quote(str(pi_root / "nested-start"))
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "native_tool", "type": "function",
                          "function": {"name": "bash", "arguments": json.dumps({"command": command})}}]}
                finish = "tool_calls"
            else:
                active[label].set()
                assert release[label].wait(45), "native provider fixture did not finish"
                delta = {"role": "assistant", "content": "Native fixture complete"}
                finish = "stop"
            events = [
                {"id": "native-fixture", "object": "chat.completion.chunk", "created": 1,
                 "model": body["model"], "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {"id": "native-fixture", "object": "chat.completion.chunk", "created": 1,
                 "model": body["model"], "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                 "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}},
            ]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(("".join("data: " + json.dumps(event) + "\n\n" for event in events) + "data: [DONE]\n\n").encode())
        except (BrokenPipeError, ConnectionResetError):
            pass  # Expected when native stop cancels an in-flight model request.
        except Exception as error:
            failures.append(repr(error))
            self.close_connection = True


provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), PiProvider)
threading.Thread(target=provider.serve_forever, daemon=True).start()
pi_env = dict(os.environ, OKOU_RUN_ID=str(uuid.uuid4()), OKOU_PI_SESSION_ROLE="parent",
              OKOU_PI_SESSION_ID="native-parent", OKOU_PI_RUNTIME_ROOT=str(pi_root),
              OKOU_PI_LAUNCH_PAYLOAD_FILE=str(pi_launch), OKOU_PI_EFFECTIVE_THINKING_LEVEL="high",
              OPENAI_API_KEY="synthetic-subagent-key", OKOU_TOKEN="synthetic-subagent-token", SENTRY_DSN="")
pi_env["OKOU_PI_MODEL_CONFIG"] = json.dumps({
    "schemaVersion": 5, "provider": "openrouter", "baseUrl": f"http://127.0.0.1:{provider.server_port}/v1",
    "model": "deepseek/deepseek-v4.1-flash", "dialect": "openai-completions", "transport": "sse",
    "thinkingLevel": "low", "credentialBindings": [{"kind": "api-key", "environment": "OPENAI_API_KEY",
                                                    "secretName": "OPENROUTER_API_KEY"}]})


def pi_command(*args):
    result = subprocess.run([cli, "subagent", *args], env=pi_env, capture_output=True, text=True, timeout=40)
    assert result.returncode == 0, (args, result.stdout, result.stderr)
    return result.stdout


def decode_inspection(text):
    return json.JSONDecoder().raw_decode(text)[0]


def pi_task(item):
    registry = pathlib.Path(item["stdout"]).parent
    native = json.loads((registry / "task").read_text())
    assert native["pid"] == item["pid"]
    relative = pathlib.Path(f"/proc/{item['pid']}/cgroup").read_text().strip()[3:]
    assert relative.endswith("/task-" + native["handle"] + "/runtime")
    assert pathlib.Path(f"/proc/{item['pid']}/oom_score_adj").read_text().strip() == "0"
    return registry, pathlib.Path("/sys/fs/cgroup" + relative).parent


try:
    pa = decode_inspection(pi_command("start", "NATIVE_TASK_A"))
    pc = decode_inspection(pi_command("start", "NATIVE_TASK_C"))
    for label in labels:
        assert active[label].wait(15), (label, failures)
    pb = decode_inspection((pi_root / "nested-start").read_text())
    ra, ca = pi_task(pa)
    rb, cb = pi_task(pb)
    rc, cc = pi_task(pc)
    assert ca.parent == cc.parent == main_runtime.parent / "tools"
    assert cb.parent == ca / "tools", "Pi child escaped its creator's subtree"
    for item, path, label in [(pa, ca, "NATIVE_TASK_A"), (pb, cb, "NATIVE_TASK_B"), (pc, cc, "NATIVE_TASK_C")]:
        tool = json.loads((pi_root / (label + ".tool.json")).read_text())
        assert pathlib.Path("/sys/fs/cgroup" + tool["cgroup"]).parent == path / "tools"
        assert tool["score"] == "1000"
        assert item["id"] in pi_command("list")
        assert decode_inspection(pi_command("inspect", item["id"]))["running"]
    pi_command("steer", "-p", pa["id"], "Native steering before cancellation")
    pi_command("kill", pa["id"])
    for item, path in [(pa, ca), (pb, cb)]:
        gone(path)
        gone(pathlib.Path(f"/proc/{item['pid']}"))
    assert pathlib.Path(f"/proc/{pc['pid']}").exists() and cc.exists()
    # SIGKILL may prevent best-effort Pi registry removal; the saved UUID still
    # supports safe cleanup after the native ancestor stop has retired B.
    if rb.exists():
        pi_command("kill", pb["id"])
    release["NATIVE_TASK_C"].set()
    gone(rc)
    gone(cc)
    assert "No running subagents" in pi_command("list")
    assert not failures, failures
finally:
    for event in release.values():
        event.set()
    provider.shutdown()
    provider.server_close()
print("pi-subagent-native-nested-consumer-passed", flush=True)

assert not list((main_runtime.parent / "tools").glob("task-*"))
assert (main_runtime / "cgroup.procs").read_text() == main_pids
assert (main_runtime / "memory.min").read_text() == main_min
print("managed-task-runtime-isolation-passed", flush=True)
MANAGED_TASK_PY

PROMPT
)

echo "--- Managed tasks: native delegation, isolation and consumer lifetimes ---"
sudo "$BIN_DIR/runner" local submit --group "$GROUP" \
  --chat-thread-id "$CHAT_THREAD_ID" \
  --session-id e2e-process-containment-managed-tasks \
  --feature-flag sandboxReuse=true \
  --prompt "$TASK_PROMPT" \
  || fail "managed-task native admission, isolation or consumer lifecycle failed"

echo "PASS: managed tasks and their consumers retired without affecting siblings or the main runtime"
