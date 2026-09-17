"""Tests for the addon-to-Runner process event boundary."""

import asyncio
import json
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import pytest

import addon_process_logging

_SOURCE_DIR = Path(addon_process_logging.__file__).parent
_EMIT_SCRIPT = """
import json
import sys
sys.path.insert(0, sys.argv[1])
from addon_process_logging import emit_addon_process_event
level, message, fields = json.load(sys.stdin)
emit_addon_process_event(level, message, **fields)
"""


@asynccontextmanager
async def _child_process(
    script: str, *args: str, stderr: int = asyncio.subprocess.PIPE
) -> AsyncIterator[asyncio.subprocess.Process]:
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-u",
        "-c",
        script,
        str(_SOURCE_DIR),
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=stderr,
    )
    try:
        async with asyncio.timeout(10):
            yield child
    finally:
        if child.returncode is None:
            child.kill()
        await asyncio.wait_for(child.communicate(), timeout=10)


async def _emitted_record(level: str, message: str, /, **fields: object) -> bytes:
    async with _child_process(_EMIT_SCRIPT) as child:
        _, stderr = await child.communicate(json.dumps([level, message, fields]).encode())
        assert child.returncode == 0, stderr
        return stderr


def _event_from_record(record: bytes) -> dict[str, object]:
    assert record.endswith(b"\n")
    assert record.count(b"\n") == 1
    assert len(record) <= addon_process_logging.MAX_ADDON_PROCESS_EVENT_BYTES
    prefix = addon_process_logging.ADDON_PROCESS_EVENT_PREFIX.encode()
    assert record.startswith(prefix)
    return json.loads(record[len(prefix) :])


async def test_emits_one_versioned_stderr_record() -> None:
    record = await _emitted_record(
        "error",
        "Failed to write pending count",
        type="usage_underbilling",
        reason="pending_snapshot_write_failed",
        underbilling_class="risk",
        retry_count=2,
        retryable=True,
        diagnostic={"phase": "flush"},
        **{"future.field-name": ["value", 3]},
    )

    assert _event_from_record(record) == {
        "version": 1,
        "level": "error",
        "message": "Failed to write pending count",
        "type": "usage_underbilling",
        "reason": "pending_snapshot_write_failed",
        "underbilling_class": "risk",
        "retry_count": 2,
        "retryable": True,
        "diagnostic": {"phase": "flush"},
        "future.field-name": ["value", 3],
    }


async def test_logger_owned_fields_cannot_be_overridden() -> None:
    record = await _emitted_record(
        "error",
        "owned message",
        version=2,
        level="warn",
        message="wrong message",
    )

    assert _event_from_record(record) == {
        "version": 1,
        "level": "error",
        "message": "owned message",
    }


async def test_bounds_and_single_lines_control_heavy_message() -> None:
    record = await _emitted_record("warn", "\x00\n" * 4096)

    event = _event_from_record(record)
    assert isinstance(event["message"], str)
    assert event["message"].endswith("...")


def test_transport_setup_failure_does_not_escape() -> None:
    with patch.object(addon_process_logging.os, "open", side_effect=OSError("unavailable")):
        addon_process_logging.emit_addon_process_event("warn", "write failed")


async def test_closed_pipe_reader_does_not_interrupt_emission() -> None:
    read_fd, write_fd = os.pipe()
    os.close(read_fd)
    try:
        async with _child_process(_EMIT_SCRIPT, stderr=write_fd) as child:
            await child.communicate(json.dumps(["warn", "no reader", {}]).encode())
            assert child.returncode == 0
    finally:
        os.close(write_fd)


async def test_non_pipe_stderr_drops_event_without_modifying_file(tmp_path: Path) -> None:
    stderr_path = tmp_path / "stderr"
    stderr_path.write_bytes(b"existing stderr\n")
    with stderr_path.open("ab") as stderr:
        async with _child_process(_EMIT_SCRIPT, stderr=stderr.fileno()) as child:
            await child.communicate(json.dumps(["warn", "unsupported sink", {}]).encode())
            assert child.returncode == 0
    assert stderr_path.read_bytes() == b"existing stderr\n"


@pytest.mark.parametrize(
    ("level", "fields", "error", "message"),
    [
        ("info", {}, ValueError, "invalid addon process event level"),
        ("warn", {"invalid": object()}, TypeError, "not JSON serializable"),
        ("warn", {"invalid": float("nan")}, ValueError, "Out of range float values"),
        (
            "warn",
            {"oversized": "x" * addon_process_logging.MAX_ADDON_PROCESS_EVENT_BYTES},
            ValueError,
            "addon process event fields exceed the record size limit",
        ),
    ],
)
def test_validation_errors_precede_transport(level, fields, error, message) -> None:
    with (
        patch.object(addon_process_logging.os, "open") as open_stderr,
        pytest.raises(error, match=message),
    ):
        addon_process_logging.emit_addon_process_event(level, "invalid event", **fields)

    open_stderr.assert_not_called()


_BACKPRESSURE_SCRIPT = """
import asyncio
import json
import os
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from addon_process_logging import emit_addon_process_event

async def main():
    original_blocking = os.get_blocking(2)
    os.set_blocking(2, False)
    filled = 0
    try:
        while True:
            filled += os.write(2, b'x' * 4096)
    except BlockingIOError:
        pass
    finally:
        os.set_blocking(2, original_blocking)

    descriptors_before = len(list(Path('/proc/self/fd').iterdir()))
    loop = asyncio.get_running_loop()
    loop.call_soon(lambda: print(json.dumps({'heartbeat': True}), flush=True))
    for index in range(200):
        emit_addon_process_event('warn', 'dropped under pressure', index=index)
    await asyncio.sleep(0)
    print(json.dumps({
        'filled': filled,
        'blocking_before': original_blocking,
        'blocking_after': os.get_blocking(2),
        'descriptors_before': descriptors_before,
        'descriptors_after': len(list(Path('/proc/self/fd').iterdir())),
    }), flush=True)

    if sys.argv[2] == 'recover':
        assert sys.stdin.readline() == 'drained\\n'
        emit_addon_process_event('warn', 'recovered')
        print(json.dumps({
            'descriptors_after_recovery': len(list(Path('/proc/self/fd').iterdir())),
        }), flush=True)

asyncio.run(main())
"""


@pytest.mark.parametrize("mode", ["recover", "exit"])
async def test_full_pipe_allows_event_loop_progress_and_exit(mode: str) -> None:
    read_fd, write_fd = os.pipe()
    # Own stderr directly so asyncio's subprocess transport cannot drain it.
    with os.fdopen(read_fd, "rb", buffering=0) as reader, os.fdopen(write_fd, "wb") as writer:
        os.set_blocking(read_fd, False)
        async with _child_process(_BACKPRESSURE_SCRIPT, mode, stderr=write_fd) as child:
            writer.close()
            assert child.stdout is not None
            assert child.stdin is not None
            # No stderr reads until emission and unrelated loop work progress.
            # The subprocess timeout guards deadlocks, not a latency target.
            assert json.loads(await child.stdout.readline()) == {"heartbeat": True}
            state = json.loads(await child.stdout.readline())
            assert state["blocking_before"] is True
            assert state["blocking_after"] is True
            assert state["descriptors_after"] == state["descriptors_before"]

            if mode == "recover":
                remaining = state["filled"]
                while remaining:
                    chunk = os.read(reader.fileno(), remaining)
                    assert chunk
                    assert chunk == b"x" * len(chunk)
                    remaining -= len(chunk)
                child.stdin.write(b"drained\n")
                await child.stdin.drain()
            # Reap before reading any further stderr: exit cannot require drain.
            assert await child.wait() == 0
            stdout, _ = await child.communicate()
            stderr = reader.read()
            assert stderr is not None
            if mode == "recover":
                assert (
                    json.loads(stdout)["descriptors_after_recovery"] == state["descriptors_before"]
                )
                assert _event_from_record(stderr) == {
                    "version": 1,
                    "level": "warn",
                    "message": "recovered",
                }
            else:
                assert stderr == b"x" * state["filled"]


async def test_concurrent_pipe_emissions_preserve_complete_records() -> None:
    script = """
import sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, sys.argv[1])
from addon_process_logging import emit_addon_process_event

def emit(producer):
    for index in range(50):
        emit_addon_process_event('warn', '\\u2603' * 2048, producer=producer, index=index)

with ThreadPoolExecutor(max_workers=4) as executor:
    list(executor.map(emit, range(4)))
"""
    async with _child_process(script) as child:
        _, stderr = await child.communicate()
        assert child.returncode == 0, stderr
    records = stderr.splitlines(keepends=True)
    assert records
    identities = set()
    for record in records:
        event = _event_from_record(record)
        assert event["version"] == 1
        assert event["level"] == "warn"
        assert isinstance(event["message"], str)
        assert event["message"].endswith("...")
        assert event["message"].removesuffix("...").strip("\u2603") == ""
        identities.add((event["producer"], event["index"]))
    assert len(identities) == len(records)
