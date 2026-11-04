"""Shared safe state-file reads."""

import os
import stat
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple, Self

_READ_CHUNK_BYTES = 1024 * 1024

type StatValidator = Callable[[Path, os.stat_result], None]


class StateFileIdentity(NamedTuple):
    """Identity captured for the descriptor opened for a state-file read.

    The device, inode, modification time, and size fields come from ``fstat()``
    on the descriptor before the read. ``absolute_path`` records the path passed
    to the open operation. Together, these fields identify the opened file for
    caller cache decisions; they do not perform a later path lookup.
    """

    absolute_path: str
    st_dev: int
    st_ino: int
    st_mtime_ns: int
    st_size: int


class StateFileNotRegularError(OSError):
    """The opened state-file path does not identify a regular file."""


class StateFileTooLargeError(OSError):
    """The opened state file exceeds the caller's bounded-read limit."""


@dataclass(frozen=True)
class OpenedStateFile:
    """State-file descriptor that passed the helper's baseline checks.

    The descriptor was opened read-only with each available ``O_CLOEXEC``,
    ``O_NOFOLLOW``, and ``O_NONBLOCK`` flag. The helper inspected the opened
    descriptor with ``fstat()`` and accepted it only when it is regular. These
    checks do not establish owner, mode, or other caller-specific trust. Supply
    ``validate_stat`` to ``open_state_file()`` when such a policy is required.

    Use this object as a context manager. Exiting the context closes the
    descriptor. ``identity`` records metadata captured from this descriptor
    before reading.
    """

    _fd: int
    path: Path
    description: str
    identity: StateFileIdentity

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_args: object) -> None:
        os.close(self._fd)

    def read_bytes(self, max_bytes: int) -> bytes:
        """Read at most ``max_bytes`` from the opened descriptor.

        If the identity's captured ``st_size`` exceeds ``max_bytes``, the read
        is rejected before any bytes are consumed. The method then probes one
        byte beyond the limit, so underreported or growing content is also
        rejected. Success returns at most ``max_bytes`` bytes; excess content
        raises ``StateFileTooLargeError``. Other ``OSError`` failures report
        actual I/O errors, allowing callers to choose a separate retry policy.
        """
        if self.identity.st_size > max_bytes:
            raise StateFileTooLargeError(
                f"{self.description} {self.path} exceeds {max_bytes} bytes"
            )

        chunks: list[bytes] = []
        total = 0
        while total <= max_bytes:
            to_read = min(_READ_CHUNK_BYTES, max_bytes + 1 - total)
            chunk = os.read(self._fd, to_read)
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)

        if total > max_bytes:
            raise StateFileTooLargeError(
                f"{self.description} {self.path} exceeds {max_bytes} bytes"
            )
        return b"".join(chunks)


def open_state_file(
    path: Path,
    *,
    description: str,
    validate_stat: StatValidator | None = None,
) -> OpenedStateFile:
    """Open and baseline-validate a state file, closing setup failures.

    The path is opened read-only with each available ``O_CLOEXEC``,
    ``O_NOFOLLOW``, and ``O_NONBLOCK`` flag. The resulting descriptor is checked
    with ``fstat()`` and must identify a regular file. These checks do not
    establish owner, mode, or other caller-specific trust. When supplied,
    ``validate_stat`` receives the ``Path`` and ``os.stat_result`` from that
    already-open descriptor, allowing the caller to apply an additional policy.

    The returned object owns the descriptor through its context manager. Setup
    failures close the descriptor before re-raising; callers must exit the
    context to close a successful open.
    """
    flags = os.O_RDONLY
    for flag_name in ("O_CLOEXEC", "O_NOFOLLOW", "O_NONBLOCK"):
        flags |= getattr(os, flag_name, 0)
    fd = os.open(path, flags)
    try:
        st = _validate_opened_file(fd, path, description, validate_stat)
        return OpenedStateFile(
            _fd=fd,
            path=path,
            description=description,
            identity=StateFileIdentity(
                absolute_path=str(path.absolute()),
                st_dev=st.st_dev,
                st_ino=st.st_ino,
                st_mtime_ns=st.st_mtime_ns,
                st_size=st.st_size,
            ),
        )
    except BaseException:
        os.close(fd)
        raise


def _validate_opened_file(
    fd: int,
    path: Path,
    description: str,
    validate_stat: StatValidator | None,
) -> os.stat_result:
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        raise StateFileNotRegularError(f"{description} is not a regular file: {path}")
    if validate_stat is not None:
        validate_stat(path, st)
    return st
