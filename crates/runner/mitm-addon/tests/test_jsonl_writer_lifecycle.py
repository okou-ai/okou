"""Completed payload lifetime through production HTTP logging and flush."""

import errno
import gc
import json
import threading
import weakref
from types import FrameType

import pytest

import jsonl_writer
import logging_utils


def _write_item_refs(log_path: str) -> list[weakref.ReferenceType[jsonl_writer._WriteItem]]:
    return [
        weakref.ref(item)
        for item in gc.get_objects()
        if isinstance(item, jsonl_writer._WriteItem) and item.log_path == log_path
    ]


@pytest.mark.parametrize("batch_size", [1, 128])
@pytest.mark.parametrize("append_result", ["success", "error", "zero"])
def test_completed_payloads_are_released_before_worker_idles(
    tmp_path, monkeypatch, mitm_ctx, batch_size: int, append_result: str
):
    path = tmp_path / "network.jsonl"
    log_path = str(path)
    gate_started = threading.Event()
    release_gate = threading.Event()
    observe_idle = threading.Event()
    idle = threading.Event()
    writer_queue = jsonl_writer._queue
    original_writev = jsonl_writer.os.writev
    original_profile = threading.getprofile()

    def observe_queue_wait(_frame: FrameType, event: str, arg: object) -> None:
        # Flush can return before the worker waits again. Observe the real queue
        # boundary without replacing it or retaining any worker frame locals.
        if (
            event == "c_call"
            and arg == writer_queue.get
            and observe_idle.is_set()
            and writer_queue.empty()
        ):
            idle.set()

    def writev(fd: int, buffers: list[bytes | memoryview]) -> int:
        if not gate_started.is_set():
            gate_started.set()
            release_gate.wait()
        elif append_result == "error":
            raise OSError(errno.EIO, "injected append failure")
        elif append_result == "zero":
            return 0
        return original_writev(fd, buffers)

    with monkeypatch.context() as patcher, mitm_ctx() as log:
        # A recording mock would itself keep the completed buffers alive.
        patcher.setattr(jsonl_writer.os, "writev", writev)
        threading.setprofile(observe_queue_wait)
        try:
            logging_utils.log_network_entry(log_path, {"id": "gate"})
            assert gate_started.wait(timeout=2)
            worker = jsonl_writer._worker
            assert worker is not None

            for record_id in range(batch_size):
                logging_utils.log_http_network_entry(
                    log_path,
                    {"id": record_id, "response_body": "x" * 15_000},
                    "https://target.example.com/audit",
                )
            item_refs = _write_item_refs(log_path)
            assert len(item_refs) == batch_size + 1
            observe_idle.set()
            release_gate.set()

            assert logging_utils.flush_log_path(log_path, timeout=2)
            assert idle.wait(timeout=2)
            gc.collect()
            assert all(item_ref() is None for item_ref in item_refs)
            assert jsonl_writer._worker is worker
            assert worker.is_alive()

            rows = [json.loads(line) for line in path.read_bytes().splitlines()]
            expected_ids = ["gate", *range(batch_size)] if append_result == "success" else ["gate"]
            assert [row["id"] for row in rows] == expected_ids
            if append_result == "success":
                assert all(row["response_body"] == "x" * 15_000 for row in rows[1:])
                log.warn.assert_not_called()
            else:
                log.warn.assert_called_once()

            # Reclamation was established before any recovery traffic or stop.
            observe_idle.clear()
            patcher.setattr(jsonl_writer.os, "writev", original_writev)
            logging_utils.log_network_entry(log_path, {"id": "recovered"})
            assert logging_utils.flush_log_path(log_path, timeout=2)
            assert [json.loads(line)["id"] for line in path.read_bytes().splitlines()] == [
                *expected_ids,
                "recovered",
            ]
        finally:
            observe_idle.clear()
            release_gate.set()
            threading.setprofile(original_profile)
            assert jsonl_writer.shutdown_writer(timeout=2)
