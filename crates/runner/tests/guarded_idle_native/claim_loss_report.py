#!/usr/bin/env python3
"""Validate actual provider404, native rollback and complete original saving."""

import argparse
import datetime
import json
import pathlib

import batch_aba_report as batch
import foreground_report as foreground
import later_parking_report as later
import pressure_report as pressure
import report
import status_failure_report as failure
from cleanup_report import COUNTS, accounting, coverage, supplied_policy
from startup_report import exact

PREFIX = "NATIVE_CLAIM_LOSS_WITNESS "
CASES = {f"ClaimLoss-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("claim_waiting", "pool_wait_progress", "claim_wait_progress", "claim_rejected",
          "original_restored", "tail_blocked", "tail_wait_progress", "status_wait_progress",
          "original_completed", "producers_joined")


def request(value, run, begin, end):
    if not isinstance(value, dict) or set(value) != {"path", "received_ns", "body"}:
        raise ValueError("missing original held claim request")
    received = batch.clock(value["received_ns"], begin, end)
    body = value["body"]
    if not isinstance(body, dict) or set(body) != {"runnerIdentity", "capabilities", "nativeContinuationSupported", "telemetry"}:
        raise ValueError("actual provider claim body changed")
    identity = body["runnerIdentity"]
    if not isinstance(identity, dict):
        raise ValueError("provider claim Runner identity missing")
    runner = later.identifier(identity.get("runnerId"))
    exact(identity, {"runnerId": runner, "heartbeatGeneration": 1}, "claim Runner generation changed")
    capabilities = body["capabilities"]
    if not isinstance(capabilities, dict) or set(capabilities) != {"piModelConfigGenerations"}:
        raise ValueError("claim capabilities missing")
    generations = capabilities["piModelConfigGenerations"]
    if (not isinstance(generations, list) or len(generations) != 3
            or any(not pressure.integer(v, 1) for v in generations) or len(set(generations)) != 3):
        raise ValueError("claim capability generations malformed")
    telemetry = body["telemetry"]
    if (not isinstance(telemetry, dict) or set(telemetry) != {"jobDiscoveredToClaimRequestMs"}
            or not pressure.integer(telemetry["jobDiscoveredToClaimRequestMs"])
            or telemetry["jobDiscoveredToClaimRequestMs"] > 2**53-1):
        raise ValueError("claim discovery telemetry malformed")
    exact(body, {"runnerIdentity": identity, "capabilities": capabilities,
                "nativeContinuationSupported": True, "telemetry": telemetry}, "claim body contract changed")
    exact(value, {"path": f"/api/runners/jobs/{run}/claim", "received_ns": received, "body": body},
          "claim route is not the original candidate")
    return runner


def validate(directory, *, cases=CASES, policy_key="native_claim_loss_policy_json", outcomes=None):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, cases, report.PHASES)
    policy = supplied_policy(collector, result, policy_key)
    witnesses = {case: [] for case in cases}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1
                or event.get("case") not in cases or not isinstance(event["evidence"], dict)
                or not report.positive_integer(event["monotonic_ns"])
                or not report.positive_integer(event["unix_ns"])):
            raise ValueError("invalid native claim rejection witness")
        witnesses[event["case"]].append(event)
    identities = {e[1][k] for e in terminals.values() for k in ("sandbox_id", "backing_generation")}
    paths = set()
    zero = dict.fromkeys(COUNTS, 0) | {"closed": False}
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicated or reordered claim phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        if any((e["sandbox_id"], e["backing_generation"]) != identity for e in events):
            raise ValueError("claim changed the original physical owner")
        ordered = [terminal[1], *events[:5], terminal[2], terminal[3], *events[5:7], terminal[4],
                   *events[7:], terminal[5]]
        for field in ("monotonic_ns", "unix_ns"):
            if any(a[field] >= b[field] for a, b in zip(ordered, ordered[1:])):
                raise ValueError("claim/rollback/original saving clocks lost ordering")
        waiting, pool, progress, rejected, restored, tail, tail_progress, status, completed, joined = [e["evidence"] for e in events]
        initial = waiting.get("published_status")
        failure.status(initial, sandbox=identity[0])
        reuse = initial["idle_sandboxes"][0]["reuse_key"]
        history = later.identifier(waiting.get("history_run_id"))
        run = later.identifier(waiting.get("claim_run_id"))
        if reuse != "thread:native-guarded-"+history:
            raise ValueError("claim lost original history binding")
        held_states = waiting.get("original_held_states")
        if not isinstance(held_states, list) or len(held_states) != 1 or not isinstance(held_states[0], dict):
            raise ValueError("original advertised history/profile missing")
        completed_at = held_states[0].get("lastCompletedAt")
        if not isinstance(completed_at, str) or datetime.datetime.fromisoformat(completed_at).utcoffset() is None:
            raise ValueError("original completion timestamp malformed")
        exact(held_states, [{"reuseKey": reuse, "lastCompletedAt": completed_at,
            "reusableSandbox": {"profile": "vm0/default", "historyGenerationRunId": history}}],
            "original advertised history/profile changed")
        selected = waiting.get("selected_revision")
        if not pressure.integer(selected, 1):
            raise ValueError("claim original insertion revision missing")
        path = waiting.get("status_path")
        if (not isinstance(path, str) or not pathlib.PurePosixPath(path).is_absolute()
                or str(pathlib.PurePosixPath(path)) != path or ".." in pathlib.PurePosixPath(path).parts
                or pathlib.PurePosixPath(path).name != "status.json" or path in paths):
            raise ValueError("claim private status path replayed or changed")
        paths.add(path)
        runner = request(waiting.get("request"), run, terminal[1]["monotonic_ns"], events[0]["monotonic_ns"])
        if len({history, run, runner}) != 3 or {history, run, runner} & identities:
            raise ValueError("claim reused original, claim or Runner generation")
        identities.update((history, run, runner))
        exact(waiting, {"policy": policy, "status_path": path, "published_status": initial,
            "selected_revision": selected, "history_run_id": history, "claim_run_id": run,
            "original_held_states": held_states,
            "request": waiting["request"], "claim_response_held": True, "preparation_polled_pending": True,
            "original_full_lease_active": True, "original_exit_polled_pending": True,
            "pool_empty": True, "allocated": [2,4096,1]}, "held claim lost original custody")
        held = batch.clock(pool.get("pool_held_ns"), events[0]["monotonic_ns"], events[1]["monotonic_ns"])
        polled = batch.clock(pool.get("heartbeat_pending_ns"), held, events[1]["monotonic_ns"])
        foreground.observer(pool.get("observer"), polled, events[1]["monotonic_ns"])
        exact(pool, {"pool_held_ns": held, "heartbeat_pending_ns": polled, "heartbeat_polled_pending": True,
            "observer": pool["observer"], "claim_response_held": True, "original_full_lease_active": True,
            "allocated": [2,4096,1]}, "held-pool claim progress or custody missing")
        released = batch.clock(progress.get("pool_released_ns"), events[1]["monotonic_ns"], events[2]["monotonic_ns"])
        if foreground.heartbeat(progress.get("heartbeat"), 1, released, events[2]["monotonic_ns"], (2,4096)) != (runner, 1):
            raise ValueError("claim and heartbeat Runner differ")
        exact(progress, {"pool_released_ns": released, "heartbeat": progress["heartbeat"],
            "claim_response_held": True, "preparation_polled_pending": True,
            "original_full_lease_active": True, "allocated": [2,4096,1]}, "claim response escaped heartbeat progress")
        released = batch.clock(rejected.get("response_release_requested_ns"), events[2]["monotonic_ns"], events[3]["monotonic_ns"])
        receipt = rejected.get("receipt")
        if not isinstance(receipt, dict):
            raise ValueError("actual returned404 receipt missing")
        returned = batch.clock(receipt.get("response_released_ns"), released, events[3]["monotonic_ns"])
        expected_outcome = {"status": 404} if outcomes is None else outcomes[case]
        exact(receipt, waiting["request"] | {"response_released_ns": returned} | expected_outcome,
              "claim did not return its exact original external outcome")
        prepared = batch.clock(rejected.get("preparation_joined_ns"), returned, events[3]["monotonic_ns"])
        exact(rejected, {"response_release_requested_ns": released, "preparation_joined_ns": prepared,
            "receipt": receipt, "claim_unavailable": True, "commit_refused": True, "guest_preparation_completed": True,
            "pool_empty": True, "original_full_lease_active": True, "original_exit_polled_pending": True,
            "allocated": [2,4096,1]}, "404 activated work or discarded original ownership")
        started = batch.clock(restored.get("rollback_started_ns"), events[3]["monotonic_ns"], events[4]["monotonic_ns"])
        finished = batch.clock(restored.get("rollback_joined_ns"), started, events[4]["monotonic_ns"])
        revision = restored.get("revision")
        if not pressure.integer(revision, selected+1):
            raise ValueError("claim rollback insertion did not advance")
        later.current_status(restored.get("published_status"), initial, identity[0], reuse)
        if (foreground.heartbeat(restored.get("heartbeat"), 2, finished, events[4]["monotonic_ns"], (2,4096)) != (runner, 1)
                or restored["heartbeat"]["receipt"]["state"].get("heldSandboxStates") != held_states):
            raise ValueError("claim rollback no longer advertises original history/profile")
        exact(restored, {"rollback_started_ns": started, "rollback_joined_ns": finished, "revision": revision,
            "sandbox_id": identity[0], "reuse_key": reuse, "history_run_id": history,
            "guest_preparation_completed": True, "physical_repark_completed": True, "guarded_restore_completed": True,
            "heartbeat": restored["heartbeat"],
            "published_status": restored["published_status"], "regular_file": True,
            "original_full_lease_active": True, "original_exit_polled_pending": True,
            "allocated": [2,4096,1]}, "claim rollback did not restore the exact complete original")
        coverage(tail.get("coverage"), policy, False)
        exact(tail, {"original_exit_confirmed": True, "receiver_polled_pending": True,
                     "coverage": tail["coverage"]}, "claim original required saving missing")
        foreground.observer(tail_progress.get("observer"), events[5]["monotonic_ns"], events[6]["monotonic_ns"])
        if foreground.heartbeat(tail_progress.get("heartbeat"), 3, events[5]["monotonic_ns"], events[6]["monotonic_ns"], (2,4096)) != (runner, 1):
            raise ValueError("claim tail heartbeat Runner changed")
        coverage(tail_progress.get("coverage"), policy, False)
        exact(tail_progress, {"observer": tail_progress["observer"], "heartbeat": tail_progress["heartbeat"],
            "receiver_polled_pending": True, "coverage": tail_progress["coverage"]}, "claim held-IO progress missing")
        held = batch.clock(status.get("status_held_ns"), events[6]["monotonic_ns"], terminal[4]["monotonic_ns"])
        released = batch.clock(status.get("io_released_ns"), held, terminal[4]["monotonic_ns"])
        polled = batch.clock(status.get("status_wait_polled_ns"), terminal[4]["monotonic_ns"], events[7]["monotonic_ns"])
        before, after = status.get("status_waits_before"), status.get("status_waits_after")
        if not pressure.integer(before) or not pressure.integer(after) or after != before+1:
            raise ValueError("claim final status wait not positively observed")
        if foreground.heartbeat(status.get("heartbeat"), 4, polled, events[7]["monotonic_ns"], (0,0)) != (runner, 1):
            raise ValueError("claim final heartbeat Runner changed")
        exact(status, {"status_held_ns": held, "io_released_ns": released, "status_wait_polled_ns": polled,
            "status_waits_before": before, "status_waits_after": after, "heartbeat": status["heartbeat"],
            "original_lease_released": True, "receiver_polled_pending": True, "accounting": zero,
            "allocated": [0,0,0]}, "claim final status wait forgot custody or accounting")
        released = batch.clock(completed.get("status_released_ns"), events[7]["monotonic_ns"], events[8]["monotonic_ns"])
        finished = batch.clock(completed.get("batch_joined_ns"), released, events[8]["monotonic_ns"])
        later.current_status(completed.get("published_status"), restored["published_status"])
        exact(completed, {"status_released_ns": released, "batch_joined_ns": finished,
            "selected": 1, "completed": 1, "uncertain": 0, "not_started": 0, "status_error": False,
            "is_complete": True, "published_status": completed["published_status"], "regular_file": True,
            "allocated": [0,0,0]}, "claim original batch did not completely join")
        accounting(joined.get("accounting"), True)
        exact(joined, {"claim_joined": True, "batch_joined": True, "tracker_joined": True, "accounting_joined": True,
            "heartbeat_joined": True, "provider_joined": True, "peer_joined": True,
            "remaining_activation_owners": 0, "remaining_finalizing_owners": 0,
            "allocated": [0,0,0], "accounting": joined["accounting"]}, "claim producers remain owned")
    return {**result, "format": "native-claim-loss-report-v1", "native_provider_404_rollback_complete": True,
            "api_claim_404_rejection_proven": outcomes is None, "actual_api_claim_loss_proven": False,
            "api_claim_arbitration_proven": False, "cancelled_guest_preparation_proven": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2, sort_keys=True))
