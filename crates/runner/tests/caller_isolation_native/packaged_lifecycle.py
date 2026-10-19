"""Real CLI child cancellation and kernel placement checks in the owned Guest."""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/home/user/workspace")


def child():
    with socket.socket() as peer:
        denied = peer.connect_ex(("127.0.0.1", 18080))
    status = dict(
        line.split(":", 1)
        for line in Path("/proc/self/status").read_text().splitlines()
        if ":" in line
    )
    observed = {
        "pid": os.getpid(),
        "uid": os.getuid(),
        "context": Path("/proc/self/attr/current").read_text().rstrip("\0"),
        "capEff": status["CapEff"].strip(),
        "cgroup": Path("/proc/self/cgroup").read_text().strip(),
        "connectErrno": denied,
    }
    temporary = ROOT / "lifecycle-ready.tmp"
    temporary.write_text(json.dumps(observed))
    temporary.replace(ROOT / "lifecycle-ready.json")
    with (ROOT / "lifecycle-block").open("rb", buffering=0) as blocker:
        blocker.read(1)
    raise AssertionError("cancelled tool unexpectedly continued")


def parent():
    started = subprocess.run(
        ["okou", "subagent", "start", "PI_LIFECYCLE_CHILD"],
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
    )
    item, _end = json.JSONDecoder().raw_decode(started.stdout.lstrip())
    deadline = time.monotonic() + 8
    while not (ROOT / "lifecycle-ready.json").exists():
        if time.monotonic() >= deadline:
            raise TimeoutError("child tool readiness")
        time.sleep(0.01)
    stopped = subprocess.run(
        ["okou", "subagent", "kill", str(item["id"])],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    (ROOT / "lifecycle-parent-done.json").write_text(
        json.dumps({"start": item, "stopOutput": stopped.stdout})
    )
    print("managed child and blocked tool stopped")


def probe(root, env, pi_session, tasks, record):
    fifo = root / "lifecycle-block"
    os.mkfifo(fifo, 0o600)
    os.chown(fifo, 1000, 1000)
    before = set(tasks)
    status, _records = pi_session(
        {**env, "OKOU_PI_SESSION_ID": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},
        "PI_LIFECYCLE_MAIN",
    )
    path = root / "lifecycle-ready.json"
    observed = json.loads(path.read_text()) if path.exists() else {}
    created = [tasks[key] for key in set(tasks) - before]
    deadline = time.monotonic() + 2
    populated = {}
    while True:
        populated = {
            str(group): dict(
                line.split()
                for line in (group / "cgroup.events").read_text().splitlines()
            ).get("populated")
            for group in created
        }
        if (
            all(value == "0" for value in populated.values())
            or time.monotonic() >= deadline
        ):
            break
        time.sleep(0.01)
    pid = observed.get("pid")
    process = Path(f"/proc/{pid}/stat") if type(pid) is int and pid > 1 else None
    exited = process is not None and (
        not process.exists() or process.read_text().split(")", 1)[1].split()[0] == "Z"
    )
    passed = (
        status == 0
        and (root / "lifecycle-parent-done.json").exists()
        and len(created) == 1
        and populated
        and all(value == "0" for value in populated.values())
        and exited
        and observed.get("uid") == 1000
        and observed.get("context") == "system_u:system_r:workload_t"
        and observed.get("capEff") == "0000000000000000"
        and observed.get("connectErrno") in (1, 13)
    )
    record(
        "real_pi_child_cancellation",
        bool(passed),
        exit=status,
        childTool=observed,
        populated=populated,
        childKernelExited=exited,
    )


if __name__ == "__main__":
    {"parent": parent, "child": child}[sys.argv[1]]()
