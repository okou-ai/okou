#!/usr/bin/env python3
"""Fixed-label gauges from the canonical Runner snapshot; never inspect cache files."""

import argparse
import json
import os
import signal
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

MAX_OUTPUT_BYTES = 4 * 1024 * 1024
TIMEOUT_SECONDS = 15
MAX_ENTRIES = 1024
PREFIX = "vm0_home_image_cache_"
MIB = 1024 * 1024
BUCKETS = (
    ("lt_16MiB", 16 * MIB),
    ("16MiB_64MiB", 64 * MIB),
    ("64MiB_256MiB", 256 * MIB),
    ("256MiB_1GiB", 1024 * MIB),
    ("1GiB_4GiB", 4096 * MIB),
    ("4GiB_16GiB", 16384 * MIB),
    ("gte_16GiB", 1 << 64),
)
STATUSES = {
    "reusable": "reusableEntries",
    "invalid": "invalidEntries",
    "stale": "staleEntries",
    "temporaryOnly": "temporaryEntries",
    "locked": "lockedEntries",
}


def counter(value):
    if type(value) is not int or not 0 <= value <= (1 << 64) - 1:
        raise ValueError("invalid counter")
    return value


def gauges(snapshot):
    """Schema failures are unavailable, including an old Runner's JSON shape."""
    summary = snapshot["summary"]
    fs = snapshot["fsStats"]
    budget = snapshot["budget"]
    entries = snapshot["entries"]
    complete = snapshot["measurementsComplete"]
    entries_complete = snapshot["entriesComplete"]
    if type(complete) is not bool or type(entries_complete) is not bool:
        raise ValueError("invalid completeness")
    if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
        raise ValueError("invalid entries")
    total = counter(summary["totalEntries"])
    locked = counter(summary["lockedEntries"])
    if complete != (locked == 0) or entries_complete != (len(entries) == total):
        raise ValueError("inconsistent completeness")
    if (
        len(entries) != min(total, MAX_ENTRIES)
        or sum(counter(summary[key]) for key in STATUSES.values()) != total
    ):
        raise ValueError("inconsistent counts")
    for entry in entries:
        if entry["status"] not in STATUSES:
            raise ValueError("invalid status")
        # Locked placeholders are not measurements. Do not export per-entry IDs.
        if entry["status"] != "locked":
            for key in (
                "allocatedBytes",
                "logicalImageSizeBytes",
                "temporaryAllocatedBytes",
            ):
                counter(entry[key])
    total_bytes = counter(fs["totalBytes"])
    available_bytes = counter(fs["availableBytes"])
    total_inodes = counter(fs["totalInodes"])
    available_inodes = counter(fs["availableInodes"])
    if available_bytes > total_bytes or available_inodes > total_inodes:
        raise ValueError("impossible filesystem stats")
    metrics = {
        "snapshot_available": 1,
        "measurements_complete": int(complete),
        "entries_complete": int(entries_complete),
        "allocation_lower_bound": int(not complete),
        "bucket_measurements_complete": int(complete and entries_complete),
        "entries": total,
        "allocated_bytes": counter(summary["totalAllocatedBytes"]),
        "logical_bytes": counter(summary["totalLogicalImageBytes"]),
        "temporary_allocated_bytes": counter(summary["temporaryAllocatedBytes"]),
        "temporary_paths": counter(summary["temporaryPaths"]),
        "filesystem_total_bytes": total_bytes,
        "filesystem_available_bytes": available_bytes,
        "filesystem_total_inodes": total_inodes,
        "filesystem_available_inodes": available_inodes,
        "budget_max_bytes": counter(budget["maxCacheBytes"]),
        "budget_target_after_gc_bytes": counter(budget["targetAfterGcBytes"]),
        "budget_min_free_bytes": counter(budget["minFreeBytes"]),
    }
    if metrics["temporary_allocated_bytes"] > metrics["allocated_bytes"]:
        raise ValueError("inconsistent allocation")
    lines = [
        f"# TYPE {PREFIX}{name} gauge\n{PREFIX}{name} {value}\n"
        for name, value in metrics.items()
    ]
    lines.append(f"# TYPE {PREFIX}entries_by_status gauge\n")
    for status, key in STATUSES.items():
        lines.append(
            f'{PREFIX}entries_by_status{{status="{status}"}} {counter(summary[key])}\n'
        )
    # Fixed buckets cover measured entry allocation, including its staging bytes,
    # not a guessed current.ext4 or the sparse image's logical length.
    counts = [0] * len(BUCKETS)
    allocated = [0] * len(BUCKETS)
    for entry in entries:
        if entry["status"] == "locked":
            continue
        size = counter(
            counter(entry["allocatedBytes"]) + counter(entry["temporaryAllocatedBytes"])
        )
        index = next(index for index, (_, bound) in enumerate(BUCKETS) if size < bound)
        counts[index] += 1
        allocated[index] += size
    for name, values in (
        ("bucket_entries", counts),
        ("bucket_allocated_bytes", allocated),
    ):
        lines.append(f"# TYPE {PREFIX}{name} gauge\n")
        for (label, _), value in zip(BUCKETS, values, strict=True):
            lines.append(f'{PREFIX}{name}{{bucket="{label}"}} {counter(value)}\n')
    return "".join(lines)


def read_snapshot(runner):
    # Native subprocess output is file-backed, never an unbounded communicate buffer.
    with (
        tempfile.TemporaryFile() as output,
        subprocess.Popen(
            [runner, "home-image-cache", "list", "--limit", str(MAX_ENTRIES), "--json"],
            stdout=output,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        ) as process,
    ):
        try:
            deadline = time.monotonic() + TIMEOUT_SECONDS
            while process.poll() is None:
                if (
                    os.fstat(output.fileno()).st_size > MAX_OUTPUT_BYTES
                    or time.monotonic() >= deadline
                ):
                    raise ValueError("producer exceeded budget")
                time.sleep(0.05)
            if (
                process.returncode != 0
                or os.fstat(output.fileno()).st_size > MAX_OUTPUT_BYTES
            ):
                raise ValueError("producer unavailable")
            output.seek(0)
            return json.loads(output.read(MAX_OUTPUT_BYTES + 1))
        finally:
            # Also retire descendants that outlive their process leader.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                # The producer's process group no longer exists.
                pass
            process.wait()


def publish(directory, text):
    # Pin the textfile directory; never follow an attacker-replaced destination.
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    name = f".home-image-cache.{uuid.uuid4().hex}.tmp"
    try:
        metadata = os.fstat(fd)
        if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
            raise ValueError("unsafe textfile directory")
        file_fd = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o644,
            dir_fd=fd,
        )
        with os.fdopen(file_fd, "w") as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, "home-image-cache.prom", src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            # No temporary file remains, including after atomic replacement.
            pass
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner", required=True)
    parser.add_argument(
        "--textfile-dir", default="/var/lib/vm0-monitoring/textfile-collector"
    )
    args = parser.parse_args()
    text = "".join(
        f"# TYPE {PREFIX}{name} gauge\n{PREFIX}{name} 0\n"
        for name in (
            "snapshot_available",
            "measurements_complete",
            "entries_complete",
            "bucket_measurements_complete",
        )
    )
    try:
        if not Path(args.runner).is_absolute():
            raise ValueError("Runner path must be absolute")
        text = gauges(read_snapshot(args.runner))
    except (OSError, ValueError, KeyError, TypeError, OverflowError, RecursionError):
        # Replace old successful metrics, not a stale-success or measured-empty result.
        pass
    text += f"# TYPE {PREFIX}collection_timestamp_seconds gauge\n{PREFIX}collection_timestamp_seconds {int(time.time())}\n"
    publish(args.textfile_dir, text)


if __name__ == "__main__":
    main()
