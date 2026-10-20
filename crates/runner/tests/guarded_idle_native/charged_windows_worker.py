"""Fixed, bounded disposable workload for charged-window qualification only."""

import ctypes
import gc
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

MIB = 1024 * 1024


class WorkerCancelled(Exception):
    """Keep cancellation distinct from subprocess selector EINTR retries."""


def identity():
    return {
        "pid": os.getpid(),
        "start_ticks": int(
            Path("/proc/self/stat").read_bytes().rsplit(b")", 1)[1].split()[19]
        ),
        "cgroup": Path("/proc/self/cgroup").read_text().strip(),
    }


def emit(value):
    print(json.dumps(value), flush=True)


def touch(size):
    data = bytearray(size)
    for offset in range(0, size, 4096):
        data[offset] = 1
    return data


def stop(_signum, _frame):
    raise WorkerCancelled("owned worker cancelled")


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "transient":
        data = touch(16 * MIB)
        emit({"identity": identity(), "touched_bytes": len(data)})
        return
    root = Path(sys.argv[1])
    signal.signal(signal.SIGTERM, stop)
    emit({"ready": identity()})
    data = None
    for line in sys.stdin:
        command = line.strip()
        result = {"completed": command}
        if command == "allocate":
            if data is not None:
                raise ValueError("owned allocation is already held")
            data = touch(32 * MIB)
            result["held_bytes"] = len(data)
        elif command == "release":
            if data is None:
                raise ValueError("original owned allocation is missing")
            result["released_bytes"] = len(data)
            data = None
            gc.collect()
            ctypes.CDLL(None).malloc_trim(0)
        elif command == "transient":
            child = subprocess.run(
                [sys.executable, "-B", str(Path(__file__).resolve()), "transient"],
                capture_output=True,
                timeout=8,
                check=True,
            )
            result["child"] = json.loads(child.stdout)
            result["child_exit_code"] = child.returncode
            result["child_wait_confirmed"] = True
        elif command == "file":
            with (root / "retained.bin").open("xb", buffering=0) as handle:
                chunk = b"T" * MIB
                for _ in range(64):
                    if handle.write(chunk) != len(chunk):
                        raise OSError("short owned file write")
                os.fsync(handle.fileno())
                result["file"] = {
                    "device": os.fstat(handle.fileno()).st_dev,
                    "inode": os.fstat(handle.fileno()).st_ino,
                    "bytes": os.fstat(handle.fileno()).st_size,
                }
        elif command != "exit":
            raise ValueError("unsupported qualification command")
        emit(result)
        if command == "exit":
            return
    raise ValueError("qualification input ended before exit")


if __name__ == "__main__":
    main()
