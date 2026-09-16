"""Read-only, bounded allocated-byte observations for fixed guest directories."""

import argparse
import errno
import os
import stat
import time

TARGETS = (
    "/tmp",
    "/home/user/.pi",
    "/home/user/.cache",
    "/home/user/.cargo",
    "/home/user/.rustup",
    "/home/user/.local",
    "/home/user/.codex",
    "/home/user/.claude",
    "/home/user/.vm0",
    "/home/user/.npm",
    "/home/user",
    "/var",
    "/usr",
    "/opt",
    "/root",
    "/home",
    "/",
)
EXCLUDED = {"/home/user/workspace", "/proc", "/sys", "/dev", "/run"}
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
ENTRIES_PER_TARGET = 4096
TOTAL_ENTRIES = 32768
MAX_DEPTH = 32
SECONDS_PER_TARGET = 0.12
TOTAL_SECONDS = 2.2
OUTPUT_BYTES = 3600


class BudgetReached(Exception):
    pass


class Observation:
    def __init__(self, root_device, remaining, deadline):
        self.root_device = root_device
        self.remaining = remaining
        self.deadline = min(deadline, time.monotonic() + SECONDS_PER_TARGET)
        self.entries = 0
        self.allocated = 0
        self.seen = set()
        self.reasons = set()

    def check_budget(self):
        if self.entries >= min(ENTRIES_PER_TARGET, self.remaining):
            self.reasons.add("entries")
            raise BudgetReached
        if time.monotonic() >= self.deadline:
            self.reasons.add("time")
            raise BudgetReached

    def count(self, metadata):
        identity = (metadata.st_dev, metadata.st_ino)
        if identity not in self.seen:
            self.seen.add(identity)
            self.allocated += metadata.st_blocks * 512

    def walk(self, directory, path, depth):
        self.count(os.fstat(directory))
        with os.scandir(directory) as entries:
            while True:
                self.check_budget()
                entry = next(entries, None)
                if entry is None:
                    return
                self.entries += 1
                child_path = path.rstrip("/") + "/" + entry.name
                if child_path in EXCLUDED:
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                    if metadata.st_dev != self.root_device:
                        continue
                    if not stat.S_ISDIR(metadata.st_mode):
                        self.count(metadata)
                        continue
                    if depth >= MAX_DEPTH:
                        self.reasons.add("depth")
                        continue
                    child = os.open(entry.name, DIRECTORY_FLAGS, dir_fd=directory)
                    try:
                        actual = os.fstat(child)
                        if (actual.st_dev, actual.st_ino) != (
                            metadata.st_dev,
                            metadata.st_ino,
                        ):
                            self.reasons.add("changed")
                            continue
                        self.walk(child, child_path, depth + 1)
                    finally:
                        os.close(child)
                except OSError:
                    # Never include exception text: it can contain private names.
                    self.reasons.add("io")


def open_target(root, path, device):
    """Pin every component, including ancestors; never resolve a symlink."""
    current = os.dup(root)
    try:
        for component in path.split("/"):
            if not component:
                continue
            child = os.open(component, DIRECTORY_FLAGS, dir_fd=current)
            os.close(current)
            current = child
            if os.fstat(current).st_dev != device:
                os.close(current)
                return None
        return current
    except BaseException:
        os.close(current)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", default="/", help="mounted root filesystem to inspect"
    )
    args = parser.parse_args()
    output_bytes = 0

    def emit(line):
        nonlocal output_bytes
        size = len(line.encode("utf-8")) + 1
        if output_bytes + size > OUTPUT_BYTES:
            print("output_limit", flush=True)
            raise SystemExit(0)
        output_bytes += size
        print(line, flush=True)

    emit("VM0_ROOTFS_USAGE_V1 allocated_bytes; non_atomic; non_additive")
    try:
        root = os.open(args.root, DIRECTORY_FLAGS)
    except OSError:
        emit("root_unavailable")
        return
    try:
        device = os.fstat(root).st_dev
        deadline = time.monotonic() + TOTAL_SECONDS
        remaining = TOTAL_ENTRIES
        for path in TARGETS:
            if remaining <= 0 or time.monotonic() >= deadline:
                emit(f"{path} status=unscanned reason=budget")
                continue
            emit(f"{path} status=started")
            try:
                target = open_target(root, path, device)
            except OSError as error:
                if error.errno == errno.ENOENT:
                    status = "missing"
                elif error.errno in (errno.ELOOP, errno.ENOTDIR):
                    status = "symlink_or_non_directory"
                else:
                    status = "unavailable"
                emit(f"{path} status={status}")
                continue
            if target is None:
                emit(f"{path} status=other_filesystem")
                continue
            observation = Observation(device, remaining, deadline)
            try:
                observation.walk(target, path, 0)
            except BudgetReached:
                pass
            except OSError:
                observation.reasons.add("io")
            finally:
                os.close(target)
            remaining -= observation.entries
            status = "partial" if observation.reasons else "complete"
            reason = ",".join(sorted(observation.reasons)) or "none"
            emit(
                f"{path} bytes={observation.allocated} entries={observation.entries} "
                f"status={status} reason={reason}"
            )
        emit("done")
    finally:
        os.close(root)


if __name__ == "__main__":
    main()
