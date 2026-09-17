"""Test capture for addon process events."""

import json
import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import addon_process_logging


@contextmanager
def capture_addon_process_events() -> Iterator[MagicMock]:
    """Capture the external stderr write after real event serialization."""
    log = MagicMock()

    def capture(fd: int, record: bytes) -> int:
        assert fd == 42
        prefix = addon_process_logging.ADDON_PROCESS_EVENT_PREFIX.encode()
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

    stderr = MagicMock()
    stderr.O_WRONLY = os.O_WRONLY
    stderr.O_NONBLOCK = os.O_NONBLOCK
    stderr.O_CLOEXEC = os.O_CLOEXEC
    stderr.open.return_value = 42
    stderr.fstat.return_value.st_mode = stat.S_IFIFO
    stderr.fpathconf.return_value = 4096
    stderr.write.side_effect = capture
    with patch.object(addon_process_logging, "os", stderr):
        yield log
