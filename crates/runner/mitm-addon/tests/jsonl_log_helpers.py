"""Helpers for observing async JSONL test logs."""

import json
from pathlib import Path
from typing import Any

import logging_utils


def read_jsonl_text_after_flush(path: Path, *, missing_ok: bool = False) -> str:
    logging_utils.flush_log_path(str(path))
    try:
        return path.read_text()
    except FileNotFoundError:
        if missing_ok:
            return ""
        raise


def read_jsonl_entries_after_flush(path: Path, *, missing_ok: bool = False) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in read_jsonl_text_after_flush(path, missing_ok=missing_ok).splitlines()
    ]


def jsonl_exists_after_flush(path: Path) -> bool:
    logging_utils.flush_log_path(str(path))
    return path.exists()
