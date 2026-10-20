#!/usr/bin/env python3
"""Strict original-file consumer for real API arbitration and both native owners."""

import argparse
import hashlib
import json
import os
import pathlib
import stat
import uuid

import batch_aba_report as batch
import foreground_report as foreground
import pressure_report as pressure
import report
import status_failure_report as failure
from cleanup_report import COUNTS, accounting, coverage, supplied_policy
from startup_report import exact

PREFIX = "NATIVE_REAL_API_CLAIM_WITNESS "
ORDERS = ("a", "b", "both")
MODES = ("fresh", "snapshot")


def read_regular(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("API evidence is not a regular file")
        raw = stream.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        raise ValueError("API evidence exceeds its bound")
    return raw


def read_json(path):
    return json.loads(read_regular(path), object_pairs_hook=pressure.unique_object)


def digest(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def identifier(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("claim identity is not canonical")
    return value


def unavailable(body):
    if (not isinstance(body, dict) or not isinstance(body.get("error"), dict)
            or body["error"].get("code") != "NOT_FOUND"
            or body["error"].get("message") not in ("Run not found", "Job not found in queue")):
        raise ValueError("loser is not the genuine API unavailable contract")


def validate_owner(events, terminal, policy, native_input, claim, role, order, source):
    won = claim["status"] == 200
    phases = ("claim_wait_progress", "winner_executed" if won else "loser_restored",
              "tail_blocked", "tail_wait_progress", "status_wait_progress",
              "original_completed", "producers_joined", "saved_task_verified")
    if tuple(event["phase"] for event in events) != phases:
        raise ValueError("missing, duplicated or reordered native arbitration phases")
    identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
    if any((event["sandbox_id"], event["backing_generation"]) != identity for event in events):
        raise ValueError("native claimant changed physical ownership")
    ordered = [terminal[1], *events[:2], terminal[2], terminal[3], *events[2:4],
               terminal[4], *events[4:], terminal[5]]
    for field in ("monotonic_ns", "unix_ns"):
        if any(a[field] >= b[field] for a, b in zip(ordered, ordered[1:])):
            raise ValueError("claim/cleanup clocks lost positive ordering")
    progress, outcome, tail, tail_progress, status, completed, joined, saved = [e["evidence"] for e in events]
    run = native_input["claim_run_id"]
    runner = native_input["runner_ids"][0 if role == "a" else 1]
    original = identifier(native_input["original_run_id"])
    if native_input["predecessor_context"]["runId"] != original or original == run:
        raise ValueError("public predecessor/candidate identity was replaced")
    expected_identity = {"runnerId": runner, "heartbeatGeneration": 1}
    if (progress.get("run_id") != run or progress.get("original_run_id") != original
            or progress.get("runner_identity") != expected_identity or progress.get("role") != role
            or progress.get("order") != order
            or progress.get("allocated") != [2, 4096, 1]
            or progress.get("original_full_lease_active") is not True
            or progress.get("preparation_polled_pending") is not True):
        raise ValueError("pending claim lost original full native custody")
    foreground.observer(progress.get("observer"), terminal[1]["monotonic_ns"], events[0]["monotonic_ns"])
    held = batch.clock(progress.get("pool_held_ns"), terminal[1]["monotonic_ns"], events[0]["monotonic_ns"])
    pending = batch.clock(progress.get("heartbeat_pending_ns"), held, progress["observer"]["started_ns"])
    released = batch.clock(progress.get("pool_released_ns"), progress["observer"]["completed_ns"], events[0]["monotonic_ns"])
    if not pending < released or progress.get("heartbeat_polled_pending") is not True:
        raise ValueError("claim heartbeat did not positively wait for its held pool")
    heartbeat = foreground.heartbeat(progress.get("heartbeat"), 1, terminal[1]["monotonic_ns"], events[0]["monotonic_ns"], (2, 4096))
    if progress["heartbeat"]["receipt"]["received_ns"] <= released:
        raise ValueError("heartbeat bypassed the held pool")
    if outcome.get("original_full_lease_active") is not True or outcome.get("allocated") != [2, 4096, 1]:
        raise ValueError("claim outcome prematurely released its complete lease")
    marker = {"run_id": run, "runner_id": runner, "role": role, "source_sha": source}
    if won:
        body = claim["response"]
        if (outcome.get("marker") != marker or outcome.get("returned_run_id") != run
                or outcome.get("returned_reuse_key") != native_input["reuse_key"]
                or outcome.get("runner_identity") != expected_identity
                or outcome.get("completion_authority_sha256") != hashlib.sha256(body["sandboxToken"].encode()).hexdigest()):
            raise ValueError("winner changed the original returned task or completion authority")
    else:
        if outcome.get("run_id") != run or outcome.get("runner_identity") != expected_identity:
            raise ValueError("losing claim changed identity")
        published = outcome.get("published_status")
        if not isinstance(published, dict):
            raise ValueError("loser has no original status publication")
        failure.status({key: value for key, value in published.items() if key != "idle_sandboxes"})
        exact(published.get("idle_sandboxes"),
              [{"reuse_key": native_input["reuse_key"], "sandbox_id": identity[0]}],
              "loser did not publish its actual public reuse identity")
        if not pressure.integer(outcome.get("revision"), 2):
            raise ValueError("loser did not restore a new insertion of its original")
    coverage(tail.get("coverage"), policy, False)
    if tail.get("original_exit_confirmed") is not True or tail.get("receiver_polled_pending") is not True:
        raise ValueError("required saving lacks positive exit/held completion")
    coverage(tail_progress.get("coverage"), policy, False)
    foreground.observer(tail_progress.get("observer"), events[2]["monotonic_ns"], events[3]["monotonic_ns"])
    if foreground.heartbeat(tail_progress.get("heartbeat"), 2, events[2]["monotonic_ns"], events[3]["monotonic_ns"], (2, 4096)) != heartbeat:
        raise ValueError("held-IO progress producer changed")
    held = batch.clock(status.get("status_held_ns"), events[3]["monotonic_ns"], terminal[4]["monotonic_ns"])
    batch.clock(status.get("io_released_ns"), held, terminal[4]["monotonic_ns"])
    polled = batch.clock(status.get("status_wait_polled_ns"), terminal[4]["monotonic_ns"], events[4]["monotonic_ns"])
    before, after = status.get("status_waits_before"), status.get("status_waits_after")
    if (not pressure.integer(before) or not pressure.integer(after) or after != before + 1
            or status.get("original_lease_released") is not True
            or status.get("receiver_polled_pending") is not True
            or status.get("allocated") != [0, 0, 0]):
        raise ValueError("final status wait or lease release is unproven")
    zero = dict.fromkeys(COUNTS, 0) | {"closed": False}
    exact(status.get("accounting"), zero, "status wait retained accounting")
    if foreground.heartbeat(status.get("heartbeat"), 3, polled, events[4]["monotonic_ns"], (0, 0)) != heartbeat:
        raise ValueError("final status progress producer changed")
    released = batch.clock(completed.get("status_released_ns"), events[4]["monotonic_ns"], events[5]["monotonic_ns"])
    batch.clock(completed.get("batch_joined_ns"), released, events[5]["monotonic_ns"])
    failure.status(completed.get("published_status"))
    for key, expected in {"selected": 1, "completed": 1, "uncertain": 0, "not_started": 0,
                          "status_error": False, "is_complete": True, "regular_file": True,
                          "allocated": [0, 0, 0]}.items():
        exact(completed.get(key), expected, "original saving batch did not finish completely")
    accounting(joined.get("accounting"), True)
    exact(joined, {"run_id": run, "role": role, "claim_joined": True,
                   "provider_joined": True, "heartbeat_joined": True, "saving_joined": True,
                   "allocated": [0, 0, 0], "accounting": joined["accounting"]},
          "claim/provider/save owners were not joined")
    exact(saved, {"run_id": run, "role": role, "won": won, "marker": marker if won else None,
                  "original_data_verified": True}, "winner/loser complete saved bytes changed")


def validate(directory):
    directory = pathlib.Path(directory)
    producer_path = directory / "producer.json"
    producer_raw = read_regular(producer_path)
    producer = json.loads(producer_raw, object_pairs_hook=pressure.unique_object)
    producer_sha = hashlib.sha256(producer_raw).hexdigest()
    if (producer.get("format") != "native-real-api-producer-v1"
            or producer.get("postgres", {}).get("host") != "127.0.0.1"
            or not str(producer.get("postgres", {}).get("system_identifier", "")).isdigit()
            or producer.get("postgres", {}).get("migration_completed") is not True
            or producer.get("postgres", {}).get("invocation_owned") is not True
            or not pressure.integer(producer.get("postgres", {}).get("port"), 1)
            or producer["postgres"]["port"] > 65535
            or not producer.get("postgres", {}).get("version", "").startswith("PostgreSQL ")
            or not pathlib.Path(producer.get("postgres", {}).get("data_directory", "")).is_absolute()
            or any(not digest(producer.get("postgres", {}).get(key)) for key in
                   ("binary_sha256", "control_sha256", "migration_receipt_sha256"))
            or any(not digest(producer.get(key)) for key in
                   ("source_manifest_sha256", "source_archive_sha256", "guest_build_receipt_sha256",
                    "rootfs_build_receipt_sha256", "node_sha256"))):
        raise ValueError("actual API/PostgreSQL producer lineage is missing")
    summaries, source, identities, artifacts = {}, None, set(), None
    for order in ORDERS:
        root = directory / order
        inputs, api = read_json(root / "api-inputs.json"), read_json(root / "api-receipts.json")
        cases = {f"RealClaim-{order}-{role}-{mode}" for role in ("a", "b") for mode in MODES}
        result, collector, terminals = report._validate_cases(root / "p1", cases, report.PHASES)
        current_source = result["artifacts"]["source_sha"]
        if source is None:
            source = current_source
            artifacts = result["artifacts"]
        elif artifacts != result["artifacts"]:
            raise ValueError("native artifact/policy/snapshot bindings changed across cases")
        if source != current_source or inputs.get("source_sha") != source or api.get("source_sha") != source:
            raise ValueError("API/native source identity changed across cases")
        if (producer.get("source_sha") != source or api.get("producerSha256") != producer_sha
                or collector.get("metadata", {}).get("native_real_api_producer_sha256") != producer_sha):
            raise ValueError("API/PostgreSQL/native producer binding changed")
        if producer.get("artifacts") != result["artifacts"]:
            raise ValueError("producer inputs differ from observed native artifacts")
        for name, key in (("host", "test_binary_sha256"), ("firecracker", "firecracker_sha256"),
                          ("kernel", "kernel_sha256"), ("rootfs", "rootfs_sha256")):
            binary = producer.get("binaries", {}).get(name, {})
            if (binary.get("sha256") != result["artifacts"][key]
                    or not pathlib.Path(binary.get("path", "")).is_absolute()):
                raise ValueError("producer binary differs from observed native artifact")
        if inputs.get("order") != order or api.get("apiJoined") is not True:
            raise ValueError("API fixture was not joined under its original ordering")
        if set(inputs.get("cases", {})) != set(MODES) or len(api.get("claims", [])) != 4:
            raise ValueError("incomplete/replayed two-claimant API cases")
        policy = supplied_policy(collector, result, "native_real_api_policy_json")
        physical = {event[1][field] for event in terminals.values()
                    for field in ("sandbox_id", "backing_generation")}
        if len(physical) != 8 or physical & identities:
            raise ValueError("native physical ownership was replayed across cases")
        identities.update(physical)
        witnesses = {case: [] for case in cases}
        for line in (root / "p1/stdout.log").read_text().splitlines():
            if not line.startswith(PREFIX):
                continue
            event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
            if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                    "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                    or type(event["version"]) is not int or event["version"] != 1
                    or event["case"] not in cases or not isinstance(event["evidence"], dict)
                    or not report.positive_integer(event["monotonic_ns"])
                    or not report.positive_integer(event["unix_ns"])):
                raise ValueError("unexpected native arbitration witness")
            witnesses[event["case"]].append(event)
        observations = api.get("publicObservations")
        if not isinstance(observations, list) or len(observations) != 2:
            raise ValueError("public terminal/winner observations are incomplete")
        for mode in MODES:
            native_input = inputs["cases"][mode]
            run = identifier(native_input["claim_run_id"])
            runners = native_input["runner_ids"]
            if len(runners) != 2 or len(set(runners)) != 2:
                raise ValueError("claimants do not have independent identities")
            new_ids = {identifier(v) for v in (run, native_input["original_run_id"], *runners)}
            if len(new_ids) != 4 or identities & new_ids:
                raise ValueError("run/claimant identities were replayed")
            identities.update(new_ids)
            claims = [claim for claim in api["claims"] if claim.get("runId") == run]
            if len(claims) != 2 or sorted(claim.get("status") for claim in claims) != [200, 404]:
                raise ValueError("actual API did not select exactly one successful claimant")
            if {claim.get("runnerId") for claim in claims} != set(runners):
                raise ValueError("API response belongs to another claimant")
            for role, runner in zip(("a", "b"), runners):
                claim = next(claim for claim in claims if claim["runnerId"] == runner)
                body = claim.get("body")
                if (claim.get("path") != f"/api/runners/jobs/{run}/claim"
                        or claim.get("authorization") != "Bearer " + inputs["token"]
                        or not isinstance(body, dict)
                        or body.get("runnerIdentity") != {"runnerId": runner, "heartbeatGeneration": 1}
                        or body.get("nativeContinuationSupported") is not True):
                    raise ValueError("API claim lost its actual route/body/authorization")
                clocks = [int(claim.get(key, "-1")) for key in ("enteredNs", "forwardedNs", "completedNs")]
                if not 0 < clocks[0] < clocks[1] < clocks[2]:
                    raise ValueError("API claim clocks do not order accepted work")
                if claim["status"] == 200:
                    observed = claim.get("running")
                    observed_ns = int(claim.get("runningObservedNs", "-1"))
                    if (not isinstance(observed, dict) or observed.get("status") != "running"
                            or not observed.get("startedAt")
                            or not clocks[1] < observed_ns < clocks[2]):
                        raise ValueError("winner has no public running state before native execution")
                    response = claim.get("response")
                    if (not isinstance(response, dict) or response.get("runId") != run
                            or response.get("reuseKey") != native_input["reuse_key"]
                            or not isinstance(response.get("sandboxToken"), str) or not response["sandboxToken"]):
                        raise ValueError("winning API context is missing original authority")
                else:
                    unavailable(claim.get("response"))
                case = f"RealClaim-{order}-{role}-{mode}"
                validate_owner(witnesses[case], terminals[case], policy, native_input, claim, role, order, source)
            winner = next(claim for claim in claims if claim["status"] == 200)
            if order != "both":
                expected = runners[0 if order == "a" else 1]
                if winner["runnerId"] != expected:
                    raise ValueError("ordered native resource was not the genuine winner")
                loser = next(claim for claim in claims if claim["status"] == 404)
                if int(winner["completedNs"]) >= int(loser["forwardedNs"]):
                    raise ValueError("controlled claim ordering was not observed")
            elif max(int(c["forwardedNs"]) for c in claims) >= min(int(c["completedNs"]) for c in claims):
                raise ValueError("simultaneous public claim lifetimes did not overlap")
            observed = [item for item in observations if item.get("runId") == run]
            if (len(observed) != 1 or observed[0].get("runner", {}).get("runnerId") != winner["runnerId"]
                    or observed[0].get("run", {}).get("status") != "completed"
                    or observed[0].get("laterClaimStatus") != 404):
                raise ValueError("public winner attribution or terminal state is unproven")
            unavailable(observed[0].get("laterClaimBody"))
        summaries[order] = result
    return {"format": "native-real-api-claim-report-v1", "source_sha": source,
            "native_real_api_arbitration_complete": True, "scenarios": 6,
            "independent_native_owner_paths": 12, "orders": summaries,
            "memory_envelope_calibrated": False, "production_protection_proven": False,
            "full_executor_framework_history_proven": False,
            "bootstrap_provenance_verified": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2, sort_keys=True))
