#!/usr/bin/env python3
"""External SSH/systemd/privileged-runner fixture; internal image code stays real."""

import contextlib
import fnmatch
import hashlib
import json
import os
import re
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
    except (FileNotFoundError, ProcessLookupError):
        # procfs can return ESRCH if the task exits between opening and reading.
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
    state_root = ROOT / "missing" if MODE == "missing-state-root" else ROOT
    arguments = ["TMPDIR=" + str(state_root) if a == "TMPDIR=/dev/shm" else a for a in arguments]
    process = subprocess.Popen(
        ["bash", "-c", " ".join(arguments[1:])],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        start_new_session=True,
    )
    detached = False
    try:
        process.stdin.write(json.dumps(request).encode())
        process.stdin.close()
        if MODE == "claim-commit-loss" and request["action"] == "claim" and once():
            wait_for(lambda: (ROOT / "claim-resource-created").exists())
            (ROOT / "claim-cut").touch()
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            return 255
        fault = request["action"] == "run" and request["phase"] == "build"
        if fault and MODE == "contended-launch":
            gate = (
                ROOT
                / ("vm0-runner-image-" + str(os.getuid()))
                / request["inputs"]["jobRef"]
                / "gate"
            )

            def gate_opened():
                for descriptor in Path(f"/proc/{process.pid}/fd").iterdir():
                    with contextlib.suppress(FileNotFoundError, ProcessLookupError):
                        if descriptor.readlink() == gate:
                            return True
                return False

            wait_for(gate_opened)
            if once():
                record("detached-servers", process.pid)
                detached = True
                return 255
            # Both requests have checked for intent and opened the contended
            # gate. Pause the observer so the original request starts first.
            os.kill(process.pid, signal.SIGSTOP)
            (ROOT / "observer-paused").touch()
            wait_for(lambda: (ROOT / "resume-observer").exists())
            os.kill(process.pid, signal.SIGCONT)
        if fault and MODE == "pending-launch" and once():
            wait_for(lambda: (ROOT / "launch-pending").exists())
            record("detached-servers", process.pid)
            detached = True
            return 255
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
        if not detached and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        if not detached:
            process.wait()


def systemd_run(arguments):
    record("systemd", arguments)
    if any(argument.startswith("--on-active=") for argument in arguments):
        if MODE == "pending-launch":
            (ROOT / "launch-pending").touch()
            wait_for(lambda: (ROOT / "release-launch").exists())
        return 0  # Record the real retention contract without waiting one hour.
    unit = next(
        argument.split("=", 1)[1] for argument in arguments if argument.startswith("--unit=")
    )
    command = arguments[arguments.index("/usr/bin/python3") :]
    if MODE == "absent-launch":
        return 1
    with open(os.devnull, "wb") as sink:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=sink,
            stderr=sink,
            start_new_session=True,
        )
    path = ROOT / "units" / (unit + ".json")
    temporary = path.with_suffix(".tmp")
    description = next(
        (a.split("=", 1)[1] for a in arguments if a.startswith("--description=")), ""
    )
    temporary.write_text(json.dumps({"pid": process.pid, "description": description}))
    temporary.replace(path)
    return 0


def systemctl(arguments):
    if arguments[0] == "list-units":
        patterns = [a for a in arguments[1:] if not a.startswith("-")]
        for path in sorted((ROOT / "units").glob("*.json")):
            name = path.name.removesuffix(".json")
            if any(fnmatch.fnmatch(name, pattern) for pattern in patterns):
                print(name + " loaded active running Image fixture")
        return 0
    if arguments[0] == "show":
        for unit in (a for a in arguments[1:] if a.endswith(".service")):
            path = ROOT / "units" / (unit + ".json")
            info = json.loads(path.read_text()) if path.exists() else {}
            running = bool(info) and alive(info["pid"])
            paused = ROOT / "active-observation-paused"
            if MODE == "pause-active-observation" and running and not paused.exists():
                # Hold an already captured active snapshot while the real
                # worker finishes and a separate request cancels its owner.
                paused.touch()
                wait_for(lambda: (ROOT / "resume-active-observation").exists())
            if not info and MODE == "pending-launch" and (ROOT / "launch-pending").exists():
                (ROOT / "observed-pending-launch").touch()
            fields = {
                "Id": unit,
                "LoadState": "loaded" if info else "not-found",
                "ActiveState": "active" if running else "inactive",
                "MainPID": str(info["pid"]) if running else "0",
                "Job": "",
                "ControlGroup": "/" if MODE == "populated-cgroup" else "",
                "FragmentPath": "",
                "Description": info.get("description", ""),
            }
            print("\n".join(key + "=" + value for key, value in fields.items()) + "\n")
        return 0
    if arguments[0] == "stop":
        if MODE == "failed-stop":
            return 1
        for unit in (a for a in arguments[1:] if a.endswith(".service")):
            path = ROOT / "units" / (unit + ".json")
            if path.exists():
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(json.loads(path.read_text())["pid"], signal.SIGKILL)
            record("stops", unit)
        return 0
    if arguments[0] in ("disable", "reset-failed", "daemon-reload"):
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
    if name == "systemctl":
        return systemctl(arguments)
    if name != "sudo":
        raise RuntimeError("unexpected fixture executable")
    record("privileged", arguments)
    if arguments[:2] == ["python3", "-c"] and arguments[3:4] == ["image-lifecycle-lock"]:
        if len(arguments) != 5 or not re.fullmatch(
            r"/var/lock/vm0-runner-lifecycle-(pr-[1-9][0-9]*|staging-[a-f0-9]{12})\.lock",
            arguments[4],
        ):
            raise RuntimeError("invalid fixture lifecycle lock")
        path = ROOT / arguments[4].lstrip("/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
        path.chmod(0o644)
        print(path)
        return 0
    if arguments[:2] == ["realpath", "-e"] or arguments[:4] in (
        ["install", "-d", "-m", "755"],
        ["install", "-m", "600", "/dev/null"],
    ):
        if len(arguments) != (5 if arguments[0] == "install" else 3):
            raise RuntimeError("invalid fixture filesystem command")
        path = Path(arguments[-1])
        if path.is_relative_to("/var/lib/vm0-runner/bin"):
            path = ROOT / str(path).lstrip("/")
        if not path.is_relative_to(ROOT / "var/lib/vm0-runner/bin"):
            raise RuntimeError("fixture filesystem command outside image namespace")
        # Keep coreutils creation/permission semantics real in this namespace.
        status = subprocess.call([*arguments[:-1], str(path)])
        if (
            status == 0
            and arguments[:4] == ["install", "-m", "600", "/dev/null"]
            and MODE == "claim-commit-loss"
            and not (ROOT / "claim-cut").exists()
        ):
            (ROOT / "claim-resource-created").touch()
            wait_for(lambda: (ROOT / "release-claim-resource").exists())
        return status
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

    def report_error(kind, value, traceback):
        record(
            "errors",
            {
                "executable": Path(sys.argv[0]).name,
                "type": kind.__name__,
                "message": str(value),
            },
        )
        sys.__excepthook__(kind, value, traceback)

    sys.excepthook = report_error
    sys.exit(main())
