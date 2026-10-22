"""Stream a bounded original inherited FD; no payload reads during acquisition."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import time
import uuid

from file_residency import (
    CLAIMS,
    FileResidency,
    MAX_EXTENT_BYTES,
    MAX_SCAN_BYTES,
    MAX_SCAN_DURATION_NS,
    metadata,
    require,
)
from file_residency_report import hash_value, read_regular

SOURCES = (
    "file_residency.py",
    "file_residency_scan.py",
    "file_residency_scan_report.py",
    "file_residency_report.py",
)
BOUNDS = {
    "max_extent_bytes": MAX_EXTENT_BYTES,
    "max_scan_bytes": MAX_SCAN_BYTES,
    "max_duration_ns": MAX_SCAN_DURATION_NS,
}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def source_bundle():
    root = Path(__file__).resolve().parent
    raw = {name: read_regular(root, name, 65536) for name in SOURCES}
    hashes = {name: digest(value) for name, value in raw.items()}
    return (
        raw,
        hashes,
        digest(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()),
    )


def acquire(
    output,
    fd,
    expected_identity,
    invocation,
    source_sha256,
    original_sha256,
    maximum_bytes,
    maximum_duration_ns,
):
    require(str(uuid.UUID(invocation)) == invocation, "invalid invocation")
    hash_value(source_sha256)
    hash_value(original_sha256)
    require(
        type(maximum_bytes) is int
        and 0 <= maximum_bytes <= MAX_SCAN_BYTES
        and type(maximum_duration_ns) is int
        and 0 < maximum_duration_ns <= MAX_SCAN_DURATION_NS,
        "invalid declared scan budgets",
    )
    root = Path(output)
    require(
        root.is_absolute() and root.parent.resolve(strict=True) == root.parent,
        "output parent must be canonical",
    )
    root.mkdir(mode=0o700)
    capture = {
        "format": "original-file-range-capture-v1",
        "invocation": invocation,
        "source_sha256": source_sha256,
        "original_sha256": original_sha256,
        "original_identity": {
            "device": expected_identity[0],
            "inode": expected_identity[1],
        },
        "maximum_bytes": maximum_bytes,
        "maximum_duration_ns": maximum_duration_ns,
        "bounds": BOUNDS,
        "claims": dict(CLAIMS),
        "host": {
            "kernel_release": platform.release(),
            "architecture": platform.machine(),
            "effective_uid": os.geteuid(),
            "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        },
        "started_monotonic_ns": time.monotonic_ns(),
        "started_unix_ns": time.time_ns(),
        "descriptor_count_before": len(os.listdir("/proc/self/fd")),
        "sources": {},
        "original_metadata": None,
        "summary": None,
        "event_count": 0,
        "error": None,
        "cleanup_errors": [],
        "cleanup_complete": False,
    }
    owner = None
    owner_closed = False
    writer = None
    writer_closed = False
    summary = None
    event_hash = hashlib.sha256()
    try:
        raw, hashes, actual = source_bundle()
        require(actual == source_sha256, "runtime source bundle mismatch")
        capture["sources"] = hashes
        for name, content in raw.items():
            with (root / name).open("xb") as stream:
                stream.write(content)
        capture["original_metadata"] = metadata(fd)
        owner = FileResidency(fd, expected_identity)
        writer = (root / "events.jsonl").open("xb")

        def emit(point):
            raw = (
                json.dumps(
                    {"invocation": invocation, "source_sha256": source_sha256, **point},
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
                + b"\n"
            )
            require(len(raw) <= 65536, "oversized original extent record")
            writer.write(raw)
            writer.flush()
            os.fsync(writer.fileno())
            event_hash.update(raw)
            capture["event_count"] += 1

        summary = owner.scan(maximum_bytes, maximum_duration_ns, emit)
        require(
            summary["before"] == capture["original_metadata"],
            "original changed before range acquisition",
        )
    except BaseException as error:
        capture["error"] = f"{type(error).__name__}: {error}"
    finally:
        if writer is not None:
            try:
                writer.close()
                writer_closed = True
            except BaseException as error:
                capture["cleanup_errors"].append(
                    f"writer {type(error).__name__}: {error}"
                )
        if owner is not None and not owner_closed:
            try:
                owner.close()
                owner_closed = True
            except BaseException as error:
                capture["cleanup_errors"].append(f"{type(error).__name__}: {error}")
        capture["descriptor_count_after"] = len(os.listdir("/proc/self/fd"))
        capture["cleanup_complete"] = (
            (owner is None or owner_closed)
            and not capture["cleanup_errors"]
            and (writer is None or writer_closed)
            and capture["descriptor_count_before"] == capture["descriptor_count_after"]
        )
        if capture["error"] is None and capture["cleanup_complete"]:
            capture["summary"] = summary
        capture["events_sha256"] = event_hash.hexdigest()
        capture["completed_monotonic_ns"] = time.monotonic_ns()
        capture["completed_unix_ns"] = time.time_ns()
        raw = json.dumps(capture, sort_keys=True, indent=2).encode() + b"\n"
        with (root / "capture.json").open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    return capture, digest(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--fd", type=int, required=True)
    parser.add_argument("--device", type=int, required=True)
    parser.add_argument("--inode", type=int, required=True)
    parser.add_argument("--invocation", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--original-sha256", required=True)
    parser.add_argument("--maximum-bytes", type=int, required=True)
    parser.add_argument("--maximum-duration-ns", type=int, required=True)
    args = parser.parse_args()
    try:
        capture, seal = acquire(
            args.output,
            args.fd,
            (args.device, args.inode),
            args.invocation,
            args.source_sha256,
            args.original_sha256,
            args.maximum_bytes,
            args.maximum_duration_ns,
        )
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    success = capture["error"] is None and capture["cleanup_complete"]
    print(
        json.dumps(
            {
                "invocation": args.invocation,
                "source_sha256": args.source_sha256,
                "capture_sha256": seal,
                "events_sha256": capture["events_sha256"],
                "extent_count": capture["event_count"],
                "complete": success,
                "error": capture["error"],
                "cleanup_complete": capture["cleanup_complete"],
            },
            sort_keys=True,
        )
    )
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
