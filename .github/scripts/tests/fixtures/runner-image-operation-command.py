#!/usr/bin/env python3
"""External SSH/systemd/privileged-runner fixture; internal image code stays real."""

import contextlib
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ["IMAGE_FIXTURE"])
MODE = os.environ.get("IMAGE_FAULT", "")


def record(kind, value):
    with (ROOT / (kind + ".jsonl")).open("a") as stream:
        stream.write(json.dumps(value) + "\n")


def alive(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().split(")", 1)[1].split()[0] != "Z"
    except FileNotFoundError:
        return False


def wait_for(predicate):
    deadline = time.monotonic() + 12
    while not predicate():
        if time.monotonic() >= deadline:
            raise RuntimeError("fixture synchronization deadline exceeded")
        time.sleep(0.01)


def once():
    try:
        descriptor = os.open(ROOT / "fault-used", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        return True
    except FileExistsError:
        return False


def ssh(arguments):
    if MODE == "early-eof" and once():
        record("requests", {"action": "unread"})
        return 255
    request = json.load(sys.stdin)
    record("requests", {"action": request["action"], "phase": request.get("phase")})
    if MODE == "ssh-error":
        return 7
    # Map the remote tmpfs into this endpoint's isolated filesystem.
    arguments = ["TMPDIR=" + str(ROOT) if a == "TMPDIR=/dev/shm" else a for a in arguments]
    process = subprocess.Popen(
        ["bash", "-c", " ".join(arguments[1:])],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        process.stdin.write(json.dumps(request).encode())
        process.stdin.close()
        fault = request["action"] == "run" and request["phase"] == "build"
        if fault and MODE == "lost-launch" and once():
            wait_for(lambda: any((ROOT / "units").glob("*.json")))
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            return 255
        for line in process.stdout:
            frame = json.loads(line)
            if MODE == "lost-claim" and "claimed" in frame and once():
                process.wait()
                return 255
            if (
                MODE == "lost-guard"
                and request["action"] == "guard"
                and "result" in frame
                and once()
            ):
                process.wait()
                return 255
            if fault and "result" in frame:
                if MODE == "lost-result" and once():
                    process.wait()
                    return 255
                if MODE == "partial-result" and once():
                    sys.stdout.buffer.write(line[: len(line) // 2])
                    sys.stdout.buffer.flush()
                    process.wait()
                    return 255
                if MODE == "wrong-result":
                    frame["result"]["identity"] = "0" * 64
                elif MODE == "invalid-result-hash":
                    frame["result"]["rootfsHash"] = "invalid"
                line = (json.dumps(frame) + "\n").encode()
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
        return process.wait()
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def systemd_run(arguments):
    record("systemd", arguments)
    if any(argument.startswith("--on-active=") for argument in arguments):
        return 0  # Record the real retention contract without waiting one hour.
    unit = next(
        argument.split("=", 1)[1] for argument in arguments if argument.startswith("--unit=")
    )
    command = arguments[arguments.index("/usr/bin/python3") :]
    if MODE == "absent-launch":
        return 1
    with open(os.devnull, "wb") as sink:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=sink, stderr=sink, start_new_session=True
        )
    path = ROOT / "units" / (unit + ".json")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"pid": process.pid}))
    temporary.replace(path)
    return 0


def systemctl(arguments):
    if arguments[0] == "show":
        unit = arguments[1]
        path = ROOT / "units" / (unit + ".json")
        if not path.exists():
            print("LoadState=not-found")
            return 0
        info = json.loads(path.read_text())
        running = alive(info["pid"])
        print("LoadState=loaded")
        print("ActiveState=" + ("active" if running else "inactive"))
        print("MainPID=" + (str(info["pid"]) if running else "0"))
        print("Job=")
        print("ControlGroup=" + ("/" if MODE == "populated-cgroup" else ""))
        return 0
    if arguments[0] == "stop":
        path = ROOT / "units" / (arguments[-1] + ".json")
        info = json.loads(path.read_text())
        if MODE == "failed-stop":
            return 1
        with contextlib.suppress(ProcessLookupError):
            os.killpg(info["pid"], signal.SIGKILL)
        record("stops", arguments[-1])
        return 0
    raise RuntimeError("unsupported fixture systemctl operation")


def runner(arguments):
    phase = "warm" if "--warm-rootfs-cache" in arguments else "build"
    record("executions", {"phase": phase, "pid": os.getpid()})
    if phase == "warm":
        return 0
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "")
    print("image-progress", flush=True)
    print(secret, flush=True)
    if MODE == "large-log":
        # Straddle readline's chunk boundary, then exceed retained-log capacity.
        sys.stdout.write("x" * (65536 - len(secret) // 2) + secret + "\n")
        sys.stdout.write("x" * (1024 * 1024 + 100) + "\n")
        sys.stdout.flush()
    rootfs = "g" * 64 if MODE == "invalid-hash" else "1" * 64
    print("rootfs_hash=" + rootfs, flush=True)
    if MODE != "missing-hash":
        print("snapshot_hash=" + "2" * 64, flush=True)
    if (ROOT / "block").exists():
        wait_for(lambda: (ROOT / "release").exists())
    return int(os.environ.get("IMAGE_BUILD_STATUS", "0"))


def main():
    name = Path(sys.argv[0]).name
    arguments = sys.argv[1:]
    if name == "ssh":
        return ssh(arguments)
    if name != "sudo":
        raise RuntimeError("unexpected fixture executable")
    record("privileged", arguments)
    if arguments[0].startswith("--preserve-env="):
        return runner(arguments[1:])
    if arguments[0] == "sha256sum":
        print(hashlib.sha256((ROOT / "runner").read_bytes()).hexdigest() + "  " + arguments[1])
        return 0
    if arguments[0] == "systemd-run":
        return systemd_run(arguments[1:])
    if arguments[0] == "systemctl":
        return systemctl(arguments[1:])
    raise RuntimeError("unsupported fixture privileged command")


if __name__ == "__main__":
    sys.exit(main())
