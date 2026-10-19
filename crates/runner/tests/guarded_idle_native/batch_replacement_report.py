#!/usr/bin/env python3
"""Validate captured-batch refusal after a distinct native same-key replacement."""

import argparse
import json
import pathlib

import batch_aba_report as batch
import foreground_report as foreground
import later_parking_report as later
import pressure_report as pressure
import report
import status_failure_report as failure
from cleanup_report import COUNTS, accounting, supplied_policy
from startup_report import exact

PREFIX = "NATIVE_BATCH_REPLACEMENT_WITNESS "
CASES = {f"BatchReplacement-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("admission_blocked", "tail_blocked", "pool_wait_progress", "tail_wait_progress",
          "original_saved", "status_wait_progress", "batch_refused", "incoming_retired", "producers_joined")


def covered(value, policy):
    if not isinstance(value, dict) or not isinstance(value.get("accounting"), dict):
        raise ValueError("replacement lacks accepted original custody")
    state = value["accounting"]
    if (set(state) != COUNTS | {"closed"} or state["closed"] is not False
            or any(not pressure.integer(state[k]) for k in COUNTS)
            or state["queued"] != 2 or state["registered_operations"] < 3
            or state["started"] < 1 or state["tracked_tasks"] < 1
            or any(state[k] != 0 for k in ("granted", "uncertain", "ordinary_growth_bytes"))
            or not policy["tail_growth_bytes"] <= state["cleanup_growth_bytes"]
            <= policy["tail_growth_bytes"] + policy["live_growth_bytes"]):
        raise ValueError("replacement released saving or unused old claims")
    exact(value, {"allocated": [4,8192,2], "accounting": state,
                  "original_lease_active": True, "io_release_withheld": True},
          "replacement lost either full lease or accepted IO")


def validate(directory, cases=CASES, policy_key="native_batch_replacement_policy_json"):
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
            raise ValueError("invalid replacement witness")
        witnesses[event["case"]].append(event)
    identities = {e[1][k] for e in terminals.values() for k in ("sandbox_id", "backing_generation")}
    operations, runners, paths = set(), set(), set()
    zero = dict.fromkeys(COUNTS, 0) | {"closed": False}
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered replacement phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        if any((e["sandbox_id"], e["backing_generation"]) != identity for e in events):
            raise ValueError("replacement changed the original physical owner")
        ordered = [terminal[1],events[0],terminal[2],terminal[3],*events[1:4],terminal[4],*events[4:],terminal[5]]
        for field in ("monotonic_ns", "unix_ns"):
            if any(a[field] >= b[field] for a,b in zip(ordered,ordered[1:])):
                raise ValueError("replacement original saving/old refusal/new recovery order changed")
        blocked, tail, pool, progress, saved, waiting, refused, retired, joined = [e["evidence"] for e in events]
        path = blocked.get("status_path")
        if (not isinstance(path,str) or not pathlib.PurePosixPath(path).is_absolute()
                or str(pathlib.PurePosixPath(path)) != path or ".." in pathlib.PurePosixPath(path).parts
                or pathlib.PurePosixPath(path).name != "status.json" or path in paths):
            raise ValueError("replacement private status path changed")
        paths.add(path)
        initial = blocked.get("published_status")
        failure.status(initial,sandbox=identity[0])
        reuse = initial["idle_sandboxes"][0]["reuse_key"]
        selected = blocked.get("selected_revision")
        if not pressure.integer(selected,1):
            raise ValueError("replacement selected revision missing")
        prep = blocked.get("preparation")
        if not isinstance(prep,dict):
            raise ValueError("replacement actual incoming preparation missing")
        new, backing, operation = [later.identifier(prep.get(k)) for k in ("sandbox_id","backing_generation","operation_id")]
        if (len({new,backing,operation}) != 3 or {new,backing,operation} & identities
                or operation in operations or operation == reuse.removeprefix("thread:native-guarded-")):
            raise ValueError("replacement reused original/incoming operation or physical identity")
        identities.update((new,backing,operation)); operations.add(operation)
        begin = batch.clock(prep.get("grant_started_ns"),terminal[1]["monotonic_ns"],events[0]["monotonic_ns"])
        granted = batch.clock(prep.get("grant_finished_ns"),begin,events[0]["monotonic_ns"])
        prepared = batch.clock(prep.get("prepared_ns"),granted,events[0]["monotonic_ns"])
        exact(prep,{"sandbox_id":new,"backing_generation":backing,"operation_id":operation,
            "grant_started_ns":begin,"grant_finished_ns":granted,"prepared_ns":prepared,
            "guest_rpc_completed":True,"phase_settled":True,"separate_incoming_lease":True},
            "replacement preparation lost real RPC/park/Fresh settlement")
        batch.queued(blocked.get("accounting"))
        exact(blocked,{"policy":policy,"status_path":path,"published_status":initial,
            "selected_revision":selected,"preparation":prep,"same_reuse_key":reuse,
            "source_read_blocked":True,"receiver_polled_pending":True,"accounting":blocked["accounting"],
            "allocated":[4,8192,2],"original_full_lease_active":True,
            "original_exit_polled_pending":True,"incoming_exit_polled_pending":True},
            "replacement old admission lost original or incoming full custody")
        insertion = batch.clock(tail.get("insertion_started_ns"),events[0]["monotonic_ns"],terminal[2]["monotonic_ns"])
        revision = tail.get("revision")
        if not pressure.integer(revision,selected+1):
            raise ValueError("same-key replacement did not change insertion revision")
        covered(tail.get("coverage"),policy)
        exact(tail,{"insertion_started_ns":insertion,"revision":revision,"original_exit_confirmed":True,
            "receiver_polled_pending":True,"coverage":tail["coverage"]},"replacement original exit/custody missing")
        held = batch.clock(pool.get("pool_held_ns"),events[1]["monotonic_ns"],events[2]["monotonic_ns"])
        polled = batch.clock(pool.get("heartbeat_pending_ns"),held,events[2]["monotonic_ns"])
        foreground.observer(pool.get("observer"),polled,events[2]["monotonic_ns"])
        covered(pool.get("coverage"),policy)
        exact(pool,{"pool_held_ns":held,"heartbeat_pending_ns":polled,"heartbeat_polled_pending":True,
            "observer":pool["observer"],"coverage":pool["coverage"]},"replacement held-pool observer progress missing")
        released = batch.clock(progress.get("pool_released_ns"),events[2]["monotonic_ns"],events[3]["monotonic_ns"])
        first = foreground.heartbeat(progress.get("heartbeat"),1,released,events[3]["monotonic_ns"],(4,8192))
        covered(progress.get("coverage"),policy)
        exact(progress,{"pool_released_ns":released,"heartbeat":progress["heartbeat"],
            "receiver_polled_pending":True,"coverage":progress["coverage"]},"replacement held-IO heartbeat missing")
        released = batch.clock(saved.get("io_released_ns"),events[3]["monotonic_ns"],terminal[4]["monotonic_ns"])
        completed = batch.clock(saved.get("retirement_joined_ns"),terminal[4]["monotonic_ns"],events[4]["monotonic_ns"])
        exact(saved,{"io_released_ns":released,"retirement_joined_ns":completed,"home_cache_promoted":True,
            "original_exit_confirmed":True,"original_lease_released":True,"incoming_exit_polled_pending":True,
            "receiver_polled_pending":True,"allocated":[2,4096,1]},"original saving consumed incoming or lost required home")
        held = batch.clock(waiting.get("status_held_ns"),events[4]["monotonic_ns"],events[5]["monotonic_ns"])
        resumed = batch.clock(waiting.get("source_resumed_ns"),held,events[5]["monotonic_ns"])
        polled = batch.clock(waiting.get("status_wait_polled_ns"),resumed,events[5]["monotonic_ns"])
        before,after = waiting.get("status_waits_before"),waiting.get("status_waits_after")
        if not pressure.integer(before) or not pressure.integer(after) or after != before+1:
            raise ValueError("replacement final status wait not observed")
        second = foreground.heartbeat(waiting.get("heartbeat"),2,polled,events[5]["monotonic_ns"])
        if first != second or first in runners:
            raise ValueError("replacement heartbeat runner replayed")
        runners.add(first)
        samples = waiting.get("samples")
        batch.reads(samples,policy,events[0]["monotonic_ns"],events[5]["monotonic_ns"])
        if (not any(insertion < s["started_ns"] < s["finished_ns"] < events[1]["monotonic_ns"] for s in samples)
                or not any(resumed < s["started_ns"] < s["finished_ns"] < polled for s in samples)):
            raise ValueError("replacement and old resumed claims lack distinct real fresh reads")
        exact(waiting.get("accounting"),zero,"replacement old unused claims not settled")
        exact(waiting,{"status_held_ns":held,"source_resumed_ns":resumed,"status_wait_polled_ns":polled,
            "status_waits_before":before,"status_waits_after":after,"heartbeat":waiting["heartbeat"],
            "accounting":zero,"samples":samples,"receiver_polled_pending":True,"allocated":[2,4096,1]},
            "replacement final status progress/custody missing")
        released = batch.clock(refused.get("status_released_ns"),events[5]["monotonic_ns"],events[6]["monotonic_ns"])
        completed = batch.clock(refused.get("batch_joined_ns"),released,events[6]["monotonic_ns"])
        later.current_status(refused.get("published_status"),initial,new,reuse)
        exact(refused,{"status_released_ns":released,"batch_joined_ns":completed,"selected":1,"completed":0,
            "uncertain":0,"not_started":1,"status_error":False,"is_complete":False,
            "refused_sandbox_id":identity[0],"refused_reuse_key":reuse,"error":"AccountingChanged",
            "revision":revision,"published_status":refused["published_status"],"regular_file":True,
            "incoming_exit_polled_pending":True,"allocated":[2,4096,1]},"old batch adopted incoming or changed exact refusal")
        started = batch.clock(retired.get("started_ns"),events[6]["monotonic_ns"],events[7]["monotonic_ns"])
        completed = batch.clock(retired.get("joined_ns"),started,events[7]["monotonic_ns"])
        later.current_status(retired.get("published_status"),refused["published_status"])
        exact(retired,{"started_ns":started,"joined_ns":completed,"selected":1,"completed":1,"uncertain":0,
            "not_started":0,"status_error":False,"is_complete":True,"incoming_exit_confirmed":True,
            "published_status":retired["published_status"],"allocated":[0,0,0]},"incoming separate recovery did not join")
        accounting(joined.get("accounting"),True)
        exact(joined,{"old_batch_joined":True,"replacement_joined":True,"incoming_batch_joined":True,
            "tracker_joined":True,"accounting_joined":True,"heartbeat_joined":True,"provider_joined":True,"peer_joined":True,
            "remaining_activation_owners":0,"remaining_finalizing_owners":0,
            "allocated":[0,0,0],"accounting":joined["accounting"]},"replacement producers remain owned")
    return {**result,"format":"native-batch-replacement-report-v1","native_batch_replacement_complete":True,
            "replacement_scope":"same-key distinct tenant-free incoming; original required home; captured old AccountingChanged",
            "incoming_required_history_proven":False,"actual_api_claim_loss_proven":False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory",type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory),indent=2,sort_keys=True))
