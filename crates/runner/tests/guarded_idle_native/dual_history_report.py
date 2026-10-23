#!/usr/bin/env python3
"""Validate two complete native histories and phased ownership of one cache entry."""

import argparse
import json
import pathlib
import re

import batch_replacement_report as replacement
import later_parking_report as later
import pressure_report as pressure
import report
from startup_report import exact

PREFIX = "NATIVE_DUAL_HISTORY_WITNESS "
CASES = {f"DualHistory{outcome}-{mode}" for outcome in ("Success", "Nonzero")
         for mode in ("fresh", "snapshot")}
PHASES = ("original_prepared", "incoming_prepared", "original_restored", "original_restored_joined",
          "incoming_continued", "incoming_restored", "incoming_restored_joined", "histories_joined")


def raw_bytes(value, limit=65536):
    if (not isinstance(value, str) or not value or len(value) > limit*2
            or len(value) % 2 or not re.fullmatch("[0-9a-f]+", value)):
        raise ValueError("missing noncanonical or truncated complete byte oracle")
    return bytes.fromhex(value)


def history(value, thread):
    raw = raw_bytes(value)
    try:
        lines = [json.loads(line, object_pairs_hook=pressure.unique_object) for line in raw.decode().splitlines()]
    except (ValueError, TypeError, UnicodeError) as error:
        raise ValueError("history is not complete native JSONL") from error
    if (len(lines) < 2 or not all(isinstance(line, dict) for line in lines)
            or lines[0].get("type") != "session_meta"
            or not isinstance(lines[0].get("payload"), dict)
            or lines[0]["payload"].get("id") != thread or not raw.endswith(b"\n")):
        raise ValueError("complete history is not bound to its independent native session")
    return raw


def validate(directory):
    directory = pathlib.Path(directory)
    result = replacement.validate(directory, CASES, "native_dual_history_policy_json")
    groups = {prefix: {case: [] for case in CASES}
              for prefix in (PREFIX, replacement.PREFIX, report.PREFIX)}
    for line in (directory / "stdout.log").read_text().splitlines():
        for prefix, cases in groups.items():
            if not line.startswith(prefix):
                continue
            event = json.loads(line[len(prefix):], object_pairs_hook=pressure.unique_object)
            if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                    "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                    or type(event["version"]) is not int or event["version"] != 1
                    or event["case"] not in CASES or not isinstance(event["evidence"], dict)
                    or not report.positive_integer(event["monotonic_ns"])
                    or not report.positive_integer(event["unix_ns"])):
                raise ValueError("invalid dual-history original-file witness")
            cases[event["case"]].append(event)
    seen, keys = set(), set()

    def identity(value):
        value = later.identifier(value)
        if value in seen:
            raise ValueError("dual-history physical/run/session identity replay")
        seen.add(value)
        return value

    for case in sorted(CASES):
        events, core, terminal = (groups[p][case] for p in (PREFIX, replacement.PREFIX, report.PREFIX))
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered dual-history phases")
        old, old_backing = identity(terminal[1]["sandbox_id"]), identity(terminal[1]["backing_generation"])
        prep = core[0]["evidence"]["preparation"]
        new, new_backing = identity(prep["sandbox_id"]), identity(prep["backing_generation"])
        identity(prep["operation_id"])
        if any((e["sandbox_id"], e["backing_generation"]) != (old, old_backing) for e in events):
            raise ValueError("dual-history witnesses lost the original owner")
        # Raw data restoration precedes the next publication; both added saving
        # producers finish before the unchanged C6 final ownership joins.
        ordered = [terminal[0], events[0], terminal[1], events[1], core[0], core[6],
                   *events[2:5], core[7], *events[5:7], core[8], events[7], terminal[5]]
        for field in ("monotonic_ns", "unix_ns"):
            if any(a[field] >= b[field] for a, b in zip(ordered, ordered[1:])):
                raise ValueError("dual-history generation restoration or saving order changed")
        original, incoming, restored, original_joined, continued, saved, incoming_joined, joined = (
            e["evidence"] for e in events)
        if not prep["grant_finished_ns"] < events[1]["monotonic_ns"] < prep["prepared_ns"]:
            raise ValueError("incoming history preparation escaped the actual Fresh receipt")
        run, thread = identity(original.get("run_id")), identity(original.get("thread_id"))
        key = original.get("cache_key")
        if not isinstance(key, str) or not re.fullmatch("[0-9a-f]{64}", key) or key in keys:
            raise ValueError("dual history has no distinct physical cache key")
        keys.add(key)
        reuse = "thread:native-guarded-"+run
        if core[0]["evidence"]["same_reuse_key"] != reuse:
            raise ValueError("dual history escaped the actual captured reuse key")
        original_bytes = history(original.get("history_hex"), thread)
        nonzero = "Nonzero" in case
        exact(original, {"run_id":run,"sandbox_id":old,"backing_generation":old_backing,"thread_id":thread,
            "history_hex":original["history_hex"],"cache_key":key,"reuse_key":reuse,"profile":"vm0/default",
            "home_bytes":report.NATIVE_HOME_BYTES,"exit_code":1 if nonzero else 0,
            "final_identity_verified":not nonzero,"allocated":[2,4096,1]}, "invalid complete original preparation")
        new_run, new_thread = identity(incoming.get("run_id")), identity(incoming.get("thread_id"))
        incoming_bytes = history(incoming.get("history_hex"), new_thread)
        if incoming_bytes == original_bytes:
            raise ValueError("incoming history is not independently meaningful")
        exact(incoming, {"run_id":new_run,"sandbox_id":new,"backing_generation":new_backing,"thread_id":new_thread,
            "history_hex":incoming["history_hex"],"cache_key":key,"reuse_key":reuse,"initial_checkout":"LockBusy","lock_owner":"finalizing",
            "final_identity_verified":True,"incoming_full_lease_active":True,"allocated":[4,8192,2]},
            "incoming lost original full ownership or bypassed same-entry contention")
        continuation_run = identity(continued.get("run_id"))
        extended = history(continued.get("history_hex"), new_thread)
        if not extended.startswith(incoming_bytes) or len(extended) <= len(incoming_bytes):
            raise ValueError("real incoming continuation lost or did not extend complete original bytes")
        exact(continued, {"run_id":continuation_run,"previous_run_id":new_run,"sandbox_id":new,
            "backing_generation":new_backing,"thread_id":new_thread,"history_hex":continued["history_hex"],
            "original_history_hex":incoming["history_hex"],"cache_key":key,"same_full_lease_active":True,
            "active_checkout":"Miss","actual_executor_reuse":True,"final_identity_verified":True,
            "allocated":[2,4096,1]}, "continuation changed the exact live owner, lease or physical cache entry")
        if events[4]["monotonic_ns"] >= core[7]["evidence"]["started_ns"]:
            raise ValueError("incoming required retirement started before its valid continued owner")
        for value, completion, data, generation, origin, sandbox, session, private, allocated, released in (
                (restored, original_joined, original_bytes, run, run, old, thread, [run], [4,8192,2], [2,4096,1]),
                (saved, incoming_joined, extended, continuation_run, new_run, new, new_thread,
                 [new_run,continuation_run], [2,4096,1], [0,0,0])):
            restore_run = identity(value.get("restoration_run_id"))
            restore_id = identity(value.get("restoration_sandbox_id"))
            restore_backing = identity(value.get("restoration_backing_generation"))
            if raw_bytes(value.get("history_hex")) != data or raw_bytes(value.get("restored_history_hex")) != data:
                raise ValueError("complete original and restored native history bytes differ")
            expected = (origin.encode()*2048)[:65536]
            if raw_bytes(value.get("home_hex")) != expected or raw_bytes(value.get("workspace_hex")) != expected:
                raise ValueError("complete original home/workspace bytes differ")
            exact(value, {"source_run_id":generation,"original_run_id":origin,"source_sandbox_id":sandbox,
                "restoration_run_id":restore_run,"restoration_sandbox_id":restore_id,
                "restoration_backing_generation":restore_backing,"thread_id":session,"cache_key":key,
                "history_hex":data.hex(),"restored_history_hex":data.hex(),"home_hex":expected.hex(),
                "workspace_hex":expected.hex(),"ordinary_hex":b"native ordinary home bytes".hex(),
                "private_generations_removed":private,
                "history_proof_generation":generation,"cache_hit":True,"allocated":allocated},
                "restoration lost the exact source generation, data or private cleanup")
            exact(completion, {"restoration_run_id":restore_run,"restoration_sandbox_id":restore_id,
                "restoration_backing_generation":restore_backing,"backing_exit_confirmed":True,
                "home_cache_promoted":True,"full_lease_released":True,"tracker_joined":True,
                "remaining_activation_owners":0,"allocated":released}, "restoration did not join its own required saving")
        exact(joined, {"original_api_joined":True,"incoming_api_joined":True,
            "both_required_histories_restored":True,"permanent_dual_cache_retention_claimed":False},
            "dual history APIs or required data remain unresolved")
    return {**result, "format":"native-dual-history-report-v1", "native_dual_history_complete":True,
            "incoming_required_history_proven":True,
            "replacement_scope":"same physical cache entry; original restoration before real incoming reuse and saving",
            "permanent_dual_cache_retention_claimed":False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2, sort_keys=True))
