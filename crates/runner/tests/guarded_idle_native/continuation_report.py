#!/usr/bin/env python3
"""Validate complete native session/home continuation and original saving."""

import argparse
import hashlib
import json
import pathlib
import re
import uuid

import pressure_report
import report

PREFIX = "NATIVE_CONTINUATION_WITNESS "
CASES = {f"Continuation{scope}-{mode}" for scope in
         ("Logical", "Replacement", "Restore", "Aged", "Nonzero")
         for mode in ("fresh", "snapshot")}
PHASES = ("original_executor_completed", "scenario_observed",
          "continued_executor_completed", "continued_saving_completed")
THREAD = "019e9154-c304-70f0-adde-36efb1be1701"
SEED = b""
SEED_HASH = hashlib.sha256(SEED).hexdigest()


def canonical(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("continuation has no canonical original identity")
    return value


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("continuation has no complete byte hash")
    return value


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    raw_policy = collector["metadata"]["native_continuation_policy_json"]
    if not isinstance(raw_policy, str) or hashlib.sha256(raw_policy.encode()).hexdigest() != result["artifacts"]["policy_sha256"]:
        raise ValueError("continuation raw policy/hash mismatch")
    policy = json.loads(raw_policy, object_pairs_hook=pressure_report.unique_object)
    if (not isinstance(policy, dict) or set(policy) != pressure_report.POLICY_FIELDS
            or any(not pressure_report.integer(v, 1) for v in policy.values())):
        raise ValueError("invalid continuation policy")
    required = (policy["operating_floor_bytes"] + policy["cleanup_reserve_bytes"]
                + 4096*1024**2 + policy["replacement_preparation_bytes"])
    if (not policy["operating_floor_bytes"] <= policy["critical_available_bytes"]
            < policy["recovery_available_bytes"] <= policy["host_total_bytes"]
            or required > policy["host_total_bytes"]
            or policy["tail_growth_bytes"] < 65*1024**2):
        raise ValueError("invalid continuation supplied bounds")
    witnesses = {case: [] for case in CASES}
    for line in (directory/"stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):])
        if (event.get("case") not in CASES or type(event.get("version")) is not int
                or event["version"] != 1
                or not report.positive_integer(event.get("monotonic_ns"))
                or not report.positive_integer(event.get("unix_ns"))):
            raise ValueError("invalid continuation witness")
        witnesses[event["case"]].append(event)
    new_ids, run_ids = set(), set()
    original_ids = {v["sandbox_id"] for v in result["cases"].values()}
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing, duplicate or unordered continuation witnesses")
        identity = (terminal[1]["sandbox_id"], terminal[1]["backing_generation"])
        times = [e["monotonic_ns"] for e in events]
        if (any((e["sandbox_id"], e["backing_generation"]) != identity for e in events)
                or not terminal[0]["monotonic_ns"] < times[0] < times[1] < terminal[1]["monotonic_ns"]
                or not terminal[-2]["monotonic_ns"] < times[2] < times[3] < terminal[-1]["monotonic_ns"]):
            raise ValueError("continuation crossed original generation or work boundaries")
        original, condition, continued, saved = [e["evidence"] for e in events]
        run = canonical(original.get("original_run_id"))
        next_run = canonical(continued.get("continued_run_id"))
        incoming = canonical(continued.get("continued_sandbox_id"))
        if run in run_ids or next_run in run_ids or run == next_run or incoming in new_ids or incoming in original_ids:
            raise ValueError("continuation reused an original run or Guest identity")
        run_ids.update((run, next_run))
        new_ids.add(incoming)
        home = (run.encode()*2048)[:65536]
        home_hash = hashlib.sha256(home).hexdigest()
        if (canonical(original.get("thread_id")) != canonical(continued.get("thread_id"))
                or original.get("seed_history_sha256") != SEED_HASH
                or type(original.get("seed_history_bytes")) is not int
                or original["seed_history_bytes"] != len(SEED)):
            raise ValueError("continuation changed the complete original input")
        expected_exit = 1 if case.startswith("ContinuationNonzero-") else 0
        for proof, verified in ((original, expected_exit == 0), (continued, True)):
            if (proof.get("original_home_sha256") != home_hash
                    or type(proof.get("original_home_bytes")) is not int
                    or proof["original_home_bytes"] != 65536
                    or proof.get("final_identity_verified") is not verified
                    or any(proof.get(k) is not True for k in (
                        "full_original_prefix_verified",
                        "preparation_observed_by_native_process"))):
                raise ValueError("native original bytes/preparation/final identity incomplete")
        if original.get("original_full_lease_witness") is not True:
            raise ValueError("native original lease custody missing")
        if original.get("reusable_identity_withheld_after_nonzero") is not (expected_exit != 0):
            raise ValueError("nonzero native execution did not withhold reusable identity")
        size = original.get("original_history_bytes")
        final_size = continued.get("continued_history_bytes")
        if (type(size) is not int or size <= len(SEED)
                or type(final_size) is not int or final_size <= size
                or type(continued.get("restored_history_bytes")) is not int
                or continued["restored_history_bytes"] != size
                or digest(original.get("original_history_sha256")) != digest(continued.get("restored_history_sha256"))
                or not digest(continued.get("continued_history_sha256"))):
            raise ValueError("complete original/continued history was truncated or mismatched")
        if (type(original.get("exit_code")) is not int or original["exit_code"] != expected_exit
                or type(continued.get("exit_code")) is not int or continued["exit_code"] != 0
                or continued.get("home_cache_hit") is not True
                or continued.get("history_proof_bound") is not (expected_exit == 0)
                or saved != {"required_cleanup_joined": True, "complete_continued_bytes_restored": True,
                             "verified_final_identity_preserved": True}):
            raise ValueError("native continuation/required saving did not positively complete")
        available, age, cost = [condition.get(k) for k in ("available_bytes", "age_ns", "read_duration_ns")]
        can_fit = case.startswith(("ContinuationReplacement-", "ContinuationRestore-", "ContinuationAged-"))
        if (condition.get("policy") != policy or condition.get("allocated") != [2, 4096, 1]
                or any(type(v) is not int for v in condition["allocated"])
                or condition.get("profile_can_fit") is not can_fit
                or not pressure_report.integer(available) or not max(required, policy["recovery_available_bytes"]) <= available <= policy["host_total_bytes"]
                or not pressure_report.integer(age) or not pressure_report.integer(cost)
                or not cost <= age < policy["max_sample_age_millis"]*1_000_000):
            raise ValueError("actual fitting continuation input condition missing")
        result["cases"][case]["continuation"] = {
            "thread_id": THREAD, "original_run_id": run, "continued_run_id": next_run,
            "original_history_bytes": size, "continued_history_bytes": final_size,
            "original_history_sha256": original["original_history_sha256"],
            "continued_history_sha256": continued["continued_history_sha256"],
            "original_exit_code": expected_exit,
        }
    result["remaining_parent_gate"] = "native optional/foreground/recovery and full failure/provenance/residency/envelope reconciliation in #39997/#39998, then parent/P4 gates"
    return {"format": "native-continuation-phase-report-v1",
            "native_continuation_corpus_complete": True, **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(validate(args.directory), indent=2))
