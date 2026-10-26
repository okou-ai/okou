"""Shared original-snapshot receipt validation for native preparation cases."""

import hashlib
import json
import pathlib

import pressure_report

BYTES = 4 * 1024**3


def exact(actual, expected, reason):
    # JSON distinguishes booleans and integers, including in nested leases.
    if json.dumps(actual, sort_keys=True) != json.dumps(expected, sort_keys=True):
        raise ValueError(reason)


def original_inputs(metadata, artifacts, prefix):
    raw_policy, raw_inputs = metadata[prefix+"_policy_json"], metadata[prefix+"_inputs_json"]
    if (not isinstance(raw_policy, str) or not isinstance(raw_inputs, str)
            or hashlib.sha256(raw_policy.encode()).hexdigest() != artifacts["policy_sha256"]):
        raise ValueError("startup raw policy/hash mismatch")
    policy = json.loads(raw_policy, object_pairs_hook=pressure_report.unique_object)
    inputs = json.loads(raw_inputs, object_pairs_hook=pressure_report.unique_object)
    if (not isinstance(policy, dict) or set(policy) != pressure_report.POLICY_FIELDS
            or any(not pressure_report.integer(v, 1) for v in policy.values())
            or not policy["operating_floor_bytes"] <= policy["critical_available_bytes"]
            < policy["recovery_available_bytes"] <= policy["host_total_bytes"]
            or not 2 <= policy["max_cleanup_inflight"] <= policy["max_operations"]
            or policy["tail_growth_bytes"] < 65 * 1024**2):
        raise ValueError("invalid startup supplied policy")
    protected = policy["operating_floor_bytes"] + policy["cleanup_reserve_bytes"]
    if (protected > policy["recovery_available_bytes"] or not isinstance(inputs, dict)
            or set(inputs) != {"snapshot_path", "snapshot_memory_mb", "prefetch_overhead_bytes"}
            or not isinstance(inputs["snapshot_path"], str)
            or not pathlib.PurePosixPath(inputs["snapshot_path"]).is_absolute()
            or pathlib.PurePosixPath(inputs["snapshot_path"]).name != "memory.bin"
            or ".." in pathlib.PurePosixPath(inputs["snapshot_path"]).parts
            or type(inputs["snapshot_memory_mb"]) is not int or inputs["snapshot_memory_mb"] != 4096
            or not pressure_report.integer(inputs["prefetch_overhead_bytes"], 1024**2)
            or protected + BYTES + inputs["prefetch_overhead_bytes"] > policy["host_total_bytes"]
            or type(metadata[prefix+"_snapshot_bytes"]) is not int
            or metadata[prefix+"_snapshot_bytes"] != BYTES):
        raise ValueError("invalid startup original input/shape/bounds")
    return policy, inputs, raw_inputs
