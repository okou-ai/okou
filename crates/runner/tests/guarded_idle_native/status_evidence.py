"""Validate tracker status publication evidence shared by guarded-idle reports."""

import datetime
import pathlib

import pressure_report as pressure
import report


def claim_status_path(value, paths, reason):
    """Record one private status destination without resolving or rewriting it."""
    if not (
        isinstance(value, str)
        and pathlib.PurePosixPath(value).is_absolute()
        and str(pathlib.PurePosixPath(value)) == value
        and ".." not in pathlib.PurePosixPath(value).parts
        and pathlib.PurePosixPath(value).name == "status.json"
    ) or value in paths:
        raise ValueError(reason)
    paths.add(value)


def status_wait_advanced(before, after):
    """Require one observed status wait between exact unsigned 64-bit counters."""
    return pressure.integer(before) and pressure.integer(after) and after == before + 1


def _base_status(value, missing_message, timestamp_message):
    if not isinstance(value, dict):
        raise ValueError(missing_message)
    for field in ("started_at", "updated_at"):
        text = value.get(field)
        if (
            not isinstance(text, str)
            or datetime.datetime.fromisoformat(text).utcoffset() is None
        ):
            raise ValueError(timestamp_message)
    return {
        "mode": "starting",
        "max_concurrent": 1,
        "active_runs": [],
        "started_at": value["started_at"],
        "updated_at": value["updated_at"],
    }


def original_status(value, sandbox=None, previous=None):
    expected = _base_status(
        value,
        "status publication has no original JSON",
        "status publication has invalid original timestamps",
    )
    if sandbox is not None:
        entries = value.get("idle_sandboxes")
        if (
            not isinstance(entries, list)
            or len(entries) != 1
            or not isinstance(entries[0], dict)
        ):
            raise ValueError("original parked status was not positively published")
        reuse = entries[0].get("reuse_key")
        prefix = "thread:native-guarded-"
        if (
            not isinstance(reuse, str)
            or not reuse.startswith(prefix)
            or not report.is_canonical_uuid(reuse[len(prefix) :])
        ):
            raise ValueError("original status reuse identity changed")
        expected["idle_sandboxes"] = [{"reuse_key": reuse, "sandbox_id": sandbox}]
    if previous is not None and value["started_at"] != previous["started_at"]:
        raise ValueError("status retry changed original tracker")
    report.exact(
        value, expected, "status publication resurrected inventory or changed its shape"
    )


def validate_initial_status_receipt(initial, policy, sandbox, paths, *, path_error, receipt_error):
    """Claim the receipt's path and return its validated original parked publication."""
    path = initial.get("status_path")
    claim_status_path(path, paths, path_error)
    baseline = initial.get("published_status")
    original_status(baseline, sandbox=sandbox)
    report.exact(
        initial,
        {"policy": policy, "status_path": path, "published_status": baseline, "regular_file": True},
        receipt_error,
    )
    return baseline


def current_status(value, initial, sandbox=None, reuse=None, blank=False):
    expected = _base_status(
        value, "current status missing", "invalid current status timestamp"
    )
    expected["started_at"] = initial["started_at"]
    updated = datetime.datetime.fromisoformat(value["updated_at"])
    previous_update = datetime.datetime.fromisoformat(initial["updated_at"])
    if updated < previous_update:
        raise ValueError("current status predates initial publication")
    if sandbox:
        expected["blank_sandboxes" if blank else "idle_sandboxes"] = (
            [{"sandbox_id": sandbox}]
            if blank
            else [{"reuse_key": reuse, "sandbox_id": sandbox}]
        )
    report.exact(
        value, expected, "current status lost later inventory or resurrected original"
    )
