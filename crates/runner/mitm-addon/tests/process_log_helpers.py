"""Test capture for addon process events."""

import json
import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import addon_process_logging


@contextmanager
def capture_addon_process_events() -> Iterator[MagicMock]:
    """Capture the external stderr write after real event serialization."""
    log = MagicMock()

    def capture(fd: int, record: bytes) -> int:
        assert fd == 42
        # Pin Runner's wire contract independently of the producer constant.
        prefix = b"VM0_ADDON_EVENT "
        assert record.startswith(prefix)
        assert record.endswith(b"\n")
        payload = json.JSONDecoder().decode(record[len(prefix) :].decode())
        assert isinstance(payload, dict)
        level = payload.get("level")
        message = payload.get("message")
        assert level in ("warn", "error")
        assert isinstance(message, str)
        fields = {
            key: value
            for key, value in payload.items()
            if key not in ("version", "level", "message")
        }
        if fields:
            getattr(log, level)(message, fields)
        else:
            getattr(log, level)(message)
        return len(record)

    stderr = SimpleNamespace(
        O_WRONLY=os.O_WRONLY,
        O_NONBLOCK=os.O_NONBLOCK,
        O_CLOEXEC=os.O_CLOEXEC,
        open=lambda _path, _flags: 42,
        fstat=lambda _fd: SimpleNamespace(st_mode=stat.S_IFIFO),
        fpathconf=lambda _fd, _name: 4096,
        write=capture,
        close=lambda _fd: None,
    )
    with patch.object(addon_process_logging, "os", stderr):
        yield log
