#!/usr/bin/env python3
"""Validate real speculative rollback/history before guarded batch recovery."""

import argparse
import hashlib
import json
import pathlib
import uuid

import batch_aba_report as batch
import pressure_report as pressure
import report
from startup_report import exact

PREFIX = "NATIVE_BATCH_REPARK_WITNESS "
CASES = {f"BatchRepark-{mode}" for mode in ("fresh", "snapshot")}


def canonical_uuid(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("physical rollback run identity is not canonical")
    return value


def validate(directory):
    directory = pathlib.Path(directory)
    result = batch.validate(directory, cases=CASES, policy_key="native_batch_repark_policy_json")
    physical, shared = {case: [] for case in CASES}, {case: [] for case in CASES}
    for line in (directory/"stdout.log").read_text().splitlines():
        prefix = next((p for p in (PREFIX, batch.PREFIX) if line.startswith(p)), None)
        if prefix is None:
            continue
        event = json.loads(line[len(prefix):], object_pairs_hook=pressure.unique_object)
        if not isinstance(event, dict) or event.get("case") not in CASES:
            raise ValueError("physical rollback has an unexpected case")
        (physical if prefix == PREFIX else shared)[event["case"]].append(event)
    runs = set()
    for case in sorted(CASES):
        if len(physical[case]) != 1:
            raise ValueError("physical rollback witness missing or duplicated")
        event, steps = physical[case][0], shared[case]
        exact({k:v for k,v in event.items() if k not in ("monotonic_ns", "unix_ns", "evidence")},
              {"version":1,"case":case,"phase":"original_reparked",
               "sandbox_id":steps[0]["sandbox_id"],"backing_generation":steps[0]["backing_generation"]},
              "physical rollback original identity changed")
        for field in ("monotonic_ns", "unix_ns"):
            batch.clock(event.get(field), steps[0][field], steps[1][field])
        value = event.get("evidence")
        if not isinstance(value, dict):
            raise ValueError("physical rollback evidence missing")
        initial = steps[0]["evidence"]["published_status"]["idle_sandboxes"][0]
        history = canonical_uuid(value.get("original_history_run_id"))
        if initial["reuse_key"] != "thread:native-guarded-"+history or history in runs:
            raise ValueError("physical rollback replaced original history")
        runs.add(history)
        started = batch.clock(value.get("started_ns"), steps[0]["monotonic_ns"], event["monotonic_ns"])
        cycles = value.get("cycles")
        if not isinstance(cycles, list) or len(cycles) != 2:
            raise ValueError("physical rollback requires both observed cycles")
        expected_digest = hashlib.sha256((history.encode()*((65536+len(history)-1)//len(history)))[:65536]).hexdigest()
        previous = started
        for cycle in cycles:
            if not isinstance(cycle, dict):
                raise ValueError("physical rollback cycle missing")
            operation = canonical_uuid(cycle.get("operation_run_id"))
            if operation in runs:
                raise ValueError("physical rollback replayed an original/speculative run")
            runs.add(operation)
            clocks = {}
            for name in ("prepare_started_ns", "rpc_completed_ns", "prepared_ns",
                         "repark_started_ns", "repark_completed_ns"):
                previous = batch.clock(cycle.get(name), previous, event["monotonic_ns"])
                clocks[name] = previous
            exact(cycle, {"operation_run_id":operation, **clocks,"payload_sha256":expected_digest,
                  "private_history_verified":True,"ordinary_home_verified":True,
                  "physical_unpark_completed":True,"physical_repark_completed":True,
                  "original_metadata_preserved":True,"original_full_lease_active":True},
                  "physical rollback lost actual RPC/park or original history/data/custody")
        restored = batch.clock(value.get("restored_ns"), previous, event["monotonic_ns"])
        if restored >= steps[1]["evidence"]["pool_held_ns"]:
            raise ValueError("physical provider work overlapped held pool/status")
        revision = value.get("revision")
        if (not pressure.integer(revision, steps[0]["evidence"]["selected_revision"]+1)
                or revision >= steps[1]["evidence"]["revision"]):
            raise ValueError("physical rollback did not independently replace old insertion")
        exact(value, {"started_ns":started,"restored_ns":restored,"original_history_run_id":history,
              "original_sandbox_id":initial["sandbox_id"],
              "original_backing_generation":steps[0]["backing_generation"],"reuse_key":initial["reuse_key"],
              "cycles":cycles,"revision":revision,"same_insertion":False,"restored_original":True,
              "image_size_bytes":report.NATIVE_HOME_BYTES,"payload_bytes":65536,"allocated":[2,4096,1],
              "provider_awaits_outside_pool_status":True}, "physical rollback changed its restored original")
    return {**result,"format":"native-batch-repark-report-v1","native_batch_repark_complete":True,
            "batch_aba_scope":"physical speculative rollback then logical insertion race and new guarded recovery",
            "actual_api_claim_loss_proven":False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2, sort_keys=True))
