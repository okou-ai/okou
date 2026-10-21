"""Bounded warm-file qualification of original-FD residency acquisition."""

import argparse
import ctypes
import hashlib
import json
import mmap
import os
from pathlib import Path
import platform
import sys
import time
import uuid

from file_residency import (
    CLAIMS,
    FileResidency,
    LIBC,
    MAP_FAILED,
    MAX_EXTENT_BYTES,
    metadata,
    require,
)

SOURCES = ("file_residency.py", "file_residency_probe.py", "file_residency_report.py")
BOUNDS = {
    "max_extent_bytes": MAX_EXTENT_BYTES,
    "max_locked_bytes": 65536,
    "max_events": 4,
    "duration_seconds": 30,
}
LIBC.mlock.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
LIBC.mlock.restype = ctypes.c_int
LIBC.munlock.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
LIBC.munlock.restype = ctypes.c_int


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def write_all(fd, raw):
    while raw:
        count = os.write(fd, raw)
        require(count > 0, "original write made no progress")
        raw = raw[count:]


def locked_observation(fd, owner, offset, length, mappings):
    size = os.fstat(fd).st_size
    require(
        ((size + owner.page_size - 1) // owner.page_size) * owner.page_size
        <= BOUNDS["max_locked_bytes"],
        "qualification lock exceeds bound",
    )
    address = LIBC.mmap(None, size, mmap.PROT_READ, mmap.MAP_SHARED, fd, 0)
    if address == MAP_FAILED:
        raise OSError(ctypes.get_errno(), "qualification mmap")
    mapping = (address, size)
    mappings.append(mapping)
    locked = False
    try:
        if LIBC.mlock(address, size) != 0:
            raise OSError(ctypes.get_errno(), "qualification mlock")
        locked = True
        value = owner.observe(offset, length)
        require(
            all(bytes.fromhex(value["resident_vector_hex"])),
            "locked original page was not resident",
        )
    finally:
        # Keep ownership until each actual successful release; a release error
        # is a failed qualification and leaves the process-owned mapping live.
        unlock_error = (
            ctypes.get_errno() if locked and LIBC.munlock(address, size) != 0 else None
        )
        if LIBC.munmap(address, size) != 0:
            raise OSError(ctypes.get_errno(), "qualification munmap")
        mappings.remove(mapping)
        if unlock_error is not None:
            raise OSError(unlock_error, "qualification munlock")
    return value


def qualify(output):
    output = Path(output)
    require(
        output.is_absolute() and output.parent.resolve(strict=True) == output.parent,
        "output parent must be canonical",
    )
    output.mkdir(mode=0o700)
    invocation = str(uuid.uuid4())
    started = time.monotonic_ns()
    value = {
        "format": "owned-file-residency-qualification-v1",
        "invocation": invocation,
        "started_monotonic_ns": started,
        "started_unix_ns": time.time_ns(),
        "host": {
            "kernel_release": platform.release(),
            "architecture": platform.machine(),
            "effective_uid": os.geteuid(),
            "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        },
        "bounds": BOUNDS,
        "claims": CLAIMS,
        "error": None,
        "cleanup_complete": False,
    }
    events = []
    fd = None
    owner = None
    mappings = []
    try:
        sources = {}
        for name in SOURCES:
            raw = (Path(__file__).resolve().parent / name).read_bytes()
            require(len(raw) <= 65536, "oversized runtime source")
            with (output / name).open("xb") as stream:
                stream.write(raw)
            sources[name] = digest(raw)
        value["sources"] = sources
        value["source_sha256"] = digest(canonical(sources))
        page = os.sysconf("SC_PAGESIZE")
        require(
            4 * page <= BOUNDS["max_locked_bytes"],
            "unsupported qualification page size",
        )
        value["page_size"] = page
        value["descriptor_count_before"] = len(os.listdir("/proc/self/fd"))
        path = output / "image.bin"
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        initial = b"a" * (2 * page + 3)
        write_all(fd, initial)
        os.fsync(fd)
        original = metadata(fd)
        value["original_identity"] = {key: original[key] for key in ("device", "inode")}
        owner = FileResidency(fd, (original["device"], original["inode"]))

        def observe(label, offset, length):
            require(
                time.monotonic_ns() - started <= BOUNDS["duration_seconds"] * 10**9,
                "qualification deadline",
            )
            result = locked_observation(fd, owner, offset, length, mappings)
            events.append(
                {
                    "label": label,
                    "invocation": invocation,
                    "source_sha256": value["source_sha256"],
                    **result,
                }
            )

        observe("initial-offset", page, page + 3)
        path.rename(output / "original-link.bin")
        with path.open("xb") as stream:
            stream.write(b"replacement")
        replacement = path.stat()
        require(
            (replacement.st_dev, replacement.st_ino)
            != (original["device"], original["inode"]),
            "replacement reused original identity",
        )
        value["replacement_identity"] = {
            "device": replacement.st_dev,
            "inode": replacement.st_ino,
        }
        observe("path-replaced", 0, len(initial))
        (output / "original-link.bin").unlink()
        observe("original-unlinked", 0, len(initial))
        os.lseek(fd, 0, os.SEEK_END)
        write_all(fd, b"b" * page)
        os.fsync(fd)
        observe("original-grown", 0, len(initial) + page)
        value["observer"] = events[0]["observer"]
        payload = os.pread(fd, len(initial) + page, 0)
        require(payload == initial + b"b" * page, "original complete payload changed")
        with (output / "original.bin").open("xb") as stream:
            stream.write(payload)
        value["original_payload"] = {
            "file": "original.bin",
            "size": len(payload),
            "sha256": digest(payload),
        }
        value["replacement_payload"] = {
            "file": "image.bin",
            "size": 11,
            "sha256": digest(b"replacement"),
        }
    except BaseException as error:
        value["error"] = f"{type(error).__name__}: {error}"
    finally:
        cleanup_errors = []
        for mapping in list(mappings):
            if LIBC.munmap(*mapping) != 0:
                cleanup_errors.append(
                    f"qualification mapping: errno {ctypes.get_errno()}"
                )
            else:
                mappings.remove(mapping)
        if owner is not None:
            try:
                owner.close()
            except BaseException as error:
                cleanup_errors.append(
                    f"original descriptor: {type(error).__name__}: {error}"
                )
        if fd is not None:
            try:
                os.close(fd)
            except OSError as error:
                cleanup_errors.append(f"caller descriptor: {error}")
        value["descriptor_count_after"] = len(os.listdir("/proc/self/fd"))
        value["cleanup_errors"] = cleanup_errors
        value["remaining_qualification_mappings"] = len(mappings)
        value["cleanup_complete"] = (
            not cleanup_errors
            and not mappings
            and value["descriptor_count_after"] == value.get("descriptor_count_before")
        )
        value["completed_monotonic_ns"] = time.monotonic_ns()
        value["completed_unix_ns"] = time.time_ns()
        raw = b"".join(canonical(event) + b"\n" for event in events)
        with (output / "events.jsonl").open("xb") as stream:
            stream.write(raw)
        value["event_count"] = len(events)
        value["events_sha256"] = digest(raw)
        with (output / "capture.json").open("x") as stream:
            json.dump(value, stream, indent=2)
    require(
        value["error"] is None and value["cleanup_complete"],
        "qualification failed; retain capture.json",
    )
    from file_residency_report import replay

    return replay(output, invocation, value["source_sha256"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(qualify(args.output), sort_keys=True))
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
