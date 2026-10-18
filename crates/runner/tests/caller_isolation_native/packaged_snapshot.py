"""Owned Firecracker snapshot/restore experiment, never a production launcher."""

import contextlib
import hashlib
import http.client
import json
import os
import selectors
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

READY = b"PACKAGED_SNAPSHOT_READY"
SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
HERE = Path(__file__).resolve().parent


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.host)


def api(path, route, body, timeout=20, method="PUT"):
    with contextlib.closing(UnixHTTP(str(path), timeout=timeout)) as client:
        client.request(
            method, route, json.dumps(body), {"Content-Type": "application/json"}
        )
        response = client.getresponse()
        data = response.read(65537)
        if response.status != 204 or len(data) > 65536:
            raise ValueError(f"snapshot API {route}: {response.status} {data[:512]!r}")


def ready(path):
    deadline = time.monotonic() + 5
    while True:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            try:
                peer.connect(str(path))
            except (FileNotFoundError, ConnectionRefusedError):
                pass
            else:
                return
        if time.monotonic() >= deadline:
            raise TimeoutError("owned snapshot API readiness")
        time.sleep(0.01)


@contextlib.contextmanager
def owned(command, receipt):
    child = None
    mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    observed = {"cleanup": "not_started"}
    receipt["processes"].append(observed)
    try:
        child = subprocess.Popen(
            [
                sys.executable,
                str(HERE / "packaged_fence.py"),
                str(os.getpid()),
                json.dumps(sorted(mask)),
                *command,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        observed.update(pid=child.pid, cleanup="running")
        signal.pthread_sigmask(signal.SIG_SETMASK, mask)
        yield child
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
        try:
            if child is not None:
                if child.poll() is None:
                    child.kill()
                child.wait(timeout=5)
                with contextlib.suppress(BrokenPipeError):
                    child.stdin.close()
                child.stdout.close()
                observed.update(cleanup="joined", exit=child.returncode)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)


def stream(child, *, barrier=False):
    pending = b""
    deadline = time.monotonic() + 180
    with selectors.DefaultSelector() as poll:
        poll.register(child.stdout, selectors.EVENT_READ)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not poll.select(remaining):
                raise TimeoutError("snapshot Guest output deadline")
            data = os.read(child.stdout.fileno(), 16384)
            if not data:
                if barrier:
                    raise ValueError("Guest exited before snapshot barrier")
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            pending = (pending + data)[-32768:]
            if barrier and READY in pending.splitlines():
                return
    child.wait(timeout=5)
    if child.returncode:
        raise ValueError(f"restored VMM exit {child.returncode}")


def identity(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def run(out):
    receipt = {"schemaVersion": 1, "result": "failed", "processes": []}

    def interrupted(number, _frame):
        raise InterruptedError(number)

    previous = {s: signal.signal(s, interrupted) for s in SIGNALS}
    first, second = out / "fresh.api", out / "restored.api"
    state, memory = out / "snapshot.state", out / "snapshot.memory"
    try:
        with owned(
            [
                str(out / "firecracker"),
                "--api-sock",
                str(first),
                "--config-file",
                str(out / "vm.json"),
            ],
            receipt,
        ) as child:
            stream(child, barrier=True)
            ready(first)
            api(first, "/vm", {"state": "Paused"}, method="PATCH")
            api(
                first,
                "/snapshot/create",
                {
                    "snapshot_type": "Full",
                    "snapshot_path": str(state),
                    "mem_file_path": str(memory),
                },
            )
        receipt["snapshot"] = {"state": identity(state), "memory": identity(memory)}
        with owned(
            [str(out / "firecracker"), "--api-sock", str(second)], receipt
        ) as child:
            ready(second)
            api(
                second,
                "/snapshot/load",
                {
                    "snapshot_path": str(state),
                    "mem_backend": {
                        "backend_type": "File",
                        "backend_path": str(memory),
                    },
                    "resume_vm": False,
                },
            )
            api(second, "/vm", {"state": "Resumed"}, method="PATCH")
            child.stdin.write(b"restored\n")
            child.stdin.flush()
            stream(child)
        receipt["result"] = "restored_and_joined"
    except BaseException as error:
        receipt["error"] = str(error)
        raise
    finally:
        (out / "snapshot-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    run(Path(sys.argv[1]))
