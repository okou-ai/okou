#!/usr/bin/env python3
"""Validate original accepted-resume/public-API-wait custody and required saving."""

import argparse
import hashlib
import json
import pathlib

import batch_aba_report as batch
import progress_report as foreground
import later_parking_report as later
import pressure_report as pressure
import report
import speculative_fault_report as saving
import status_failure_report as failure
from cleanup_report import supplied_policy
from snapshot_report import exact

PREFIX = "NATIVE_UNPARK_WITNESS "
FAULTS = ("UnparkDrop", "UnparkObserverUnwind", "UnparkProducerUnwind")
CASES = {f"{fault}-{mode}" for fault in FAULTS for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "resume_captured", "resume_accepted_waiting", "preparation_lost",
          "native_wait_progress", "request_producer_joined", "tail_blocked", "pool_wait_progress",
          "tail_wait_progress", "saving_joined", "status_wait_progress", "status_published",
          "producers_joined")


def wire(value, response=False, state="Resumed"):
    if not isinstance(value, str) or len(value) > 1024*1024:
        raise ValueError("missing bounded original HTTP bytes")
    raw = value.encode("ascii")
    head, body = raw.split(b"\r\n\r\n", 1)
    lines = head.split(b"\r\n")
    valid = (lines[0].split(b" ",2)[:2] == [b"HTTP/1.1",b"204"] if response
             else lines[0] == b"PATCH /vm HTTP/1.1")
    if not valid:
        raise ValueError("wrong native request or successful backend response")
    headers = {}
    for line in lines[1:]:
        name, val = line.split(b":", 1)
        name = name.strip().lower()
        if name in headers:
            raise ValueError("duplicate HTTP evidence header")
        headers[name] = val.strip()
    if b"transfer-encoding" in headers:
        raise ValueError("unsupported native HTTP transfer encoding")
    length = headers.get(b"content-length", b"0" if response else b"")
    if not length.isdigit() or int(length) != len(body):
        raise ValueError("incomplete native HTTP evidence")
    if response:
        if body:
            raise ValueError("204 response contains a body")
    elif json.loads(body, object_pairs_hook=pressure.unique_object) != {"state": state}:
        raise ValueError("native transition evidence names another operation")
    return hashlib.sha256(raw).hexdigest()


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy = supplied_policy(collector, result, "native_unpark_policy_json")
    witnesses = {case: [] for case in CASES}
    for line in (directory / "stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1
                or event["case"] not in CASES or not isinstance(event["evidence"], dict)
                or not report.positive_integer(event["monotonic_ns"])
                or not report.positive_integer(event["unix_ns"])):
            raise ValueError("invalid native unpark witness")
        witnesses[event["case"]].append(event)
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
        if (not isinstance(path, str) or not pathlib.PurePosixPath(path).is_absolute()
                or str(pathlib.PurePosixPath(path)) != path or ".." in pathlib.PurePosixPath(path).parts
                or pathlib.PurePosixPath(path).name != "status.json" or path in paths):
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
        held = batch.clock(progress.get("pool_held_ns"), events[3]["monotonic_ns"], events[4]["monotonic_ns"])
        polled = batch.clock(progress.get("heartbeat_pending_ns"), held, events[4]["monotonic_ns"])
        released = batch.clock(progress.get("pool_released_ns"), polled, events[4]["monotonic_ns"])
        foreground.observer(progress.get("observer"), polled, released)
        runner = foreground.heartbeat(progress.get("heartbeat"),1,released,events[4]["monotonic_ns"],(2,4096))
        exact(progress, {"pool_held_ns":held,"heartbeat_pending_ns":polled,"pool_released_ns":released,
            "observer":progress["observer"],"heartbeat":progress["heartbeat"],"terminal_unpark_polled_pending":True,
            "response_delivery_withheld":True,"additional_full_profile_refused":True,
            "original_full_lease_active":True,"allocated":[2,4096,1]}, "native wait lost independent progress or no-headroom custody")
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
