"""Replay complete original range records, not past kernel residency."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

from file_residency_report import (
    CLAIMS,
    decode,
    fields,
    hash_value,
    identity,
    integer,
    observer,
    read_regular,
    require,
    sha256,
)
from file_residency_scan import BOUNDS, SOURCES

MAX_RECORD_BYTES = 32 * 1024 * 1024


def original_hash(root, size):
    fd = os.open(
        root / "original.bin",
        os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
    )
    try:
        before = os.fstat(fd)
        require(
            stat.S_ISREG(before.st_mode) and before.st_size == size,
            "complete original payload size mismatch",
        )
        hash_ = hashlib.sha256()
        total = 0
        while total <= size:
            raw = os.read(fd, min(1024 * 1024, size + 1 - total))
            if not raw:
                break
            total += len(raw)
            hash_.update(raw)
        after = os.fstat(fd)
        require(
            total == size
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
            "complete original payload changed during replay",
        )
        return hash_.hexdigest()
    finally:
        os.close(fd)


def metadata(value, expected_identity, uid):
    fields(value, "device inode uid size links mtime_ns ctime_ns")
    for item in value.values():
        integer(item)
    require(
        (value["device"], value["inode"]) == expected_identity and value["uid"] == uid,
        "foreign original metadata",
    )


def authority(value, uid):
    fields(value, "effective_uid filesystem_uid overflow_uid")
    require(
        integer(value["effective_uid"]) == integer(value["filesystem_uid"]) == uid,
        "foreign filesystem credentials",
    )
    overflow = integer(value["overflow_uid"])
    require(overflow < 2**32 and overflow != uid, "ambiguous overflow uid authority")


def claims(value):
    fields(value, " ".join(CLAIMS))
    require(
        all(value[name] is False for name in CLAIMS),
        "unsupported broader residency claim",
    )


def replay(
    root,
    invocation,
    source_sha256,
    capture_sha256,
    expected_identity,
    maximum_bytes,
    maximum_duration_ns,
):
    root = Path(root)
    require(
        root.is_absolute() and root.resolve(strict=True) == root,
        "original directory must be canonical",
    )
    require(str(uuid.UUID(invocation)) == invocation, "invalid expected invocation")
    hash_value(source_sha256)
    hash_value(capture_sha256)
    require(
        type(expected_identity) is tuple and len(expected_identity) == 2,
        "invalid expected original identity",
    )
    integer(expected_identity[0])
    integer(expected_identity[1], 1)
    require(
        type(maximum_bytes) is int
        and 0 <= maximum_bytes <= BOUNDS["max_scan_bytes"]
        and type(maximum_duration_ns) is int
        and 0 < maximum_duration_ns <= BOUNDS["max_duration_ns"],
        "invalid expected budgets",
    )
    raw = read_regular(root, "capture.json", 65536)
    require(sha256(raw) == capture_sha256, "original capture seal mismatch")
    capture = decode(raw)
    fields(
        capture,
        "format invocation source_sha256 original_sha256 original_identity maximum_bytes maximum_duration_ns bounds claims host started_monotonic_ns started_unix_ns descriptor_count_before sources original_metadata summary event_count error cleanup_errors cleanup_complete descriptor_count_after events_sha256 completed_monotonic_ns completed_unix_ns",
    )
    require(
        capture["format"] == "original-file-range-capture-v1"
        and capture["invocation"] == invocation
        and capture["source_sha256"] == source_sha256,
        "foreign or replayed original capture",
    )
    require(
        identity(capture["original_identity"]) == expected_identity,
        "unexpected original descriptor identity",
    )
    require(
        integer(capture["maximum_bytes"]) == maximum_bytes
        and integer(capture["maximum_duration_ns"], 1) == maximum_duration_ns,
        "changed declared budgets",
    )
    fields(capture["bounds"], " ".join(BOUNDS))
    require(
        all(integer(capture["bounds"][key]) == value for key, value in BOUNDS.items()),
        "changed hard scan bounds",
    )
    claims(capture["claims"])
    require(
        capture["error"] is None
        and capture["cleanup_complete"] is True
        and capture["cleanup_errors"] == []
        and integer(capture["descriptor_count_before"], 1)
        == integer(capture["descriptor_count_after"], 1),
        "failed or unretired acquisition",
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
    fields(capture["host"], "kernel_release architecture effective_uid boot_id")
    for name in ["kernel_release", "architecture"]:
        require(
            type(capture["host"][name]) is str
            and re.fullmatch(r"[A-Za-z0-9._+-]{1,256}", capture["host"][name]),
            "invalid original host",
        )
    require(
        type(capture["host"]["boot_id"]) is str
        and str(uuid.UUID(capture["host"]["boot_id"])) == capture["host"]["boot_id"],
        "invalid original boot identity",
    )
    uid = integer(capture["host"]["effective_uid"])
    require(uid < 2**32, "invalid effective uid")
    started = integer(capture["started_monotonic_ns"], 1)
    completed = integer(capture["completed_monotonic_ns"], started)
    wall_start = integer(capture["started_unix_ns"], 1)
    wall_end = integer(capture["completed_unix_ns"], wall_start)
    require(
        abs((wall_end - wall_start) - (completed - started)) <= 5 * 10**9,
        "inconsistent capture clocks",
    )
    summary = capture["summary"]
    fields(
        summary,
        "format before after authority observer page_size maximum_bytes maximum_duration_ns covered_bytes extent_count resident_payload_bytes_observed_sum extent_acquisition_ns_sum started_monotonic_ns completed_monotonic_ns acquisition_ns original_byte_range_covered claims",
    )
    require(
        summary["format"] == "original-file-range-scan-v1"
        and summary["original_byte_range_covered"] is True,
        "incomplete range summary",
    )
    claims(summary["claims"])
    require(
        summary["before"] == summary["after"] == capture["original_metadata"],
        "original changed across full range",
    )
    metadata(summary["before"], expected_identity, uid)
    metadata(summary["after"], expected_identity, uid)
    metadata(capture["original_metadata"], expected_identity, uid)
    authority(summary["authority"], uid)
    actor = observer(summary["observer"])
    page = integer(summary["page_size"], 4096)
    require(
        page <= 1024 * 1024
        and page & (page - 1) == 0
        and BOUNDS["max_extent_bytes"] % page == 0,
        "unsupported page geometry",
    )
    size = integer(summary["covered_bytes"])
    require(
        size == summary["before"]["size"] <= maximum_bytes
        and integer(summary["maximum_bytes"]) == maximum_bytes
        and integer(summary["maximum_duration_ns"], 1) == maximum_duration_ns,
        "original range or budgets changed",
    )
    span_start = integer(summary["started_monotonic_ns"], started)
    span_end = integer(summary["completed_monotonic_ns"], span_start)
    require(
        started <= span_start <= span_end <= completed
        and integer(summary["acquisition_ns"])
        == span_end - span_start
        <= maximum_duration_ns,
        "unmeasured or over-budget acquisition",
    )
    count = (size + BOUNDS["max_extent_bytes"] - 1) // BOUNDS["max_extent_bytes"]
    require(
        integer(summary["extent_count"]) == integer(capture["event_count"]) == count,
        "incomplete original extent count",
    )
    raw = read_regular(root, "events.jsonl", MAX_RECORD_BYTES)
    require(
        sha256(raw) == hash_value(capture["events_sha256"])
        and (not raw or raw.endswith(b"\n")),
        "changed or truncated original records",
    )
    offset = 0
    previous = span_start
    resident_sum = 0
    cost_sum = 0
    actual_count = 0
    for line in io.BytesIO(raw):
        require(
            len(line) <= 65536 and actual_count < count,
            "oversized or extra extent record",
        )
        event = decode(line)
        fields(
            event,
            "invocation source_sha256 sequence observer before after authority offset length page_size resident_vector_hex resident_payload_bytes started_monotonic_ns mapped_monotonic_ns query_started_monotonic_ns query_completed_monotonic_ns completed_monotonic_ns acquisition_ns mapping_released",
        )
        require(
            event["invocation"] == invocation
            and event["source_sha256"] == source_sha256
            and integer(event["sequence"]) == actual_count,
            "foreign or reordered original extent",
        )
        require(
            observer(event["observer"]) == actor
            and event["authority"] == summary["authority"]
            and event["before"] == event["after"] == summary["before"],
            "changed original authority, generation or metadata",
        )
        metadata(event["before"], expected_identity, uid)
        metadata(event["after"], expected_identity, uid)
        authority(event["authority"], uid)
        length = min(BOUNDS["max_extent_bytes"], size - offset)
        require(
            integer(event["offset"]) == offset
            and integer(event["length"], 1) == length
            and integer(event["page_size"]) == page,
            "missing or overlapping original range",
        )
        vector = event["resident_vector_hex"]
        require(
            type(vector) is str and re.fullmatch(r"(?:00|01)+", vector),
            "invalid original mincore vector",
        )
        vector = bytes.fromhex(vector)
        require(
            len(vector) == (length + page - 1) // page,
            "incomplete original page vector",
        )
        resident = sum(
            min(page, length - index * page)
            for index, present in enumerate(vector)
            if present
        )
        require(
            integer(event["resident_payload_bytes"]) == resident,
            "wrong observed resident payload count",
        )
        clocks = [
            integer(event[name], 1)
            for name in [
                "started_monotonic_ns",
                "mapped_monotonic_ns",
                "query_started_monotonic_ns",
                "query_completed_monotonic_ns",
                "completed_monotonic_ns",
            ]
        ]
        require(
            previous
            <= clocks[0]
            <= clocks[1]
            <= clocks[2]
            <= clocks[3]
            <= clocks[4]
            <= span_end
            and integer(event["acquisition_ns"]) == clocks[4] - clocks[0]
            and event["mapping_released"] is True,
            "invalid original clocks or mapping retirement",
        )
        previous = clocks[-1]
        offset += length
        resident_sum += resident
        cost_sum += event["acquisition_ns"]
        actual_count += 1
    require(offset == size and actual_count == count, "missing original file suffix")
    require(
        integer(summary["resident_payload_bytes_observed_sum"]) == resident_sum
        and integer(summary["extent_acquisition_ns_sum"])
        == cost_sum
        <= span_end - span_start,
        "inconsistent original point totals or costs",
    )
    require(
        original_hash(root, size) == hash_value(capture["original_sha256"]),
        "complete original payload hash mismatch",
    )
    return {
        "format": "original-file-range-report-v1",
        "invocation": invocation,
        "source_sha256": source_sha256,
        "capture_sha256": capture_sha256,
        "original_identity": capture["original_identity"],
        "covered_bytes": size,
        "extent_count": count,
        "resident_payload_bytes_observed_sum": resident_sum,
        "acquisition_ns": span_end - span_start,
        "cleanup_complete": True,
        "scope": "sequential original-file extent observations; no simultaneous total or interval bound",
        "claims": {name: False for name in CLAIMS},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--invocation", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--capture-sha256", required=True)
    parser.add_argument("--device", type=int, required=True)
    parser.add_argument("--inode", type=int, required=True)
    parser.add_argument("--maximum-bytes", type=int, required=True)
    parser.add_argument("--maximum-duration-ns", type=int, required=True)
    args = parser.parse_args()
    try:
        result = replay(
            args.root,
            args.invocation,
            args.source_sha256,
            args.capture_sha256,
            (args.device, args.inode),
            args.maximum_bytes,
            args.maximum_duration_ns,
        )
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
