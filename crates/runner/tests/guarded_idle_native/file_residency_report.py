"""Replay original file-residency qualification records, not past kernel state."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

SOURCES = ("file_residency.py", "file_residency_probe.py", "file_residency_report.py")
CLAIMS = (
    "relevant_native_residency_complete",
    "native_guest_executed",
    "cold_inputs_established",
    "interval_upper_bound_established",
    "memory_envelope_calibrated",
    "physical_memory_credit",
    "production_protection_established",
)
BOUNDS = {
    "max_extent_bytes": 64 * 1024 * 1024,
    "max_locked_bytes": 65536,
    "max_events": 4,
    "duration_seconds": 30,
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(value, names):
    require(
        type(value) is dict and set(value) == set(names.split()),
        "missing or unexpected fields",
    )


def integer(value, minimum=0):
    require(type(value) is int and minimum <= value < 2**64, "invalid integer/clock")
    return value


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


def decode(raw):
    return json.loads(
        raw,
        object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")),
    )


def read_regular(root, name, limit):
    fd = os.open(
        root / name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    )
    try:
        before = os.fstat(fd)
        require(
            stat.S_ISREG(before.st_mode) and 0 <= before.st_size <= limit,
            "invalid original file",
        )
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(fd)
        require(
            len(raw) <= limit
            and (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
                before.st_ctime_ns,
            )
            == (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ),
            "original file changed during replay",
        )
        return raw
    finally:
        os.close(fd)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def hash_value(value):
    require(
        type(value) is str and re.fullmatch("[0-9a-f]{64}", value),
        "invalid expected hash",
    )
    return value


def identity(value):
    fields(value, "device inode")
    return integer(value["device"]), integer(value["inode"], 1)


def observer(value):
    fields(value, "pid thread_id start_ticks")
    return tuple(integer(value[key], 1) for key in ("pid", "thread_id", "start_ticks"))


def replay(root, invocation, source_sha256):
    root = Path(root)
    require(
        root.is_absolute() and root.resolve(strict=True) == root,
        "original directory must be canonical",
    )
    require(str(uuid.UUID(invocation)) == invocation, "invalid expected invocation")
    hash_value(source_sha256)
    capture = decode(read_regular(root, "capture.json", 65536))
    require(
        type(capture) is dict and capture.get("error") is None,
        "failed acquisition; inspect original capture.json",
    )
    fields(
        capture,
        "format invocation started_monotonic_ns started_unix_ns host bounds claims error cleanup_complete sources source_sha256 page_size descriptor_count_before original_identity replacement_identity observer original_payload replacement_payload descriptor_count_after cleanup_errors remaining_qualification_mappings completed_monotonic_ns completed_unix_ns event_count events_sha256",
    )
    require(
        capture["format"] == "owned-file-residency-qualification-v1",
        "unsupported qualification format",
    )
    require(
        capture["invocation"] == invocation
        and capture["source_sha256"] == source_sha256,
        "foreign/replayed invocation or source",
    )
    fields(capture["sources"], " ".join(SOURCES))
    for name in SOURCES:
        require(
            sha256(read_regular(root, name, 65536))
            == hash_value(capture["sources"][name]),
            "original source changed",
        )
    require(
        sha256(
            json.dumps(
                capture["sources"], sort_keys=True, separators=(",", ":")
            ).encode()
        )
        == source_sha256,
        "source bundle mismatch",
    )
    fields(capture["claims"], " ".join(CLAIMS))
    require(
        all(capture["claims"][name] is False for name in CLAIMS),
        "unsupported native/physical/completeness claim",
    )
    fields(capture["bounds"], " ".join(BOUNDS))
    require(
        all(integer(capture["bounds"][key]) == value for key, value in BOUNDS.items()),
        "changed qualification bounds",
    )
    require(
        capture["cleanup_complete"] is True
        and capture["cleanup_errors"] == []
        and integer(capture["remaining_qualification_mappings"]) == 0,
        "incomplete original cleanup",
    )
    require(
        integer(capture["descriptor_count_before"], 1)
        == integer(capture["descriptor_count_after"], 1),
        "unretired original descriptors",
    )
    fields(capture["host"], "kernel_release architecture effective_uid boot_id")
    for key in ("kernel_release", "architecture"):
        require(
            type(capture["host"][key]) is str
            and re.fullmatch(r"[A-Za-z0-9._+-]{1,256}", capture["host"][key]),
            "invalid original host",
        )
    require(
        str(uuid.UUID(capture["host"]["boot_id"])) == capture["host"]["boot_id"],
        "invalid boot identity",
    )
    uid = integer(capture["host"]["effective_uid"])
    require(uid < 2**32, "invalid effective uid")
    original = identity(capture["original_identity"])
    replacement = identity(capture["replacement_identity"])
    require(
        original[0] == replacement[0] and original != replacement,
        "replacement is not a separate original file",
    )
    actor = observer(capture["observer"])
    page = integer(capture["page_size"], 4096)
    require(
        page & (page - 1) == 0 and 4 * page <= BOUNDS["max_locked_bytes"],
        "unsupported qualification geometry",
    )
    started = integer(capture["started_monotonic_ns"], 1)
    ended = integer(capture["completed_monotonic_ns"], started)
    require(
        ended - started <= BOUNDS["duration_seconds"] * 10**9,
        "qualification exceeded bound",
    )
    wall_started = integer(capture["started_unix_ns"], 1)
    wall_ended = integer(capture["completed_unix_ns"], wall_started)
    require(
        abs((wall_ended - wall_started) - (ended - started)) <= 5 * 10**9,
        "inconsistent original clocks",
    )
    raw = read_regular(root, "events.jsonl", 1024 * 1024)
    require(
        sha256(raw) == hash_value(capture["events_sha256"]) and raw.endswith(b"\n"),
        "original events changed/truncated",
    )
    events = [decode(line) for line in raw.splitlines()]
    require(
        integer(capture["event_count"]) == len(events) == BOUNDS["max_events"],
        "incomplete original event sequence",
    )
    labels = ("initial-offset", "path-replaced", "original-unlinked", "original-grown")
    previous = started
    for index, event in enumerate(events):
        fields(
            event,
            "label invocation source_sha256 observer before after authority offset length page_size resident_vector_hex resident_payload_bytes started_monotonic_ns mapped_monotonic_ns query_started_monotonic_ns query_completed_monotonic_ns completed_monotonic_ns acquisition_ns mapping_released",
        )
        require(
            event["label"] == labels[index]
            and event["invocation"] == invocation
            and event["source_sha256"] == source_sha256,
            "foreign/reordered original event",
        )
        require(
            observer(event["observer"]) == actor, "original observer generation changed"
        )
        fields(event["before"], "device inode uid size links mtime_ns ctime_ns")
        fields(event["after"], "device inode uid size links mtime_ns ctime_ns")
        require(
            event["before"] == event["after"], "original mutated during acquisition"
        )
        meta = event["before"]
        for snapshot in (event["before"], event["after"]):
            for value in snapshot.values():
                integer(value)
        require(
            (meta["device"], meta["inode"]) == original and meta["uid"] == uid,
            "foreign original identity/authority",
        )
        fields(event["authority"], "effective_uid filesystem_uid overflow_uid")
        require(
            all(
                integer(event["authority"][key]) == uid
                for key in ("effective_uid", "filesystem_uid")
            ),
            "effective/filesystem uid mismatch",
        )
        overflow = integer(event["authority"]["overflow_uid"])
        require(
            overflow < 2**32 and overflow != uid, "ambiguous overflow uid authority"
        )
        expected_size = (3 if index == 3 else 2) * page + 3
        require(
            meta["size"] == expected_size and meta["links"] == (1 if index < 2 else 0),
            "invalid original lifetime/growth",
        )
        offset = integer(event["offset"])
        length = integer(event["length"], 1)
        require(
            offset == (page if index == 0 else 0)
            and length == expected_size - offset
            and integer(event["page_size"]) == page,
            "incorrect original extent",
        )
        require(length <= BOUNDS["max_extent_bytes"], "unbounded extent")
        vector = event["resident_vector_hex"]
        require(
            type(vector) is str and re.fullmatch(r"(?:00|01)+", vector),
            "invalid mincore vector",
        )
        values = bytes.fromhex(vector)
        require(
            len(values) == (length + page - 1) // page and all(values),
            "locked original extent was not fully observed",
        )
        require(
            integer(event["resident_payload_bytes"]) == length,
            "invalid resident payload coverage",
        )
        clocks = [
            integer(event[key], 1)
            for key in (
                "started_monotonic_ns",
                "mapped_monotonic_ns",
                "query_started_monotonic_ns",
                "query_completed_monotonic_ns",
                "completed_monotonic_ns",
            )
        ]
        require(
            previous
            <= clocks[0]
            <= clocks[1]
            <= clocks[2]
            <= clocks[3]
            <= clocks[4]
            <= ended,
            "invalid acquisition order/span",
        )
        require(
            integer(event["acquisition_ns"]) == clocks[4] - clocks[0]
            and event["mapping_released"] is True,
            "unmeasured cost or unretired mapping",
        )
        previous = clocks[4]
    for key, filename, expected in (
        ("original_payload", "original.bin", b"a" * (2 * page + 3) + b"b" * page),
        ("replacement_payload", "image.bin", b"replacement"),
    ):
        info = capture[key]
        fields(info, "file size sha256")
        require(
            info["file"] == filename and integer(info["size"]) == len(expected),
            "invalid original payload binding",
        )
        payload = read_regular(root, filename, 65536)
        require(
            payload == expected and sha256(payload) == hash_value(info["sha256"]),
            "original complete payload changed",
        )
    return {
        "format": "owned-file-residency-report-v1",
        "invocation": invocation,
        "source_sha256": source_sha256,
        "observations": len(events),
        "original_identity": capture["original_identity"],
        "acquisition_ns": sum(event["acquisition_ns"] for event in events),
        "cleanup_complete": True,
        "claims": {name: False for name in CLAIMS},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--invocation", required=True)
    parser.add_argument("--source-sha256", required=True)
    args = parser.parse_args()
    try:
        print(
            json.dumps(
                replay(args.root, args.invocation, args.source_sha256), sort_keys=True
            )
        )
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
