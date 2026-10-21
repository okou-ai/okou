"""Owned original-file extent observations, not physical or interval bounds."""

import ctypes
import mmap
import os
from pathlib import Path
import stat
import sys
import threading
import time

MAX_EXTENT_BYTES = 64 * 1024 * 1024
CLAIMS = {
    "relevant_native_residency_complete": False,
    "native_guest_executed": False,
    "cold_inputs_established": False,
    "interval_upper_bound_established": False,
    "memory_envelope_calibrated": False,
    "physical_memory_credit": False,
    "production_protection_established": False,
}
LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.mmap.argtypes = [
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_long,
]
LIBC.mmap.restype = ctypes.c_void_p
LIBC.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
LIBC.mincore.restype = ctypes.c_int
LIBC.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
LIBC.munmap.restype = ctypes.c_int
MAP_FAILED = ctypes.c_void_p(-1).value


def require(condition, message):
    if not condition:
        raise ValueError(message)


def metadata(fd):
    value = os.fstat(fd)
    require(stat.S_ISREG(value.st_mode), "original must be a regular file")
    return {
        "device": value.st_dev,
        "inode": value.st_ino,
        "uid": value.st_uid,
        "size": value.st_size,
        "links": value.st_nlink,
        "mtime_ns": value.st_mtime_ns,
        "ctime_ns": value.st_ctime_ns,
    }


def credentials():
    # inode_owner_or_capable uses filesystem credentials. A successful mincore
    # can otherwise contain synthetic all-one bits rather than residency.
    with open("/proc/self/status", "rb") as stream:
        raw = stream.read(65537)
    require(len(raw) <= 65536, "oversized process credentials")
    rows = [line.split()[1:] for line in raw.splitlines() if line.startswith(b"Uid:")]
    require(len(rows) == 1 and len(rows[0]) == 4, "missing filesystem credentials")
    values = [int(value) for value in rows[0]]
    uid = os.geteuid()
    require(values[1] == values[3] == uid, "effective/filesystem uid mismatch")
    # Unmapped inode owners are reported as overflowuid. In a user namespace
    # that value can also be a mapped caller UID, making st_uid equality unsafe.
    with open("/proc/sys/kernel/overflowuid", "rb") as stream:
        raw_overflow = stream.read(33)
    require(
        len(raw_overflow) <= 32 and raw_overflow.strip().isdigit(),
        "invalid kernel overflow uid",
    )
    overflow = int(raw_overflow)
    require(overflow < 2**32 and uid != overflow, "ambiguous overflow uid authority")
    return {
        "effective_uid": uid,
        "filesystem_uid": values[3],
        "overflow_uid": overflow,
    }


def task_identity():
    native_id = threading.get_native_id()
    with open("/proc/thread-self/stat", "rb") as stream:
        raw = stream.read(65537)
    require(len(raw) <= 65536, "oversized native task identity")
    header, separator, tail = raw.rpartition(b") ")
    fields = tail.split()
    require(separator and len(fields) >= 20, "missing native task identity")
    require(int(header.partition(b" (")[0]) == native_id, "foreign procfs task")
    start_ticks = int(fields[19])
    require(native_id > 0 and start_ticks > 0, "invalid native task generation")
    return native_id, start_ticks


class FileResidency:
    """Duplicate an expected original FD; the caller retains its own FD."""

    def __init__(self, fd, expected_identity):
        require(
            sys.platform == "linux" and sys.maxsize > 2**32, "requires 64-bit Linux"
        )
        require(
            type(expected_identity) is tuple
            and len(expected_identity) == 2
            and all(type(value) is int and value >= 0 for value in expected_identity)
            and expected_identity[1] > 0,
            "invalid expected original identity",
        )
        self._creator = (os.getpid(), threading.get_ident())
        # Numeric thread identifiers may be reused after a creator exits.
        self._creator_thread = threading.current_thread()
        self._creator_task = task_identity()
        process = Path("/proc/self/stat").read_text()
        self._start_ticks = int(process.rsplit(") ", 1)[1].split()[19])
        self._identity = expected_identity
        self._fd = None
        self._mapping = None
        self._close_uncertain = False
        self.page_size = os.sysconf("SC_PAGESIZE")
        require(
            4096 <= self.page_size <= 1024 * 1024
            and self.page_size & (self.page_size - 1) == 0,
            "unsupported page geometry",
        )
        duplicate = os.dup(fd)
        try:
            value = metadata(duplicate)
            authority = credentials()
            require(
                (value["device"], value["inode"]) == expected_identity,
                "foreign original descriptor",
            )
            require(
                value["uid"] == authority["effective_uid"],
                "original file is not caller-owned",
            )
        except BaseException:
            os.close(duplicate)
            raise
        self._fd = duplicate

    def _check_owner(self):
        require(
            self._creator == (os.getpid(), threading.get_ident())
            and self._creator_thread is threading.current_thread()
            and self._creator_task == task_identity(),
            "foreign observation owner",
        )
        require(
            self._fd is not None and not self._close_uncertain,
            "closed or uncertain descriptor",
        )
        value = metadata(self._fd)
        authority = credentials()
        require(
            (value["device"], value["inode"]) == self._identity,
            "original descriptor substituted",
        )
        require(
            value["uid"] == authority["effective_uid"], "original authority changed"
        )
        return value, authority

    def _unmap(self):
        if self._mapping is not None:
            address, length = self._mapping
            if LIBC.munmap(address, length) != 0:
                raise OSError(ctypes.get_errno(), "original mapping release failed")
            self._mapping = None

    def observe(self, offset, length):
        started = time.monotonic_ns()
        before, authority = self._check_owner()
        require(
            self._mapping is None, "an earlier original mapping still needs cleanup"
        )
        require(
            type(offset) is int
            and type(length) is int
            and 0 <= offset < 2**63
            and offset % self.page_size == 0
            and 0 < length <= MAX_EXTENT_BYTES
            and offset + length <= min(before["size"], 2**63 - 1),
            "invalid or unbounded original extent",
        )
        address = LIBC.mmap(
            None, length, mmap.PROT_READ, mmap.MAP_SHARED, self._fd, offset
        )
        if address == MAP_FAILED:
            raise OSError(ctypes.get_errno(), "original extent mmap failed")
        self._mapping = (address, length)
        mapped = time.monotonic_ns()
        try:
            vector = (
                ctypes.c_ubyte * ((length + self.page_size - 1) // self.page_size)
            )()
            query_started = time.monotonic_ns()
            if LIBC.mincore(address, length, vector) != 0:
                raise OSError(ctypes.get_errno(), "original extent mincore failed")
            query_completed = time.monotonic_ns()
            # Higher bits are undefined by mincore(2).
            pages = bytes(value & 1 for value in vector)
            after, final_authority = self._check_owner()
            require(
                before == after and authority == final_authority,
                "original changed during acquisition",
            )
        finally:
            # Failed munmap keeps the address and original descriptor owned.
            self._unmap()
        completed = time.monotonic_ns()
        return {
            "observer": {
                "pid": self._creator[0],
                "thread_id": self._creator[1],
                "start_ticks": self._start_ticks,
                "native_thread_id": self._creator_task[0],
                "thread_start_ticks": self._creator_task[1],
            },
            "before": before,
            "after": after,
            "authority": authority,
            "offset": offset,
            "length": length,
            "page_size": self.page_size,
            "resident_vector_hex": pages.hex(),
            "resident_payload_bytes": sum(
                min(self.page_size, length - index * self.page_size)
                for index, present in enumerate(pages)
                if present
            ),
            "started_monotonic_ns": started,
            "mapped_monotonic_ns": mapped,
            "query_started_monotonic_ns": query_started,
            "query_completed_monotonic_ns": query_completed,
            "completed_monotonic_ns": completed,
            "acquisition_ns": completed - started,
            "mapping_released": True,
        }

    def close(self):
        require(
            self._creator == (os.getpid(), threading.get_ident())
            and self._creator_thread is threading.current_thread()
            and self._creator_task == task_identity(),
            "foreign close owner",
        )
        if self._fd is None:
            return
        require(not self._close_uncertain, "descriptor close outcome is uncertain")
        value = metadata(self._fd)
        require(
            (value["device"], value["inode"]) == self._identity,
            "refusing to close a substituted descriptor",
        )
        self._unmap()
        try:
            os.close(self._fd)
        except OSError:
            # Linux close errors may already have retired the FD. Repeating
            # close could destroy a subsequently reused unrelated descriptor.
            self._close_uncertain = True
            raise
        self._fd = None

    def __enter__(self):
        self._check_owner()
        return self

    def __exit__(self, *_):
        self.close()
