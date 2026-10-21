"""Owned Linux original-inode open synchronization; never lifecycle authority."""

import ctypes
import math
import os
import select
import struct
import sys
import threading
import time
from dataclasses import asdict, dataclass

from file_residency import credentials, metadata, require, task_identity

FAN_OPEN_PERM = 0x10000
MAX_PENDING = 64
MAX_RETIRE = 256
EVENT = struct.Struct("=IBBHQiiBBHi")
METADATA = struct.Struct("=IBBHQii")
RESPONSE = struct.Struct("=iI")
LIBC = ctypes.CDLL(None, use_errno=True)


@dataclass(frozen=True, slots=True)
class OpenEvent:
    """An observation token; only its original gate can dispose of it."""

    raw_hex: str
    device: int
    inode: int
    pid: int
    observed_ns: int


@dataclass
class _OwnedEvent:
    observation: OpenEvent
    fd: int
    pidfd: int | None
    attempted: bool = False


class FileOpenPermission:
    """Duplicate a caller-owned original FD and retain kernel permission events.

    Requires Linux 5.15+ FAN_REPORT_PIDFD and CAP_SYS_ADMIN. Use only isolated,
    controlled originals/producers. Closing a group can release unseen requests;
    this is a test synchronization primitive, not an authorization boundary.
    Callers independently own and join their producers, including on failure.
    """

    def __init__(self, fd, expected_identity):
        require(
            sys.platform == "linux" and sys.maxsize > 2**32, "requires 64-bit Linux"
        )
        require(
            type(expected_identity) is tuple
            and len(expected_identity) == 2
            and all(type(v) is int and v >= 0 for v in expected_identity)
            and expected_identity[1] > 0,
            "invalid expected original identity",
        )
        self._creator = (os.getpid(), threading.current_thread(), task_identity())
        self._authority = credentials()
        self._identity = expected_identity
        self._original = None
        self._group = None
        self._marked = False
        self._uncertain = False
        self._observation_failed = False
        self._pending = {}
        self._ready = []
        self._mark = LIBC.fanotify_mark
        self._mark.argtypes = [
            ctypes.c_int,
            ctypes.c_uint,
            ctypes.c_uint64,
            ctypes.c_int,
            ctypes.c_char_p,
        ]
        self._mark.restype = ctypes.c_int
        init = LIBC.fanotify_init
        init.argtypes = [ctypes.c_uint, ctypes.c_uint]
        init.restype = ctypes.c_int
        duplicate = os.dup(fd)
        try:
            value = metadata(duplicate)
            require(
                (value["device"], value["inode"]) == expected_identity,
                "foreign original descriptor",
            )
            require(
                value["uid"] == self._authority["filesystem_uid"],
                "original is not caller-owned",
            )
            # CLOEXEC | NONBLOCK | CLASS_CONTENT | REPORT_PIDFD. No ABI fallback.
            group = init(1 | 2 | 4 | 128, os.O_RDONLY | os.O_CLOEXEC | os.O_LARGEFILE)
            if group < 0:
                raise OSError(
                    ctypes.get_errno(),
                    "fanotify permission/PIDFD capability unavailable",
                )
            self._group = group
            self._original = duplicate
            self._change_mark(1)
            self._marked = True
        except BaseException:
            if self._group is not None:
                os.close(self._group)
                self._group = None
            os.close(duplicate)
            self._original = None
            raise

    def _check_owner(self):
        require(
            self._creator == (os.getpid(), threading.current_thread(), task_identity()),
            "foreign gate owner",
        )
        require(
            self._group is not None and not self._uncertain, "closed or uncertain gate"
        )
        require(credentials() == self._authority, "gate credentials changed")
        value = metadata(self._original)
        require(
            (value["device"], value["inode"]) == self._identity
            and value["uid"] == self._authority["filesystem_uid"],
            "original identity or authority changed",
        )

    def _change_mark(self, flags):
        path = os.fsencode(f"/proc/self/fd/{self._original}")
        if self._mark(self._group, flags, FAN_OPEN_PERM, -100, path) != 0:
            raise OSError(ctypes.get_errno(), "original-inode permission mark failed")

    def _read(self, validate=True):
        require(
            len(self._pending) < MAX_PENDING,
            "pending event bound reached; dispose events first",
        )
        try:
            raw = os.read(self._group, EVENT.size * (MAX_PENDING - len(self._pending)))
        except BlockingIOError:
            return False
        # The kernel supplies this ABI. Adopt all complete records before any
        # semantic validation, so a rejected observation retains its FD owners.
        require(raw, "empty kernel permission read")
        adopted = []
        errors = []
        offset = 0
        while offset < len(raw):
            require(len(raw) - offset >= METADATA.size, "truncated kernel metadata")
            size, version, reserved, meta, mask, fd, pid = METADATA.unpack_from(
                raw, offset
            )
            require(
                METADATA.size <= size <= len(raw) - offset,
                "truncated kernel event",
            )
            chunk = raw[offset : offset + size]
            offset += size
            pidfd = None
            if size == EVENT.size:
                kind, pad, info, candidate = struct.unpack_from(
                    "=BBHi", chunk, METADATA.size
                )
                if (kind, pad, info) == (4, 0, 8) and candidate >= 0:
                    pidfd = candidate
            if fd < 0:
                errors.append("kernel event overflow or missing original FD")
                continue
            observation = OpenEvent(
                chunk.hex(), *self._identity, pid, time.monotonic_ns()
            )
            owned = _OwnedEvent(observation, fd, pidfd)
            self._pending[id(observation)] = owned
            self._ready.append(observation)
            adopted.append((owned, mask))
            if (size, version, reserved, meta) != (32, 3, 0, 24) or pidfd is None:
                errors.append("unsupported kernel permission/PIDFD record")
        if errors:
            self._observation_failed = True
        if validate:
            require(not errors, "; ".join(errors))
            for owned, mask in adopted:
                value = metadata(owned.fd)
                require(mask == FAN_OPEN_PERM, "unexpected kernel permission mask")
                require(
                    (value["device"], value["inode"]) == self._identity,
                    "foreign permission-event original",
                )
                require(
                    not os.get_inheritable(owned.fd)
                    and not os.get_inheritable(owned.pidfd),
                    "inheritable event descriptor",
                )
                with open(
                    f"/proc/self/fdinfo/{owned.pidfd}", encoding="ascii"
                ) as stream:
                    info = stream.read(4097)
                rows = [
                    line.split()[1:]
                    for line in info.splitlines()
                    if line.startswith("Pid:")
                ]
                require(
                    len(info) <= 4096 and rows == [[str(owned.observation.pid)]],
                    "kernel PIDFD identity mismatch",
                )
                poller = select.poll()
                poller.register(owned.pidfd, select.POLLIN)
                require(
                    owned.observation.pid > 0 and not poller.poll(0),
                    "event producer already exited",
                )
        return True

    def receive(self, timeout=10):
        """Observe one pending kernel event, retaining the entire read batch."""
        self._check_owner()
        require(not self._observation_failed, "an earlier kernel observation failed")
        require(
            type(timeout) in (int, float)
            and math.isfinite(timeout)
            and 0 < timeout <= 30,
            "invalid permission observation deadline",
        )
        deadline = time.monotonic() + timeout
        while True:
            while self._ready:
                event = self._ready.pop(0)
                if id(event) in self._pending:
                    return event
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("original open-permission observation timed out")
            poller = select.poll()
            poller.register(self._group, select.POLLIN)
            ready = poller.poll(math.ceil(remaining * 1000))
            if not ready:
                raise TimeoutError("original open-permission observation timed out")
            require(
                all(flags == select.POLLIN for _, flags in ready),
                "permission group polling failed",
            )
            try:
                self._read()
            except BaseException:
                self._observation_failed = True
                raise

    def fileno(self):
        """Borrow the group FD for an event loop; the gate retains ownership."""
        self._check_owner()
        return self._group

    def check_pending_producer(self, event):
        """Recheck the original event's kernel PIDFD before/after inspection.

        This proves a live producer identity only while this event is pending;
        it does not prove application acceptance or join the producer.
        """
        self._check_owner()
        require(not self._observation_failed, "an earlier kernel observation failed")
        owned = self._pending.get(id(event))
        require(owned is not None and owned.observation is event and not owned.attempted,
                "foreign or completed permission event")
        require(owned.pidfd is not None, "missing original kernel PIDFD")
        with open(f"/proc/self/fdinfo/{owned.pidfd}", encoding="ascii") as stream:
            info = stream.read(4097)
        rows = [line.split()[1:] for line in info.splitlines() if line.startswith("Pid:")]
        require(len(info) <= 4096 and rows == [[str(event.pid)]],
                "kernel PIDFD identity mismatch")
        poller = select.poll()
        poller.register(owned.pidfd, select.POLLIN)
        require(event.pid > 0 and not poller.poll(0), "event producer already exited")

    def decide(self, event, allow):
        """Respond exactly once; uncertain writes/closes are never retried."""
        self._check_owner()
        require(type(allow) is bool, "permission decision must be boolean")
        require(
            not allow or not self._observation_failed,
            "cannot allow after failed observation",
        )
        owned = self._pending.get(id(event))
        require(
            owned is not None and owned.observation is event,
            "foreign or completed permission event",
        )
        require(not owned.attempted, "permission response already attempted")
        owned.attempted = True
        started = time.monotonic_ns()
        try:
            require(
                os.write(self._group, RESPONSE.pack(owned.fd, 1 if allow else 2))
                == RESPONSE.size,
                "short kernel permission response",
            )
            # A close error has ambiguous FD ownership: preserve the failed
            # diagnostic owner and refuse every later response/close attempt.
            os.close(owned.fd)
            if owned.pidfd is not None:
                os.close(owned.pidfd)
        except BaseException:
            self._uncertain = True
            raise
        del self._pending[id(event)]
        return {
            "event": asdict(event),
            "decision": "allow" if allow else "deny",
            "response_started_ns": started,
            "response_completed_ns": time.monotonic_ns(),
            "event_descriptors_closed": True,
        }

    def close(self):
        """Unmark, explicitly deny queued/observed events, then retire owned FDs.

        This does not join producers or account for uncontrolled new openers.
        On a bound/error/uncertain response, retain the group and report failure.
        """
        self._check_owner()
        started = time.monotonic_ns()
        if self._marked:
            self._change_mark(2)
            self._marked = False
        denied = []
        reads = 0
        while True:
            for owned in list(self._pending.values()):
                require(len(denied) < MAX_RETIRE, "permission retirement bound reached")
                denied.append(self.decide(owned.observation, False))
            self._ready.clear()
            require(reads < MAX_RETIRE, "permission retirement read bound reached")
            reads += 1
            try:
                more = self._read(validate=False)
            except BaseException:
                self._observation_failed = True
                raise
            if not more:
                break
        require(
            not self._observation_failed,
            "kernel observation failed; retired events but retained group owner",
        )
        try:
            os.close(self._group)
            os.close(self._original)
        except BaseException:
            self._uncertain = True
            raise
        self._group = self._original = None
        return {
            "started_ns": started,
            "completed_ns": time.monotonic_ns(),
            "denied": denied,
            "mark_removed": True,
            "group_closed": True,
            "original_duplicate_closed": True,
            "observation_failed": self._observation_failed,
        }

    def __enter__(self):
        self._check_owner()
        return self

    def __exit__(self, *_):
        self.close()
