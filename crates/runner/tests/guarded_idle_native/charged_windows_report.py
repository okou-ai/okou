"""Strict original-file replay of charged-window qualification, not native proof."""

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import uuid
from pathlib import Path, PurePosixPath

MIB = 1024 * 1024
SOURCES = (
    "charged_windows.py",
    "charged_windows_probe.py",
    "charged_windows_worker.py",
    "charged_windows_report.py",
)
CLAIMS = {
    "relevant_native_residency_complete": False,
    "native_guest_executed": False,
    "cold_inputs_established": False,
    "production_protection_established": False,
}
BOUNDS = {
    "minimum_available_bytes": 8192 * MIB,
    "duration_seconds": 60,
    "memory_limit_bytes": 256 * MIB,
    "max_events": 16,
    "max_worker_response_bytes": 4096,
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, positive=False):
    require(
        type(value) is int and (1 if positive else 0) <= value < 2**64,
        "invalid integer or clock",
    )
    return value


def keys(value, expected):
    require(
        type(value) is dict and set(value) == set(expected.split()),
        "unexpected or missing fields",
    )


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


def decode(raw):
    return json.loads(
        raw,
        object_pairs_hook=object_pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")),
    )


def read_regular(root, name, limit):
    fd = os.open(
        root / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
    )
    try:
        before = os.fstat(fd)
        require(
            stat.S_ISREG(before.st_mode) and before.st_size <= limit,
            "invalid original file",
        )
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(fd)
        require(
            len(raw) <= limit
            and (before.st_dev, before.st_ino, before.st_size, before.st_ctime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_ctime_ns),
            "original file changed",
        )
        return raw
    finally:
        os.close(fd)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def hash_value(value):
    require(
        type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value),
        "invalid source/file hash",
    )
    return value


def file_identity(value):
    keys(value, "device inode")
    return number(value["device"]), number(value["inode"], True)


def span(value):
    started = number(value["started_monotonic_ns"], True)
    completed = number(value["completed_monotonic_ns"], True)
    require(started <= completed, "reversed acquisition span")
    return started, completed


def worker_identity(value, leaf):
    keys(value, "pid start_ticks cgroup")
    number(value["pid"], True)
    number(value["start_ticks"], True)
    require(
        value["cgroup"] == "0::" + leaf.removeprefix("/sys/fs/cgroup"),
        "foreign worker membership",
    )


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
        "acquisition failed; retain the original capture.json error",
    )
    keys(
        capture,
        "format invocation source_sha256 sources boot_id host parent_identity started_monotonic_ns started_unix_ns "
        "completed_monotonic_ns completed_unix_ns bounds parent root leaf leaf_identity claims requests worker "
        "worker_ready_monotonic_ns positive_wait_monotonic_ns exit_code wait_confirmed cleanup_intervened "
        "cleanup_errors cleanup_records adopted_waits error initial_available_bytes final_available_bytes "
        "retained_file event_count events_sha256 stderr_bytes",
    )
    require(
        capture["format"] == "owned-charged-window-qualification-v1",
        "unsupported qualification format",
    )
    require(capture["invocation"] == invocation, "replayed or foreign invocation")
    require(
        str(uuid.UUID(capture["boot_id"])) == capture["boot_id"],
        "invalid boot identity",
    )
    keys(capture["host"], "kernel_release architecture effective_uid")
    for field in ("kernel_release", "architecture"):
        require(
            type(capture["host"][field]) is str
            and re.fullmatch(r"[A-Za-z0-9._+-]{1,256}", capture["host"][field]),
            "invalid original host context",
        )
    require(number(capture["host"]["effective_uid"]) < 2**32, "invalid acquisition uid")
    parent_id = file_identity(capture["parent_identity"])
    require(
        capture["error"] is None
        and capture["cleanup_errors"] == []
        and capture["adopted_waits"] == [],
        "failed or incomplete acquisition",
    )
    require(
        capture["wait_confirmed"] is True and capture["cleanup_intervened"] is False,
        "missing positive wait or intervened cleanup",
    )
    require(
        type(capture["exit_code"]) is int and capture["exit_code"] == 0, "failed worker"
    )
    keys(capture["claims"], " ".join(CLAIMS))
    require(
        all(capture["claims"][key] is False for key in CLAIMS),
        "unsupported completeness/native claim",
    )
    keys(capture["bounds"], " ".join(BOUNDS))
    require(
        all(
            type(capture["bounds"][key]) is int and capture["bounds"][key] == value
            for key, value in BOUNDS.items()
        ),
        "changed qualification bounds",
    )
    require(set(capture["sources"]) == set(SOURCES), "missing original source")
    sources = {name: sha256(read_regular(root, name, 65536)) for name in SOURCES}
    require(capture["sources"] == sources, "original source bytes changed")
    require(
        sha256(json.dumps(sources, sort_keys=True, separators=(",", ":")).encode())
        == source_sha256
        == capture["source_sha256"],
        "source bundle mismatch",
    )
    started, completed = span(capture)
    require(completed - started <= 60 * 10**9, "qualification deadline exceeded")
    wall_elapsed = number(capture["completed_unix_ns"], True) - number(
        capture["started_unix_ns"], True
    )
    require(
        wall_elapsed >= 0 and abs(wall_elapsed - (completed - started)) <= 2 * 10**9,
        "inconsistent original clocks",
    )
    for field in ("initial_available_bytes", "final_available_bytes"):
        require(
            number(capture[field]) >= BOUNDS["minimum_available_bytes"],
            "headroom qualification failed",
        )
    parent = PurePosixPath(capture["parent"])
    require(
        str(parent) == capture["parent"]
        and ".." not in parent.parts
        and (
            parent == PurePosixPath("/sys/fs/cgroup")
            or PurePosixPath("/sys/fs/cgroup") in parent.parents
        ),
        "invalid original cgroup parent",
    )
    require(
        capture["root"] == str(parent / ("okou-charge-" + invocation)),
        "foreign cgroup generation",
    )
    leaf = str(PurePosixPath(capture["root"]) / "counter-1/workload")
    require(capture["leaf"] == leaf, "foreign leaf")
    leaf_id = file_identity(capture["leaf_identity"])
    worker_identity(capture["worker"], leaf)
    raw = read_regular(root, "events.jsonl", 65536)
    require(
        sha256(raw) == hash_value(capture["events_sha256"]),
        "original acquisition bytes changed",
    )
    require(raw.endswith(b"\n"), "truncated acquisition records")
    rows = [decode(line) for line in raw.splitlines()]
    require(
        type(capture["event_count"]) is int
        and capture["event_count"] == len(rows) == 6,
        "missing or extra qualification record",
    )
    expected = [
        ("outer", "begin"),
        ("outer", "observe"),
        ("inner", "begin"),
        ("outer", "observe"),
        ("inner", "end"),
        ("outer", "end"),
    ]
    counters = {}
    peaks = {}
    last_clock = started
    for sequence, (row, (name, operation)) in enumerate(zip(rows, expected)):
        keys(
            row,
            "sequence invocation name operation counter started_monotonic_ns "
            "reset_completed_monotonic_ns completed_monotonic_ns current_bytes peak_bytes file_bytes",
        )
        require(
            type(row["sequence"]) is int
            and row["sequence"] == sequence
            and row["invocation"] == invocation
            and row["name"] == name
            and row["operation"] == operation,
            "replayed or misattributed window record",
        )
        began, ended = span(row)
        require(
            last_clock <= began <= ended <= completed,
            "acquisition clock/order mismatch",
        )
        last_clock = ended
        if operation == "begin":
            require(
                began <= number(row["reset_completed_monotonic_ns"], True) <= ended,
                "missing reset custody",
            )
        else:
            require(
                row["reset_completed_monotonic_ns"] is None, "unexpected counter reset"
            )
        keys(row["counter"], "group peak")
        file_identity(row["counter"]["group"])
        keys(row["counter"]["peak"], "device inode descriptor")
        for field in ("device", "inode", "descriptor"):
            number(row["counter"]["peak"][field], field != "device")
        if name in counters:
            require(row["counter"] == counters[name], "original counter or FD changed")
        else:
            counters[name] = row["counter"]
        for field in ("current_bytes", "peak_bytes", "file_bytes"):
            number(row[field])
        require(
            row["peak_bytes"] >= row["current_bytes"],
            "peak is below the earlier current observation",
        )
        require(row["peak_bytes"] >= peaks.get(name, 0), "counter lost an earlier peak")
        peaks[name] = row["peak_bytes"]
    require(
        file_identity(counters["outer"]["group"])
        != file_identity(counters["inner"]["group"])
        and leaf_id
        not in [file_identity(value["group"]) for value in counters.values()],
        "shared cgroup counter object",
    )
    group_ids = [file_identity(value["group"]) for value in counters.values()]
    require(
        parent_id not in group_ids + [leaf_id]
        and all(value[0] == parent_id[0] for value in group_ids + [leaf_id])
        and all(value["peak"]["device"] == parent_id[0] for value in counters.values()),
        "foreign counter filesystem or parent identity",
    )
    require(
        counters["outer"]["peak"] != counters["inner"]["peak"]
        and counters["outer"]["peak"]["descriptor"]
        != counters["inner"]["peak"]["descriptor"]
        and (counters["outer"]["peak"]["device"], counters["outer"]["peak"]["inode"])
        != (counters["inner"]["peak"]["device"], counters["inner"]["peak"]["inode"]),
        "shared peak descriptor/object",
    )
    require(
        rows[1]["peak_bytes"] - rows[2]["peak_bytes"] > 16 * MIB
        and rows[3]["peak_bytes"] >= rows[1]["peak_bytes"],
        "overlap reset isolation not qualified",
    )
    require(
        rows[4]["peak_bytes"] > rows[2]["peak_bytes"] + 8 * MIB
        and rows[4]["peak_bytes"] > rows[4]["current_bytes"] + 8 * MIB,
        "between-observation descendant peak missing",
    )
    require(rows[5]["file_bytes"] >= 64 * MIB, "post-exit retained charge missing")
    requests = capture["requests"]
    require(type(requests) is list and len(requests) == 5, "missing worker phase")
    response_fields = [
        "completed held_bytes",
        "completed released_bytes",
        "completed child child_exit_code child_wait_confirmed",
        "completed file",
        "completed",
    ]
    for request, name, fields in zip(
        requests, ("allocate", "release", "transient", "file", "exit"), response_fields
    ):
        keys(request, "command response started_monotonic_ns completed_monotonic_ns")
        require(request["command"] == name, "worker phase order mismatch")
        keys(request["response"], fields)
        require(request["response"]["completed"] == name, "foreign worker response")
        span(request)
    require(
        type(requests[0]["response"]["held_bytes"]) is int
        and requests[0]["response"]["held_bytes"] == 32 * MIB
        and type(requests[1]["response"]["released_bytes"]) is int
        and requests[1]["response"]["released_bytes"] == 32 * MIB,
        "original held allocation/release custody missing",
    )
    transient = requests[2]["response"]
    keys(transient["child"], "identity touched_bytes")
    worker_identity(transient["child"]["identity"], leaf)
    require(
        transient["child"]["identity"]["pid"] != capture["worker"]["pid"]
        and type(transient["child"]["touched_bytes"]) is int
        and transient["child"]["touched_bytes"] == 16 * MIB
        and transient["child_wait_confirmed"] is True
        and type(transient["child_exit_code"]) is int
        and transient["child_exit_code"] == 0,
        "transient descendant custody missing",
    )
    boundaries = [
        rows[0]["completed_monotonic_ns"],
        number(capture["worker_ready_monotonic_ns"], True),
        requests[0]["started_monotonic_ns"],
        requests[0]["completed_monotonic_ns"],
        rows[1]["started_monotonic_ns"],
        rows[1]["completed_monotonic_ns"],
        requests[1]["started_monotonic_ns"],
        requests[1]["completed_monotonic_ns"],
        rows[2]["started_monotonic_ns"],
        rows[2]["completed_monotonic_ns"],
        rows[3]["started_monotonic_ns"],
        rows[3]["completed_monotonic_ns"],
        requests[2]["started_monotonic_ns"],
        requests[2]["completed_monotonic_ns"],
        rows[4]["started_monotonic_ns"],
        rows[4]["completed_monotonic_ns"],
        requests[3]["started_monotonic_ns"],
        requests[3]["completed_monotonic_ns"],
        requests[4]["started_monotonic_ns"],
        requests[4]["completed_monotonic_ns"],
        number(capture["positive_wait_monotonic_ns"], True),
        rows[5]["started_monotonic_ns"],
    ]
    require(boundaries == sorted(boundaries), "phase/positive-wait clock mismatch")
    retained = capture["retained_file"]
    keys(retained, "device inode bytes sha256")
    keys(requests[3]["response"]["file"], "device inode bytes")
    file_identity({k: retained[k] for k in ("device", "inode")})
    require(
        type(retained["bytes"]) is int
        and retained["bytes"] == 64 * MIB
        and requests[3]["response"]["file"]
        == {k: retained[k] for k in ("device", "inode", "bytes")},
        "retained file generation mismatch",
    )
    retained_raw = read_regular(root, "retained.bin", 64 * MIB)
    require(
        len(retained_raw) == 64 * MIB
        and sha256(retained_raw) == hash_value(retained["sha256"]),
        "retained file bytes changed",
    )
    require(
        type(capture["stderr_bytes"]) is int
        and capture["stderr_bytes"] == 0
        and read_regular(root, "worker.stderr", 65536) == b"",
        "worker diagnostics indicate failure",
    )
    cleanup = capture["cleanup_records"]
    require(
        type(cleanup) is list and len(cleanup) == 3,
        "missing empty-subtree cleanup receipt",
    )
    paths = [leaf, str(PurePosixPath(capture["root"]) / "counter-1"), capture["root"]]
    ids = [
        leaf_id,
        file_identity(counters["inner"]["group"]),
        file_identity(counters["outer"]["group"]),
    ]
    last_clock = rows[5]["completed_monotonic_ns"]
    for row, path, original_id in zip(cleanup, paths, ids):
        keys(
            row,
            "path identity started_monotonic_ns completed_monotonic_ns populated processes_empty removed",
        )
        began, ended = span(row)
        require(
            row["path"] == path
            and file_identity(row["identity"]) == original_id
            and type(row["populated"]) is int
            and row["populated"] == 0
            and row["processes_empty"] is True
            and row["removed"] is True
            and last_clock <= began <= ended <= completed,
            "incomplete or foreign cleanup",
        )
        last_clock = ended
    return {
        "format": "owned-charged-window-qualification-report-v1",
        "qualified": True,
        "invocation": invocation,
        "source_sha256": source_sha256,
        "scope": "owned-subtree memory-controller charges; outside-charge residency excluded",
        "windows": {name: {"peak_bytes": peaks[name]} for name in counters},
        "overlap_reset_isolation": True,
        "between_observation_peak_captured": True,
        "post_exit_file_charge_bytes": rows[5]["file_bytes"],
        "elapsed_ns": completed - started,
        "counter_acquisition_ns": sum(span(row)[1] - span(row)[0] for row in rows),
        "claims": dict(CLAIMS),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--invocation", required=True)
    parser.add_argument("--source-sha256", required=True)
    args = parser.parse_args()
    try:
        report = replay(args.directory, args.invocation, args.source_sha256)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
