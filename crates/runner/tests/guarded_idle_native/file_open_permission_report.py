"""Strict original qualification replay; never executes archived code/evidence."""

import argparse
import hashlib
import json
import re
import stat
import uuid
from pathlib import Path

from file_open_permission import EVENT, FAN_ONDIR, FAN_OPEN_PERM
from file_open_permission_probe import CLAIMS, PAYLOAD
from file_residency import require
from file_residency_report import decode as strict_json
from file_residency_report import fields, integer, read_regular


def disposition(value, original, pid):
    fields(
        value,
        "event decision response_started_ns response_completed_ns event_descriptors_closed",
    )
    event = value["event"]
    fields(event, "raw_hex device inode pid observed_ns")
    for key in ("device", "inode", "pid"):
        integer(event[key])
    require(
        type(event["raw_hex"]) is str
        and re.fullmatch(r"[0-9a-f]{64}", event["raw_hex"]),
        "invalid original kernel event",
    )
    size, version, reserved, meta, mask, fd, event_pid, kind, pad, info, pidfd = (
        EVENT.unpack(bytes.fromhex(event["raw_hex"]))
    )
    require(
        (size, version, reserved, meta, mask, kind, pad, info)
        == (32, 3, 0, 24, FAN_OPEN_PERM, 4, 0, 8),
        "unexpected original kernel event layout",
    )
    require(
        fd >= 0 and pidfd >= 0 and fd != pidfd and event_pid == pid == event["pid"],
        "foreign kernel process identity",
    )
    require(
        (event["device"], event["inode"]) == (original["device"], original["inode"]),
        "foreign original file identity",
    )
    require(
        value["decision"] in ("allow", "deny")
        and value["event_descriptors_closed"] is True,
        "incomplete event disposition",
    )
    observed = integer(event["observed_ns"], 1)
    started = integer(value["response_started_ns"], 1)
    completed = integer(value["response_completed_ns"], 1)
    require(observed <= started <= completed, "invalid event phase clocks")
    return observed, completed


def validate(raw, source, capture, directory, *, original_directory=False):
    require(type(original_directory) is bool, "directory selector must be boolean")
    require(type(raw) is bytes and 0 < len(raw) <= 65536, "unbounded original record")
    require(
        re.fullmatch(r"[0-9a-f]{40}", source)
        and re.fullmatch(r"[0-9a-f]{64}", capture),
        "invalid trusted source/capture binding",
    )
    require(
        hashlib.sha256(raw).hexdigest() == capture, "original capture digest mismatch"
    )
    value = strict_json(raw)
    fields(
        value,
        "schema source_commit run_id host controller invocation started_ns payload_sha256 cases claims error complete original borrowed_original_closed completed_ns"
        + (" child mark_mask" if original_directory else ""),
    )
    require(
        value["schema"]
        == (
            "original-directory-open-permission-v1"
            if original_directory
            else "original-open-permission-v1"
        )
        and value["source_commit"] == source,
        "foreign source or schema",
    )
    require(str(uuid.UUID(value["run_id"])) == value["run_id"], "invalid run identity")
    fields(value["host"], "boot_id kernel")
    require(
        str(uuid.UUID(value["host"]["boot_id"])) == value["host"]["boot_id"]
        and type(value["host"]["kernel"]) is str
        and 0 < len(value["host"]["kernel"]) <= 256,
        "invalid host identity",
    )
    controller = value["controller"]
    fields(controller, "pid task uid")
    integer(controller["pid"], 1)
    integer(controller["uid"])
    require(
        type(controller["task"]) is list and len(controller["task"]) == 2,
        "invalid controller task",
    )
    for item in controller["task"]:
        integer(item, 1)
    invocation = value["invocation"]
    require(
        type(invocation) is list
        and len(invocation) == (7 if original_directory else 6)
        and all(type(item) is str and 0 < len(item) <= 4096 for item in invocation),
        "invalid invocation",
    )
    require(
        Path(invocation[0]).is_absolute()
        and Path(invocation[1]).is_absolute()
        and Path(invocation[1]).name == "file_open_permission_probe.py"
        and invocation[2:]
        == ["--output-dir", directory, "--source-commit", source]
        + (["--directory"] if original_directory else [])
        and Path(directory).is_absolute(),
        "foreign original invocation",
    )
    original = value["original"]
    fields(
        original,
        "device inode uid size links mtime_ns ctime_ns"
        + (" file_type" if original_directory else ""),
    )
    for item in original.values():
        integer(item)
    require(
        original["inode"] > 0
        and original["uid"] == controller["uid"]
        and (
            original["links"] >= 1
            if original_directory
            else original["links"] == 1 and original["size"] == len(PAYLOAD)
        ),
        "invalid original file authority",
    )
    if original_directory:
        require(
            integer(value["mark_mask"]) == (FAN_OPEN_PERM | FAN_ONDIR),
            "invalid original directory mark mask",
        )
        require(original["file_type"] == stat.S_IFDIR, "original is not a directory")
        child = value["child"]
        fields(child, "device inode uid size links mtime_ns ctime_ns")
        for item in child.values():
            integer(item)
        require(
            child["inode"] > 0
            and child["device"] == original["device"]
            and child["inode"] != original["inode"]
            and child["uid"] == controller["uid"]
            and child["links"] == 1
            and child["size"] == len(PAYLOAD),
            "invalid original child authority",
        )
    require(
        value["payload_sha256"] == hashlib.sha256(PAYLOAD).hexdigest(),
        "foreign qualification payload",
    )
    require(
        value["claims"] == CLAIMS
        and all(item is False for item in value["claims"].values()),
        "inflated qualification claims",
    )
    require(
        value["error"] is None
        and value["complete"] is True
        and value["borrowed_original_closed"] is True,
        "incomplete original qualification",
    )
    beginning = integer(value["started_ns"], 1)
    ending = integer(value["completed_ns"], 1)
    require(
        beginning <= ending <= beginning + 90_000_000_000,
        "unbounded qualification clocks",
    )
    cases = value["cases"]
    require(
        type(cases) is list
        and [case.get("kind") for case in cases] == ["allow", "deny", "retire"],
        "incomplete original cases",
    )
    previous = beginning
    pids = set()
    for case in cases:
        fields(
            case,
            "kind started_ns producer_pid disposition producer cleanup completed_ns",
        )
        started = integer(case["started_ns"], 1)
        completed = integer(case["completed_ns"], 1)
        require(
            previous <= started <= completed <= min(ending, started + 30_000_000_000),
            "invalid case clocks",
        )
        pid = integer(case["producer_pid"], 1)
        require(
            pid not in pids and pid != controller["pid"], "reused producer identity"
        )
        pids.add(pid)
        observed, responded = disposition(case["disposition"], original, pid)
        allow = case["kind"] == "allow"
        require(
            case["disposition"]["decision"] == ("allow" if allow else "deny"),
            "wrong original disposition",
        )
        producer = case["producer"]
        fields(producer, "pid exit stdout_hex stderr_hex joined_ns")
        joined = integer(producer["joined_ns"], 1)
        require(
            type(producer["exit"]) is int
            and producer["pid"] == pid
            and producer["exit"] == (0 if allow else 23)
            and producer["stderr_hex"] == "",
            "unjoined or failed original producer",
        )
        require(
            type(producer["stdout_hex"]) is str and len(producer["stdout_hex"]) <= 2048,
            "unbounded producer output",
        )
        result = strict_json(bytes.fromhex(producer["stdout_hex"]))
        expected = {"payload_hex": PAYLOAD.hex()} if allow else {"errno": 1}
        if original_directory and allow:
            fields(result, "payload_hex directory child")
            for owner, names in (
                ("directory", "device inode file_type"),
                ("child", "device inode"),
            ):
                fields(result[owner], names)
                for item in result[owner].values():
                    integer(item)
            expected["directory"] = {
                key: original[key] for key in ("device", "inode", "file_type")
            }
            expected["child"] = {
                key: value["child"][key] for key in ("device", "inode")
            }
        require(
            result == expected,
            "incorrect original producer outcome",
        )
        if not allow:
            require(type(result["errno"]) is int, "invalid producer errno")
        cleanup = case["cleanup"]
        fields(
            cleanup,
            "started_ns completed_ns denied mark_removed group_closed original_duplicate_closed observation_failed",
        )
        cleanup_start = integer(cleanup["started_ns"], 1)
        cleanup_end = integer(cleanup["completed_ns"], 1)
        require(
            all(
                cleanup[key] is True
                for key in ("mark_removed", "group_closed", "original_duplicate_closed")
            ),
            "incomplete original gate retirement",
        )
        require(cleanup["observation_failed"] is False, "failed kernel observation")
        require(
            started <= observed <= responded <= joined <= completed
            and started <= cleanup_start <= cleanup_end <= completed,
            "invalid disposition/join/retirement order",
        )
        if case["kind"] == "retire":
            require(
                cleanup["denied"] == [case["disposition"]]
                and cleanup_start <= observed <= responded <= cleanup_end <= joined,
                "retirement lost queued original ownership",
            )
        else:
            require(
                cleanup["denied"] == [] and joined <= cleanup_start,
                "retirement preceded producer join",
            )
        previous = completed
    return {
        "schema": value["schema"],
        "source_commit": source,
        "capture_sha256": capture,
        "run_id": value["run_id"],
        "original_cases": 3,
        "claims": CLAIMS.copy(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("record", type=Path)
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--expected-capture-sha256", required=True)
    parser.add_argument("--expected-directory", required=True)
    parser.add_argument(
        "--directory",
        action="store_true",
        help="require explicit original-directory evidence",
    )
    args = parser.parse_args()
    try:
        raw = read_regular(args.record.parent, args.record.name, 65536)
        result = validate(
            raw,
            args.expected_source,
            args.expected_capture_sha256,
            args.expected_directory,
            original_directory=args.directory,
        )
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        parser.exit(1, f"original permission evidence rejected: {error}\n")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
