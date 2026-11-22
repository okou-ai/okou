#!/usr/bin/env python3
"""Validate original accepted-pause/public-repark-wait custody and required saving."""

import hashlib
import pathlib

import batch_aba_report as batch
import later_parking_report as later
import report
import speculative_fault_report as saving
import status_evidence
from native_transition_report import (
    validate_preparation_loss,
    validate_producer_join,
    wait_progress,
    wire,
)
from cleanup_report import supplied_policy
from report import exact

PREFIX = "NATIVE_PAUSE_WITNESS "
FAULTS = ("PauseDrop", "PauseObserverUnwind", "PauseProducerUnwind")
CASES = {f"{fault}-{mode}" for fault in FAULTS for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "pause_captured", "pause_accepted_waiting", "preparation_lost",
          "native_wait_progress", "request_producer_joined", "terminal_readiness_joined", "tail_blocked", "pool_wait_progress",
          "tail_wait_progress", "saving_joined", "status_wait_progress", "status_published",
          "producers_joined")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy = supplied_policy(collector, result, "native_pause_policy_json")
    witnesses = {case: [] for case in CASES}
    report.collect_witnesses(
        directory / 'stdout.log', {PREFIX: witnesses},
        case_matches=lambda value: value in CASES,
        invalid_message="invalid native physical pause witness",
    )
    identities = {events[1][key] for events in terminals.values() for key in ("sandbox_id", "backing_generation")}
    paths, runners = set(), set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        report.validate_witness_phases(
            events, PHASES, "missing duplicate or reordered native physical pause phases",
        )
        identity = report.witness_identity(terminal[1])
        if report.witness_identity_changed(events, identity):
            raise ValueError("native physical pause changed original physical owner")
        ordered = [terminal[1], *events[:7], terminal[2], terminal[3], *events[7:10],
                   terminal[4], *events[10:], terminal[5]]
        report.validate_witness_clock_order(
            ordered, "native physical pause phase clocks lost ordering")
        initial, captured, accepted, lost, progress, joined, ready = [event["evidence"] for event in events[:7]]
        mode = case.rsplit("-", 1)[0]
        path = initial.get("status_path")
        status_evidence.claim_status_path(path, paths, "invalid or replayed native physical pause status path")
        baseline = initial.get("published_status")
        status_evidence.original_status(baseline, sandbox=identity[0])
        exact(initial, {"policy":policy,"status_path":path,"published_status":baseline,"regular_file":True},
              "native physical pause changed original inputs")
        history, operation = later.history_operation(
            captured, identities, "native physical pause replayed run or resource identity"
        )
        reuse = "thread:native-guarded-"+history
        exact(baseline["idle_sandboxes"], [{"reuse_key":reuse,"sandbox_id":identity[0]}],
              "native physical pause lost original history binding")
        started = batch.clock(captured.get("prepare_started_ns"), events[0]["monotonic_ns"], events[1]["monotonic_ns"])
        observed = batch.clock(captured.get("capture_observed_ns"), started, events[1]["monotonic_ns"])
        verified = batch.clock(captured.get("data_verified_ns"), started, events[1]["monotonic_ns"])
        reparking = batch.clock(captured.get("repark_started_ns"), verified, observed)
        original = history.encode()
        payload_sha = hashlib.sha256((original*(65536//len(original)+1))[:65536]).hexdigest()
        request_sha = wire(captured.get("request_raw"), state="Paused")
        exact(captured, {"mode":mode,"history_run_id":history,"operation_run_id":operation,"reuse_key":reuse,
            "prepare_started_ns":started,"capture_observed_ns":observed,"request_raw":captured["request_raw"],
            "data_verified_ns":verified,"repark_started_ns":reparking,"payload_bytes":65536,"payload_sha256":payload_sha,
            "production_restore_completed":True,"private_history_verified":True,"ordinary_home_verified":True,
            "request_sha256":request_sha,"backend_dispatched":False,"restore_callback_reached":True,
            "backend_socket":"/run/vm0/sock/"+identity[0]+"/api.sock",
            "front_socket":"/run/vm0/sock/"+identity[0]+"/pause-proof.sock",
            "original_full_lease_active":True,"allocated":[2,4096,1]}, "capture was substituted for native acceptance")
        observed = batch.clock(accepted.get("backend_response_observed_ns"), events[1]["monotonic_ns"], events[2]["monotonic_ns"])
        response_sha = wire(accepted.get("response_raw"), True)
        exact(accepted, {"backend_response_observed_ns":observed,"backend_status":204,
            "response_raw":accepted["response_raw"],"response_sha256":response_sha,
            "public_park_polled_pending":True,"response_delivery_withheld":True,
            "restore_callback_reached":True,"internal_vmm_inflight_claimed":False,
            "original_full_lease_active":True,"original_exit_polled_pending":True,"allocated":[2,4096,1]},
            "native pause lacked actual success with public API wait still pending")
        validate_preparation_loss(
            lost, events[2], events[3], observer_unwound=mode == "PauseObserverUnwind",
        )
        runner = wait_progress(progress, events[3], events[4])
        validate_producer_join(
            joined, events[4], events[5],
            producer_unwound=mode == "PauseProducerUnwind", request_sha=request_sha,
        )
        exact(ready, {"pause_and_resume_readiness_joined":True,"ordinary_reuse_reopened":False,
            "state":"Uncertain","original_full_lease_active":True,"original_exit_polled_pending":True,
            "allocated":[2,4096,1]}, "original pause/resume readiness did not join under terminal-only custody")
        saving.validate_saving_progress(events[7:],terminal,baseline,policy,identities,runners,2,runner)
    return {**result,"format":"native-pause-report-v1","native_physical_pause_cancellation_complete":True,
            "fault_boundary":"genuine accepted physical pause while actual public repark awaits HTTP response",
            "producer_unwind_boundary":"response relay task after actual response delivery",
            "internal_vmm_execution_inflight_proven":False,"inflight_guest_rpc_cancellation_proven":False,
            "physical_pause_cancellation_proven":True,"full_supervisor_shutdown_proven":False}


if __name__ == "__main__":
    report.run_cli(validate, __doc__, sort_keys=True)
