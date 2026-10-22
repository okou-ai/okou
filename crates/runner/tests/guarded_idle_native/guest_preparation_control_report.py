"""Strict replay of original Guest component captures; never executes evidence."""

import argparse
import hashlib
import json
from pathlib import Path
import re

from file_open_permission_report import disposition
from file_residency import require
from file_residency_report import decode, fields, integer, read_regular
from final_exec_report import Payload

FILES = ("qualification.json", "exec-request.bin", "exec-terminal.bin",
         "helper-stdin.json", "helper-stdout.bin", "helper-stderr.bin",
         "controller-terminal.txt", "control-0-response.bin") + tuple(
             f"control-{index}-{kind}.bin" for index in range(1, 7)
             for kind in ("request", "response"))
PAYLOADS = {name: f"original {name}\n".encode().hex()
            for name in ("current", "retained", "stale")}


def unhex(value, maximum=65536):
    require(type(value) is str and len(value) <= maximum * 2
            and re.fullmatch(r"(?:[0-9a-f]{2})*", value) is not None, "invalid hex output")
    return bytes.fromhex(value)


def frame(raw, kind):
    require(9 <= len(raw) <= 131584 and int.from_bytes(raw[:4], "big") == len(raw)-4
            and raw[4] == kind, "invalid original exec frame")
    sequence = int.from_bytes(raw[5:9], "big")
    require(sequence > 0, "invalid original request sequence")
    return sequence, Payload(raw[9:])


def control(raw, nonce, sequence, names):
    require(4 < len(raw) <= 16388 and int.from_bytes(raw[:4], "big") == len(raw)-4,
            "invalid original control frame")
    value = decode(raw[4:])
    fields(value, names)
    require(value["nonce"] == nonce and integer(value["id"]) == sequence,
            "foreign/repeated control frame")
    return value


def identity(value, *, directory=False):
    fields(value, "device inode uid size links mtime_ns ctime_ns"
           + (" file_type" if directory else ""))
    for item in value.values():
        integer(item)
    require(value["inode"] > 0 and value["uid"] == 0 and value["links"] > 0,
            "invalid original authority")
    if directory:
        require(value["file_type"] == 0o40000, "not an original directory")


def validate(directory, source, capture):
    require(re.fullmatch(r"[0-9a-f]{40}", source) is not None
            and re.fullmatch(r"[0-9a-f]{64}", capture) is not None, "invalid trusted binding")
    raw = read_regular(directory, "capture.json", 8192)
    require(hashlib.sha256(raw).hexdigest() == capture, "original capture hash mismatch")
    manifest = decode(raw)
    fields(manifest, "source_commit files")
    require(manifest["source_commit"] == source, "foreign capture source")
    fields(manifest["files"], " ".join(FILES))
    files = {}
    for name in FILES:
        files[name] = read_regular(directory, name, 131584)
        require(hashlib.sha256(files[name]).hexdigest() == manifest["files"][name],
                "original capture file changed")
    record = decode(files["qualification.json"])
    fields(record, "schema source_commit allow nonce controller_joined exchange_joined "
           "connection_joined vm_containment_only runner_final_exec_established "
           "cancellation_custody_established saving_lease_cleanup_established")
    require(record["schema"] == "native-guest-preparation-component-v1"
            and record["source_commit"] == source and type(record["allow"]) is bool,
            "foreign component source/schema/decision")
    for key in ("controller_joined", "exchange_joined", "connection_joined", "vm_containment_only"):
        require(record[key] is True, "incomplete original producer join")
    for key in ("runner_final_exec_established", "cancellation_custody_established",
                "saving_lease_cleanup_established"):
        require(record[key] is False, "inflated Runner component claim")
    allow, nonce = record["allow"], record["nonce"]
    require(type(nonce) is str and re.fullmatch(r"[0-9a-f]{32}", nonce), "invalid nonce")
    hello = control(files["control-0-response.bin"], nonce, 0,
                    "nonce id ready uid original executable kernel")
    require(hello["ready"] is True and integer(hello["uid"]) == 0
            and type(hello["kernel"]) is str and 0 < len(hello["kernel"]) <= 256,
            "invalid Guest readiness")
    identity(hello["original"], directory=True)
    identity(hello["executable"])
    commands = [{"op": "start"}, {"op": "observe"}, {"op": "status"},
                {"op": "decide", "event_id": 1, "allow": allow},
                {"op": "join"}, {"op": "retire"}]
    answers = []
    for index, command in enumerate(commands, 1):
        request = control(files[f"control-{index}-request.bin"], nonce, index, "nonce id command")
        require(request["command"] == command
                and (index != 4 or type(request["command"]["event_id"]) is int
                     and type(request["command"]["allow"]) is bool), "changed control command")
        answers.append(control(files[f"control-{index}-response.bin"], nonce, index,
                               "nonce id result")["result"])
    start, event, status, decision, joined, retired = answers
    fields(start, "child_pid request_hex argv workload started_ns")
    pid = integer(start["child_pid"], 1)
    workload = start["workload"]
    require(type(workload) is str
            and re.fullmatch(r"0::/vm0-exec/[^/\n]+/workload\n", workload), "invalid workload")
    argv = ["/usr/local/bin/guest-agent", "prepare-for-reuse"]
    require(start["argv"] == argv, "substituted helper argv")
    fields(event, "event_id event executable argv workload child_pid")
    require(integer(event["event_id"]) == 1 and integer(event["child_pid"]) == pid
            and event["argv"] == argv and event["executable"] == hello["executable"]
            and event["workload"] == workload, "foreign actual helper")
    identity(event["executable"])
    fields(status, "held original payloads workload observed_ns")
    identity(status["original"], directory=True)
    require(status["held"] is True and status["original"] == hello["original"]
            and status["payloads"] == PAYLOADS and status["workload"] == workload,
            "changed held original authority")
    fields(decision, "event decision response_started_ns response_completed_ns "
           "event_descriptors_closed retirement")
    require(decision["event"] == event["event"]
            and decision["decision"] == ("allow" if allow else "deny"), "foreign event decision")
    disposition({key: value for key, value in decision.items() if key != "retirement"},
                hello["original"], pid)
    cleanup = decision["retirement"]
    fields(cleanup, "started_ns completed_ns denied mark_removed group_closed "
           "original_duplicate_closed observation_failed")
    for key in ("mark_removed", "group_closed", "original_duplicate_closed"):
        require(cleanup[key] is True, "incomplete gate retirement")
    require(cleanup["denied"] == [] and cleanup["observation_failed"] is False
            and integer(decision["response_completed_ns"], 1) <= integer(cleanup["started_ns"], 1)
            <= integer(cleanup["completed_ns"], 1), "failed/invalid gate retirement")
    fields(joined, "helper_joined returncode stdout_hex stderr_hex request_hex payloads child_pid joined_ns")
    require(joined["helper_joined"] is True and integer(joined["child_pid"], 1) == pid
            and type(joined["returncode"]) is int and joined["returncode"] == (0 if allow else 4)
            and joined["payloads"] == (PAYLOADS if not allow else
                                      {key: value for key, value in PAYLOADS.items() if key != "stale"}),
            "missing helper join or changed surviving bytes")
    for key, name in (("request_hex", "helper-stdin.json"), ("stdout_hex", "helper-stdout.bin"),
                      ("stderr_hex", "helper-stderr.bin")):
        require(unhex(joined[key]) == files[name], "changed original helper bytes")
    require(start["request_hex"] == joined["request_hex"], "changed accepted helper request")
    request = decode(files["helper-stdin.json"])
    fields(request, "currentRuntimeDir retainedRuntimeDir")
    parent = f"/tmp/preparation-{nonce}/runtime"
    require(request == {"currentRuntimeDir": parent + "/current",
                        "retainedRuntimeDir": parent + "/retained"}, "foreign runtime request")
    if allow:
        report = decode(files["helper-stdout.bin"])
        fields(report, "before after removedEntries")
        require(integer(report["removedEntries"]) == 1 and files["helper-stderr.bin"] == b"",
                "helper cleanup failed")
        for key in ("before", "after"):
            fields(report[key], "availableBytes availableInodes")
            for value in report[key].values():
                integer(value)
    else:
        require(files["helper-stdout.bin"] == b""
                and b"runtime cleanup failed" in files["helper-stderr.bin"]
                and b"os error 1" in files["helper-stderr.bin"], "wrong helper denial")
    fields(retired, "started_ns completed_ns denied mark_removed group_closed "
           "original_duplicate_closed observation_failed helper_joined originals_closed")
    for key in ("mark_removed", "group_closed", "original_duplicate_closed",
                "helper_joined", "originals_closed"):
        require(retired[key] is True, "invalid final retirement authority")
    require(retired["observation_failed"] is False, "failed final observation")
    for key in ("started_ns", "completed_ns"):
        integer(retired[key], 1)
    require(retired == cleanup | {"helper_joined": True, "originals_closed": True},
            "unjoined or incomplete final retirement")
    require(integer(start["started_ns"], 1) <= integer(event["event"]["observed_ns"], 1)
            <= integer(status["observed_ns"], 1) <= integer(decision["response_started_ns"], 1)
            <= integer(cleanup["completed_ns"], 1) <= integer(joined["joined_ns"], 1),
            "invalid actual helper phase clocks")
    sequence, payload = frame(files["exec-request.bin"], 0x0b)
    payload.expect(b"\0\0\0" + (90000).to_bytes(4, "big") + b"\x01")
    command = (f"exec python3 -B /tmp/preparation-{nonce}/guest_preparation_control.py "
               f"--port 52010 --nonce {nonce} --parent {parent}")
    require(payload.sized(4) == command.encode(), "changed component exec command")
    payload.expect(bytes(4))
    require(payload.sized(2) == b"native-guest-preparation", "changed component label")
    payload.expect(b"\x01"+(4096).to_bytes(4, "big")+b"\x01"+(8192).to_bytes(4, "big"))
    payload.expect(b"\0\x01"+bytes(4)+bytes(2))  # expected exit0, control disabled, no stdin
    payload.finish()
    result_sequence, payload = frame(files["exec-terminal.bin"], 0x0e)
    require(result_sequence == sequence, "foreign accepted exec terminal")
    payload.expect(bytes(5))  # actual Exited(0), not cancellation or signal
    payload.take(4)
    for limit in (4096, 8192):
        payload.expect(b"\x01\0")
        require(len(payload.sized(4)) <= limit, "lost/truncated controller output")
    payload.sized(2).decode()
    payload.finish()
    terminal = files["controller-terminal.txt"].decode()
    require("Exited { exit_code: 0 }" in terminal and terminal.count("Captured {") == 2
            and terminal.count("truncated: false") == 2 and "stream_overflowed: false" in terminal,
            "incomplete controller terminal")
    return {"source_commit": source, "capture_sha256": capture, "allow": allow,
            "actual_helper_component_and_joins": True, "runner_final_exec_established": False,
            "cancellation_custody_established": False, "saving_lease_cleanup_established": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--expected-source", required=True)
    parser.add_argument("--expected-capture-sha256", required=True)
    args = parser.parse_args()
    print(json.dumps(validate(args.directory, args.expected_source, args.expected_capture_sha256),
                     sort_keys=True, indent=2))
