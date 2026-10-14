"""Filesystem integration contracts for safe state-file reads."""

import errno
import os
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import patch

import pytest

import state_file
from tests.thread_helpers import ThreadUnderTest


def _assert_descriptor_closed(fd: int) -> None:
    with pytest.raises(OSError, match="Bad file descriptor") as exc_info:
        os.fstat(fd)

    assert exc_info.value.errno == errno.EBADF


@pytest.fixture
def opened_fds() -> Iterator[list[int]]:
    descriptors: list[int] = []
    real_open = os.open

    def record_open(open_path: Path, flags: int) -> int:
        fd = real_open(open_path, flags)
        descriptors.append(fd)
        return fd

    with patch.object(state_file.os, "open", side_effect=record_open):
        yield descriptors


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param(b"state", id="single-read"),
        pytest.param(
            b"prefix:" + b"x" * (1024 * 1024) + b":distinct-tail",
            id="multiple-reads",
        ),
    ],
)
def test_reads_exact_limit_from_opened_identity_and_closes(
    tmp_path: Path,
    opened_fds: list[int],
    payload: bytes,
) -> None:
    path = tmp_path / "state.json"
    path.write_bytes(payload)

    with state_file.open_state_file(path, description="test state") as opened_file:
        assert len(opened_fds) == 1
        fd = opened_fds[0]
        st = os.fstat(fd)

        assert opened_file.identity == state_file.StateFileIdentity(
            absolute_path=str(path.absolute()),
            st_dev=st.st_dev,
            st_ino=st.st_ino,
            st_mtime_ns=st.st_mtime_ns,
            st_size=st.st_size,
        )
        assert opened_file.read_bytes(len(payload)) == payload
        assert not os.get_inheritable(fd)

    _assert_descriptor_closed(fd)


def test_assembles_short_reads_from_real_descriptor_and_closes(
    tmp_path: Path,
    opened_fds: list[int],
) -> None:
    path = tmp_path / "state.json"
    payload = b"prefix:" + bytes(range(32)) + b":distinct-tail"
    path.write_bytes(payload)
    real_read = os.read

    def read_short(fd: int, count: int) -> bytes:
        return real_read(fd, min(count, 7))

    with state_file.open_state_file(path, description="test state") as opened_file:
        assert len(opened_fds) == 1
        fd = opened_fds[0]
        with patch.object(state_file.os, "read", side_effect=read_short):
            assert opened_file.read_bytes(len(payload)) == payload

    _assert_descriptor_closed(fd)


def test_rejects_initially_oversized_file(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    path.write_bytes(b"too large")

    with (
        state_file.open_state_file(path, description="test state") as opened_file,
        pytest.raises(state_file.StateFileTooLargeError, match=r"test state .* exceeds 3 bytes"),
    ):
        opened_file.read_bytes(3)


def test_rejects_bytes_beyond_underreported_size() -> None:
    path = Path("/proc/self/status")
    assert path.stat().st_size == 0

    with (
        state_file.open_state_file(path, description="test state") as opened_file,
        pytest.raises(state_file.StateFileTooLargeError, match=r"test state .* exceeds 1 bytes"),
    ):
        opened_file.read_bytes(1)


def test_rejects_symlink_without_following_target(tmp_path: Path) -> None:
    target = tmp_path / "target.json"
    target.write_text("{}")
    path = tmp_path / "state.json"
    path.symlink_to(target)

    with pytest.raises(OSError, match="symbolic links"):
        state_file.open_state_file(path, description="test state")


def test_rejects_fifo_without_blocking(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    os.mkfifo(path)

    def open_fifo() -> None:
        with pytest.raises(state_file.StateFileNotRegularError):
            state_file.open_state_file(path, description="test state")

    thread = ThreadUnderTest(target=open_fifo, daemon=True)
    thread.start()
    thread.join_and_raise(1)

    assert not thread.is_alive(), "state-file open blocked on FIFO"


def test_rejects_directory(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    path.mkdir()

    with pytest.raises(state_file.StateFileNotRegularError):
        state_file.open_state_file(path, description="test state")


def test_fstat_failure_closes_opened_descriptor(
    tmp_path: Path,
    opened_fds: list[int],
) -> None:
    path = tmp_path / "state.json"
    path.write_text("{}")

    with (
        patch.object(state_file.os, "fstat", side_effect=OSError("fstat failed")),
        pytest.raises(OSError, match="fstat failed"),
    ):
        state_file.open_state_file(path, description="test state")

    assert len(opened_fds) == 1
    _assert_descriptor_closed(opened_fds[0])


def test_stat_validator_failure_closes_opened_descriptor(
    tmp_path: Path,
    opened_fds: list[int],
) -> None:
    path = tmp_path / "state.json"
    path.write_text("{}")

    def reject_stat(_path: Path, _st: os.stat_result) -> None:
        raise PermissionError("untrusted")

    with (
        pytest.raises(PermissionError, match="untrusted"),
    ):
        state_file.open_state_file(
            path,
            description="test state",
            validate_stat=reject_stat,
        )

    assert len(opened_fds) == 1
    _assert_descriptor_closed(opened_fds[0])


def test_identity_setup_failure_closes_opened_descriptor(
    tmp_path: Path,
    opened_fds: list[int],
) -> None:
    path = tmp_path / "state.json"
    path.write_text("{}")

    with (
        patch.object(state_file.Path, "absolute", side_effect=OSError("absolute failed")),
        pytest.raises(OSError, match="absolute failed"),
    ):
        state_file.open_state_file(path, description="test state")

    assert len(opened_fds) == 1
    _assert_descriptor_closed(opened_fds[0])
