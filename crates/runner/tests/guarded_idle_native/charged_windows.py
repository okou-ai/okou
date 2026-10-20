"""Owned cgroup-v2 charged-memory windows, never full physical residency."""

import os
import re
import sys
import threading
import time
import uuid
from contextlib import ExitStack
from pathlib import Path

MIB = 1024 * 1024
MAX_READ = 16384
FALSE_CLAIMS = {
    "relevant_native_residency_complete": False,
    "native_guest_executed": False,
    "cold_inputs_established": False,
    "production_protection_established": False,
}


def identity(info):
    return {"device": info.st_dev, "inode": info.st_ino}


def unsigned(raw):
    value = raw.strip()
    if not value or not value.isascii() or not value.isdecimal():
        raise ValueError("invalid unsigned counter")
    result = int(value)
    if result > (1 << 64) - 1:
        raise ValueError("counter overflow")
    return result


def read_at(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=directory)
    try:
        content = os.read(fd, MAX_READ + 1)
        if len(content) > MAX_READ:
            raise ValueError("oversized cgroup input")
        return content.decode("ascii")
    finally:
        os.close(fd)


def write_at(directory, name, value):
    fd = os.open(name, os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=directory)
    try:
        if os.write(fd, value) != len(value):
            raise OSError("short cgroup write")
    finally:
        os.close(fd)


def peak_file(group):
    """Return a file object so ownership transfers before metadata can fail."""
    return open(
        "memory.peak",
        "r+b",
        buffering=0,
        opener=lambda path, flags: os.open(
            path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=group.fd
        ),
    )


class Group:
    def __init__(self, path):
        self.path = path
        self.fd = os.open(
            path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
        )
        try:
            self.identity = identity(os.fstat(self.fd))
        except BaseException:
            os.close(self.fd)
            raise

    def verify(self):
        if identity(os.stat(self.path, follow_symlinks=False)) != self.identity:
            raise ValueError("cgroup path identity changed")
        if identity(os.fstat(self.fd)) != self.identity:
            raise ValueError("cgroup descriptor identity changed")

    def create_child(self, name):
        self.verify()
        os.mkdir(name, mode=0o700, dir_fd=self.fd)
        original = identity(os.stat(name, dir_fd=self.fd, follow_symlinks=False))
        try:
            group = Group(self.path / name)
            if group.identity != original:
                os.close(group.fd)
                raise ValueError("new owned group identity changed while opening")
            return group
        except BaseException as error:
            try:
                if (
                    identity(os.stat(name, dir_fd=self.fd, follow_symlinks=False))
                    != original
                ):
                    raise ValueError("new owned group replaced before opening")
                os.rmdir(name, dir_fd=self.fd)
            except (OSError, ValueError) as cleanup_error:
                raise OSError(
                    f"new group {self.path / name}: {error}; cleanup: {cleanup_error}"
                ) from error
            raise


class ChargeWindows:
    """Single-owner synchronous acquisition; seed only a newly forked child.

    Each one-use window has its own ancestor counter object and retained FD.
    The observer stays outside the hierarchy. No supplied PID can be attached.
    """

    def __init__(self, parent, names, invocation, emit, memory_limit_bytes=256 * MIB):
        if str(uuid.UUID(invocation)) != invocation:
            raise ValueError("noncanonical invocation")
        if not 1 <= len(names) <= 8 or len(set(names)) != len(names):
            raise ValueError("invalid window names")
        if any(not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", name) for name in names):
            raise ValueError("invalid window name")
        if (
            type(memory_limit_bytes) is not int
            or not 128 * MIB <= memory_limit_bytes <= 1024 * MIB
        ):
            raise ValueError("invalid owned memory limit")
        parent = Path(parent)
        if not parent.is_absolute() or parent.resolve(strict=True) != parent:
            raise ValueError("parent must be canonical and absolute")
        if (
            parent != Path("/sys/fs/cgroup")
            and Path("/sys/fs/cgroup") not in parent.parents
        ):
            raise ValueError("parent must be on the cgroup-v2 mount")
        self.parent = Group(parent)
        self.groups = []
        self.counters = {}
        self.peak_files = ExitStack()
        self.states = dict.fromkeys(names, "new")
        self.owner_pid = os.getpid()
        self.owner_thread = threading.get_ident()
        self.invocation = invocation
        self.emit = emit
        self.sequence = 0
        self.failed = False
        self.closed = False
        self.cleanup_records = []
        try:
            if (
                "memory"
                not in read_at(self.parent.fd, "cgroup.subtree_control").split()
            ):
                raise ValueError("supplied parent must already enable memory")
            # The v2 root is a domain but does not expose cgroup.type.
            if (
                parent != Path("/sys/fs/cgroup")
                and read_at(self.parent.fd, "cgroup.type").strip() != "domain"
            ):
                raise ValueError("domain cgroup required")
            owner = self.parent
            for index, name in enumerate(names):
                child_name = (
                    "okou-charge-" + invocation
                    if index == 0
                    else "counter-" + str(index)
                )
                group = owner.create_child(child_name)
                self.groups.append((group, owner, child_name))
                if index == 0:
                    write_at(group.fd, "memory.max", str(memory_limit_bytes).encode())
                write_at(group.fd, "cgroup.subtree_control", b"+memory")
                stream = self.peak_files.enter_context(peak_file(group))
                peak = stream.fileno()
                self.counters[name] = (
                    group,
                    peak,
                    {
                        "group": group.identity,
                        "peak": {**identity(os.fstat(peak)), "descriptor": peak},
                    },
                )
                owner = group
            self.leaf = owner.create_child("workload")
            self.groups.append((self.leaf, owner, "workload"))
        except BaseException as error:
            errors = self.cleanup()
            if errors:
                raise OSError(
                    f"setup failed: {error}; owned cleanup failed: {errors}"
                ) from error
            raise

    def enter_new_child(self):
        if os.getpid() == self.owner_pid or os.getppid() != self.owner_pid:
            raise ValueError("only a new direct child may seed the owned leaf")
        self.leaf.verify()
        write_at(self.leaf.fd, "cgroup.procs", b"0")

    def command_for_new_child(self, command):
        """Use an exec helper instead of a thread-unsafe preexec callback.

        The helper's Python bootstrap is outside the measured charge scope.
        Membership is established before the actual workload exec.
        """
        if (
            self.closed
            or self.failed
            or os.getpid() != self.owner_pid
            or threading.get_ident() != self.owner_thread
        ):
            raise ValueError("inactive or foreign charge-window owner")
        self.leaf.verify()
        return [
            sys.executable,
            "-B",
            str(Path(__file__).resolve()),
            "--seed",
            str(self.leaf.path),
            str(self.leaf.identity["device"]),
            str(self.leaf.identity["inode"]),
            str(self.owner_pid),
            *command,
        ]

    def _record(self, name, operation):
        if (
            self.closed
            or self.failed
            or os.getpid() != self.owner_pid
            or threading.get_ident() != self.owner_thread
        ):
            raise ValueError("inactive or foreign charge-window owner")
        group, fd, counter = self.counters[name]
        started = time.monotonic_ns()
        try:
            group.verify()
            if identity(os.fstat(fd)) != {
                k: counter["peak"][k] for k in ("device", "inode")
            }:
                raise ValueError("peak descriptor identity changed")
            if identity(
                os.stat("memory.peak", dir_fd=group.fd, follow_symlinks=False)
            ) != identity(os.fstat(fd)):
                raise ValueError("peak path identity changed")
            reset_completed = None
            if operation == "begin":
                os.lseek(fd, 0, os.SEEK_SET)
                if os.write(fd, b"0") != 1:
                    raise OSError("short peak reset")
                reset_completed = time.monotonic_ns()
            current = unsigned(read_at(group.fd, "memory.current"))
            stats = dict(
                line.split() for line in read_at(group.fd, "memory.stat").splitlines()
            )
            file_bytes = unsigned(stats["file"])
            os.lseek(fd, 0, os.SEEK_SET)
            peak = unsigned(os.read(fd, MAX_READ).decode("ascii"))
            group.verify()
            row = {
                "sequence": self.sequence,
                "invocation": self.invocation,
                "name": name,
                "operation": operation,
                "counter": counter,
                "started_monotonic_ns": started,
                "reset_completed_monotonic_ns": reset_completed,
                "completed_monotonic_ns": time.monotonic_ns(),
                "current_bytes": current,
                "peak_bytes": peak,
                "file_bytes": file_bytes,
            }
            self.emit(row)
            self.sequence += 1
            return row
        except BaseException:
            self.failed = True
            raise

    def begin(self, name):
        if self.states.get(name) != "new":
            raise ValueError("window must begin exactly once")
        row = self._record(name, "begin")
        self.states[name] = "active"
        return row

    def observe(self, name):
        if self.states.get(name) != "active":
            raise ValueError("window is not active")
        return self._record(name, "observe")

    def end(self, name):
        if self.states.get(name) != "active":
            raise ValueError("window is not active")
        row = self._record(name, "end")
        self.states[name] = "ended"
        return row

    def cleanup(self):
        """Never kill a process or remove a populated/replaced cgroup."""
        if os.getpid() != self.owner_pid or threading.get_ident() != self.owner_thread:
            raise ValueError("foreign charge-window cleanup owner")
        if self.closed:
            raise ValueError("charge-window owner already closed")
        self.closed = True
        errors = []
        self.peak_files.close()
        for group, owner, name in reversed(self.groups):
            started = time.monotonic_ns()
            try:
                group.verify()
                events = dict(
                    line.split()
                    for line in read_at(group.fd, "cgroup.events").splitlines()
                )
                if (
                    events.get("populated") != "0"
                    or read_at(group.fd, "cgroup.procs").strip()
                ):
                    raise ValueError("owned group still populated")
                if (
                    identity(os.stat(name, dir_fd=owner.fd, follow_symlinks=False))
                    != group.identity
                ):
                    raise ValueError("owned group replaced before removal")
                os.rmdir(name, dir_fd=owner.fd)
                self.cleanup_records.append(
                    {
                        "path": str(group.path),
                        "identity": group.identity,
                        "started_monotonic_ns": started,
                        "completed_monotonic_ns": time.monotonic_ns(),
                        "populated": 0,
                        "processes_empty": True,
                        "removed": True,
                    }
                )
            except (OSError, ValueError) as error:
                errors.append({"path": str(group.path), "error": str(error)})
            finally:
                os.close(group.fd)
        os.close(self.parent.fd)
        return errors


def seed_and_exec(arguments):
    if len(arguments) < 6 or arguments[0] != "--seed":
        raise ValueError("internal new-child exec helper requires owned identity")
    _, path, device, inode, owner_pid, *command = arguments
    owner = ChargeWindows.__new__(ChargeWindows)
    owner.owner_pid = int(owner_pid)
    owner.leaf = Group(Path(path))
    try:
        if owner.leaf.identity != {"device": int(device), "inode": int(inode)}:
            raise ValueError("new-child leaf identity changed")
        owner.enter_new_child()
    finally:
        os.close(owner.leaf.fd)
    os.execv(command[0], command)


if __name__ == "__main__":
    seed_and_exec(sys.argv[1:])
