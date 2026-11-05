#!/usr/bin/env python3
"""Validate original accepted-resume/public-API-wait custody and required saving."""

import argparse
import json
import pathlib

import batch_aba_report as batch
import later_parking_report as later
import report
import speculative_fault_report as saving
import status_failure_report as failure
from cleanup_report import supplied_policy
from native_transition_report import wait_progress, wire
from snapshot_report import exact

PREFIX = "NATIVE_UNPARK_WITNESS "
FAULTS = ("UnparkDrop", "UnparkObserverUnwind", "UnparkProducerUnwind")
CASES = {f"{fault}-{mode}" for fault in FAULTS for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "resume_captured", "resume_accepted_waiting", "preparation_lost",
          "native_wait_progress", "request_producer_joined", "tail_blocked", "pool_wait_progress",
          "tail_wait_progress", "saving_joined", "status_wait_progress", "status_published",
          "producers_joined")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy = supplied_policy(collector, result, "native_unpark_policy_json")
    witnesses = {case: [] for case in CASES}
    report.collect_witnesses(
        directory / 'stdout.log', {PREFIX: witnesses},
        case_matches=lambda value: value in CASES,
        invalid_message="invalid native unpark witness",
    )
    identities = {events[1][key] for events in terminals.values() for key in ("sandbox_id", "backing_generation")}
    paths, runners = set(), set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(event["phase"] for event in events) != PHASES:
            raise ValueError("missing duplicate or reordered native unpark phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        if any((event["sandbox_id"], event["backing_generation"]) != identity for event in events):
            raise ValueError("native unpark changed original physical owner")
        ordered = [terminal[1], *events[:6], terminal[2], terminal[3], *events[6:9],
                   terminal[4], *events[9:], terminal[5]]
        for field in ("monotonic_ns", "unix_ns"):
            if any(a[field] >= b[field] for a, b in zip(ordered, ordered[1:])):
                raise ValueError("native unpark phase clocks lost ordering")
        initial, captured, accepted, lost, progress, joined = [event["evidence"] for event in events[:6]]
        mode = case.rsplit("-", 1)[0]
        path = initial.get("status_path")
        if not failure.valid_status_path(path) or path in paths:
            raise ValueError("invalid or replayed native unpark status path")
        paths.add(path)
        baseline = initial.get("published_status")
        failure.status(baseline, sandbox=identity[0])
        exact(initial, {"policy":policy,"status_path":path,"published_status":baseline,"regular_file":True},
              "native unpark changed original inputs")
        history, operation = later.identifier(captured.get("history_run_id")), later.identifier(captured.get("operation_run_id"))
        if history == operation or history in identities or operation in identities:
            raise ValueError("native unpark replayed run or resource identity")
        identities.update((history, operation))
        reuse = "thread:native-guarded-"+history
        exact(baseline["idle_sandboxes"], [{"reuse_key":reuse,"sandbox_id":identity[0]}],
              "native unpark lost original history binding")
        started = batch.clock(captured.get("prepare_started_ns"), events[0]["monotonic_ns"], events[1]["monotonic_ns"])
        observed = batch.clock(captured.get("capture_observed_ns"), started, events[1]["monotonic_ns"])
        request_sha = wire(captured.get("request_raw"))
        exact(captured, {"mode":mode,"history_run_id":history,"operation_run_id":operation,"reuse_key":reuse,
            "prepare_started_ns":started,"capture_observed_ns":observed,"request_raw":captured["request_raw"],
            "request_sha256":request_sha,"backend_dispatched":False,"restore_callback_reached":False,
            "backend_socket":"/run/vm0/sock/"+identity[0]+"/api.sock",
            "front_socket":"/run/vm0/sock/"+identity[0]+"/unpark-proof.sock",
            "original_full_lease_active":True,"allocated":[2,4096,1]}, "capture was substituted for native acceptance")
        observed = batch.clock(accepted.get("backend_response_observed_ns"), events[1]["monotonic_ns"], events[2]["monotonic_ns"])
        response_sha = wire(accepted.get("response_raw"), True)
        exact(accepted, {"backend_response_observed_ns":observed,"backend_status":204,
            "response_raw":accepted["response_raw"],"response_sha256":response_sha,
            "public_unpark_polled_pending":True,"response_delivery_withheld":True,
            "restore_callback_reached":False,"internal_vmm_inflight_claimed":False,
            "original_full_lease_active":True,"original_exit_polled_pending":True,"allocated":[2,4096,1]},
            "native resume lacked actual success with public API wait still pending")
        requested = batch.clock(lost.get("cancel_requested_ns"), events[2]["monotonic_ns"], events[3]["monotonic_ns"])
        dropped = batch.clock(lost.get("observation_dropped_ns"), requested, events[3]["monotonic_ns"])
        exact(lost, {"cancel_requested_ns":requested,"observation_dropped_ns":dropped,
            "observer_unwound":mode=="UnparkObserverUnwind","state":"Uncertain","commit_refused":True,
            "repark_refused":True,"incoming_refused":True,"original_metadata_preserved":True,
            "original_full_lease_active":True,"original_exit_polled_pending":True,"pool_empty":True,
            "allocated":[2,4096,1]}, "native cancellation lost original uncertain custody")
        runner = wait_progress(progress, events[3], events[4])
        released = batch.clock(joined.get("response_released_ns"), events[4]["monotonic_ns"], events[5]["monotonic_ns"])
        finished = batch.clock(joined.get("producer_joined_ns"), released, events[5]["monotonic_ns"])
        exact(joined, {"response_released_ns":released,"producer_joined_ns":finished,"producer_joined":True,
            "producer_unwound":mode=="UnparkProducerUnwind","backend_status":204,
            "joined_request_sha256":None if mode=="UnparkProducerUnwind" else request_sha,
            "accepted_response_before_cancellation":True,"internal_vmm_inflight_claimed":False},
            "accepted request producer was not joined before required cleanup")
        saving.validate_saving_progress(events[6:],terminal,baseline,policy,identities,runners,2,runner)
    return {**result,"format":"native-unpark-report-v1","native_unpark_api_wait_cancellation_complete":True,
            "fault_boundary":"genuine accepted resume while actual public unpark awaits HTTP response",
            "producer_unwind_boundary":"response relay task after actual response delivery",
            "internal_vmm_execution_inflight_proven":False,"inflight_guest_rpc_cancellation_proven":False,
            "physical_pause_cancellation_proven":False,"full_supervisor_shutdown_proven":False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory",type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory),indent=2,sort_keys=True))
