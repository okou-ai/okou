#!/usr/bin/env python3
"""Bounded, read-only cache allocation gauges, independent of Runner binaries."""

import os
import stat
import time
import uuid
from pathlib import Path

PREFIX = "vm0_home_image_cache_"
DEFAULT_CACHE_DIR = "/var/lib/vm0-runner/home-image-cache"
DEFAULT_TEXTFILE_DIR = "/var/lib/vm0-monitoring/textfile-collector"
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
MAX_ENTRIES = 1024
MAX_PATHS = 32768
MAX_DEPTH = 32
TIMEOUT_SECONDS = 15
MIB = 1024 * 1024
BUCKETS = (
    ("lt_16MiB", 16 * MIB),
    ("16MiB_64MiB", 64 * MIB),
    ("64MiB_256MiB", 256 * MIB),
    ("256MiB_1GiB", 1024 * MIB),
    ("1GiB_4GiB", 4096 * MIB),
    ("4GiB_16GiB", 16384 * MIB),
    ("gte_16GiB", None),
)


class BudgetReached(Exception):
    pass


class Scan:
    def __init__(self, device):
        self.device = device
        self.remaining = MAX_PATHS
        self.deadline = time.monotonic() + TIMEOUT_SECONDS
        self.seen = set()

    def next(self, entries):
        if self.remaining <= 0 or time.monotonic() >= self.deadline:
            raise BudgetReached
        entry = next(entries, None)
        if entry is not None:
            self.remaining -= 1
        return entry

    def allocated(self, metadata):
        identity = (metadata.st_dev, metadata.st_ino)
        if identity in self.seen:
            return 0
        self.seen.add(identity)
        return metadata.st_blocks * 512

    def walk(self, directory, depth=0):
        before = os.fstat(directory)
        allocated = self.allocated(before)
        complete = True
        with os.scandir(directory) as entries:
            while True:
                try:
                    entry = self.next(entries)
                except BudgetReached:
                    complete = False
                    break
                if entry is None:
                    break
                try:
                    metadata = entry.stat(follow_symlinks=False)
                    if metadata.st_dev != self.device:
                        complete = False
                    elif stat.S_ISDIR(metadata.st_mode):
                        if depth >= MAX_DEPTH:
                            allocated += self.allocated(metadata)
                            complete = False
                            continue
                        child = os.open(entry.name, DIRECTORY_FLAGS, dir_fd=directory)
                        try:
                            actual = os.fstat(child)
                            if (actual.st_dev, actual.st_ino) != (
                                metadata.st_dev,
                                metadata.st_ino,
                            ):
                                complete = False
                                continue
                            size, child_complete = self.walk(child, depth + 1)
                            allocated += size
                            complete = complete and child_complete
                        finally:
                            os.close(child)
                    else:
                        # Count each inode's allocation without opening file content
                        # or following symlinks and special files.
                        allocated += self.allocated(metadata)
                except OSError:
                    complete = False
        after = os.fstat(directory)
        complete = complete and before.st_mtime_ns == after.st_mtime_ns
        return allocated, complete


def open_directory(path):
    """Pin every component so a replaced ancestor cannot redirect the scan."""
    path = Path(path)
    directory = os.open("/" if path.is_absolute() else ".", DIRECTORY_FLAGS)
    try:
        for component in path.parts:
            if component == "/":
                continue
            child = os.open(component, DIRECTORY_FLAGS, dir_fd=directory)
            os.close(directory)
            directory = child
        return directory
    except BaseException:
        os.close(directory)
        raise


def gauge(name, value):
    return f"# TYPE {PREFIX}{name} gauge\n{PREFIX}{name} {value}\n"


def collect(cache_dir):
    root = open_directory(cache_dir)
    try:
        before = os.fstat(root)
        fs = os.fstatvfs(root)
        scan = Scan(before.st_dev)
        total_entries = 0
        total_allocated = 0
        entries_complete = True
        measurements_complete = True
        counts = [0] * len(BUCKETS)
        allocated = [0] * len(BUCKETS)
        with os.scandir(root) as entries:
            while True:
                try:
                    entry = scan.next(entries)
                except BudgetReached:
                    entries_complete = False
                    break
                if entry is None:
                    break
                if len(entry.name) != 64 or any(
                    c not in "0123456789abcdef" for c in entry.name
                ):
                    continue
                metadata = entry.stat(follow_symlinks=False)
                if not stat.S_ISDIR(metadata.st_mode):
                    continue
                if total_entries >= MAX_ENTRIES:
                    entries_complete = False
                    break
                total_entries += 1
                child = os.open(entry.name, DIRECTORY_FLAGS, dir_fd=root)
                try:
                    actual = os.fstat(child)
                    if (actual.st_dev, actual.st_ino) != (
                        metadata.st_dev,
                        metadata.st_ino,
                    ):
                        measurements_complete = False
                        continue
                    if actual.st_dev != before.st_dev:
                        measurements_complete = False
                        continue
                    size, complete = scan.walk(child)
                finally:
                    os.close(child)
                total_allocated += size
                measurements_complete = measurements_complete and complete
                if complete:
                    index = next(
                        i
                        for i, (_, bound) in enumerate(BUCKETS)
                        if bound is None or size < bound
                    )
                    counts[index] += 1
                    allocated[index] += size
        entries_complete = (
            entries_complete and before.st_mtime_ns == os.fstat(root).st_mtime_ns
        )
        complete = entries_complete and measurements_complete
        text = "".join(
            gauge(name, value)
            for name, value in {
                "snapshot_available": 1,
                "measurements_complete": int(complete),
                "entries_complete": int(entries_complete),
                "allocation_lower_bound": int(not complete),
                "bucket_measurements_complete": int(complete),
                "entries": total_entries,
                "allocated_bytes": total_allocated,
                "filesystem_total_bytes": fs.f_blocks * fs.f_frsize,
                "filesystem_available_bytes": fs.f_bavail * fs.f_frsize,
                "filesystem_total_inodes": fs.f_files,
                "filesystem_available_inodes": fs.f_favail,
            }.items()
        )
        for name, values in (
            ("bucket_entries", counts),
            ("bucket_allocated_bytes", allocated),
        ):
            text += f"# TYPE {PREFIX}{name} gauge\n"
            for (label, _), value in zip(BUCKETS, values, strict=True):
                text += f'{PREFIX}{name}{{bucket="{label}"}} {value}\n'
        return text
    finally:
        os.close(root)


def publish(directory, text):
    fd = open_directory(directory)
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
            # Atomic replacement already consumed the temporary name.
            pass
        finally:
            os.close(fd)


def main():
    cache_dir = os.environ.get("OKOU_HOME_IMAGE_CACHE_DIR") or DEFAULT_CACHE_DIR
    textfile_dir = (
        os.environ.get("OKOU_MONITORING_TEXTFILE_DIR") or DEFAULT_TEXTFILE_DIR
    )
    try:
        text = collect(cache_dir)
    except (OSError, ValueError):
        # Unavailable observations replace stale success, without invented bytes.
        text = "".join(
            gauge(name, 0)
            for name in (
                "snapshot_available",
                "measurements_complete",
                "entries_complete",
                "bucket_measurements_complete",
            )
        )
    text += gauge("collection_timestamp_seconds", int(time.time()))
    publish(textfile_dir, text)


if __name__ == "__main__":
    main()
