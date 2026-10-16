#!/usr/bin/env python3
"""Require complete startup and independent progress through actual Critical waits."""

import argparse
import json
import pathlib

import critical_report as critical
import foreground_report as foreground
import logical_report
import pressure_report as pressure
import report
import startup_report as startup

PREFIX = "NATIVE_CRITICAL_PROGRESS_WITNESS "
CASES = {f"CriticalProgress-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("startup_unknown", "pressure_pool_wait_progress", "pressure_status_wait_progress",
          "foreground_pool_wait_progress", "foreground_status_wait_progress",
          "foreground_io_wait_progress", "producers_joined")


def pressure_state(value, policy, initial, event):
    if (not isinstance(value, dict) or set(value) != {"state", "available_bytes", "samples"}
            or value["state"] != "Critical" or not pressure.integer(value["available_bytes"])
            or value["available_bytes"] > policy["critical_available_bytes"]
            or not isinstance(value["samples"], list)):
        raise ValueError("progress lacks actual Critical observations")
    previous, fresh = -1, False
    for sample in value["samples"]:
        logical_report.sample(sample, initial, event, policy)
        if sample["read_start_offset_ns"] <= previous:
            raise ValueError("progress replays an actual observation")
        previous = sample["read_start_offset_ns"]
        if (sample["available_bytes"] == value["available_bytes"]
                and sample["age_ns"] + event-sample["finished_ns"] < policy["max_sample_age_millis"]*1_000_000):
            fresh = True
    if not fresh:
        raise ValueError("progress Critical decision has no fresh actual sample")


def pending(value, held_key, phase, event, before=None):
    held, observed = value.get(held_key), value.get("pending_observed_ns")
    if (not report.positive_integer(held) or not report.positive_integer(observed)
            or not phase < held < observed < event):
        raise ValueError("actual held Pending observation clocks missing")
    if before is not None and held != before:
        raise ValueError("held resource identity changed")
    return observed


def validate(directory):
    directory = pathlib.Path(directory)
    result = critical.validate_cases(directory, CASES)
    _, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, _, _ = startup.original_inputs(collector["metadata"], result["artifacts"], "native_critical")
    witnesses = {case: [] for case in CASES}
    prepared = {case: [] for case in CASES}
    for line in (directory/"stdout.log").read_text().splitlines():
        if line.startswith(foreground.PREFIX):
            event=json.loads(line[len(foreground.PREFIX):],object_pairs_hook=pressure.unique_object)
            if event.get("case") not in CASES or event.get("phase")!="foreground_prepared":
                raise ValueError("unexpected foreground completion witness")
            prepared[event["case"]].append(event)
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns",
                "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1 or event["case"] not in CASES
                or not report.positive_integer(event["monotonic_ns"]) or not report.positive_integer(event["unix_ns"])
                or not isinstance(event["evidence"], dict)):
            raise ValueError("invalid Critical progress witness")
        witnesses[event["case"]].append(event)
    runners, operations = set(), set()
    guests={v["sandbox_id"] for v in result["cases"].values()}
    backings={v["backing_generation"] for v in result["cases"].values()}
    for case, events in witnesses.items():
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered Critical progress phases")
        terminal = terminals[case]
        inherited = result["cases"][case]["critical"]["witnesses"]
        original = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        clocks = [inherited[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events), terminal[-1]["monotonic_ns"]]
        if (any(a >= b for a,b in zip(clocks,clocks[1:]))
                or any((e["sandbox_id"],e["backing_generation"]) != original for e in events)
                or not events[0]["monotonic_ns"] < inherited[2]["monotonic_ns"] < events[1]["monotonic_ns"]
                or not events[2]["monotonic_ns"] < inherited[3]["monotonic_ns"] < inherited[4]["monotonic_ns"] < events[3]["monotonic_ns"]
                or not events[5]["monotonic_ns"] < inherited[5]["monotonic_ns"] < inherited[6]["monotonic_ns"] < events[6]["monotonic_ns"]):
            raise ValueError("Critical startup/wave/progress/original ordering changed")
        unknown = events[0]["evidence"]
        startup.complete(unknown.get("startup")); critical.no_reads(unknown.get("reads"), False)
        pool_held, status_held = unknown.get("pool_held_ns"), unknown.get("status_held_ns")
        if (not all(report.positive_integer(n) for n in (pool_held,status_held))
                or not inherited[0]["monotonic_ns"] < pool_held <= status_held < events[0]["monotonic_ns"]):
            raise ValueError("Critical initial held resources missing")
        startup.exact(unknown, {"startup": unknown["startup"], "startup_drained": True,
            "reads": unknown["reads"], "state": "Unknown", "startup_pressure_guarded": False,
            "pool_held_ns": pool_held, "status_held_ns": status_held, "allocated": [6,12288,3]},
            "Critical complete startup/Unknown/full leases changed")
        first_runner = None
        for index in range(1,6):
            event, value = events[index], events[index]["evidence"]
            critical.no_reads(value.get("reads"), False)
            pressure_state(value.get("pressure"),policy,events[0]["monotonic_ns"],event["monotonic_ns"])
            common = {"pressure":value["pressure"],"reads":value["reads"]}
            if index in (1,3):
                key = "actual_pressure_pool_pending" if index == 1 else "actual_foreground_pool_pending"
                observed = value.get("pending_observed_ns")
                held = value.get("pool_held_ns")
                lower = inherited[0]["monotonic_ns"] if index == 1 else terminal[3]["monotonic_ns"]
                pending(value,"pool_held_ns",lower,event["monotonic_ns"],pool_held if index==1 else None)
                foreground.observer(value.get("observer"),observed,event["monotonic_ns"])
                expected = common | {"pool_held_ns":held,"pending_observed_ns":observed,key:True,
                    "observer":value["observer"],"allocated":[6,12288,3] if index==1 else [2,4096,1]}
                if index == 1:
                    before, after = value.get("waits_before"),value.get("waits_after")
                    if not pressure.integer(before) or not pressure.integer(after) or after != before+1:
                        raise ValueError("actual pressure pool Pending count missing")
                    expected.update(waits_before=before,waits_after=after)
                else:
                    if not held <= value.get("status_held_ns",0) < observed:
                        raise ValueError("foreground held status missing")
                    expected.update(status_held_ns=value["status_held_ns"],original_kernel_io_blocked=True)
            else:
                reporting = value.get("reporting")
                if not isinstance(reporting,dict) or set(reporting)!={"heartbeat","observer"}:
                    raise ValueError("Critical independent reporting missing")
                if index in (2,4):
                    previous=events[index-1]["evidence"]
                    held=value.get("status_held_ns"); released=value.get("pool_released_ns"); observed=value.get("pending_observed_ns")
                    wanted=status_held if index==2 else previous["status_held_ns"]
                    if (held != wanted or not all(report.positive_integer(n) for n in (released,observed))
                            or not events[index-1]["monotonic_ns"] < released < observed < event["monotonic_ns"]):
                        raise ValueError("actual pressure/foreground status Pending missing")
                    expected=common|{"status_held_ns":held,"pool_released_ns":released,"pending_observed_ns":observed,
                        "actual_pressure_status_pending" if index==2 else "actual_foreground_status_pending":True,
                        "reporting":reporting,"allocated":[4,8192,2] if index==2 else [2,4096,1]}
                    if index==2:
                        before,after=value.get("waits_before"),value.get("waits_after")
                        if not pressure.integer(before) or not pressure.integer(after) or after!=before+1:
                            raise ValueError("specific pressure status Pending count missing")
                        expected.update(waits_before=before,waits_after=after,first_blank_cleanup_completed=True)
                    else:expected.update(original_kernel_io_blocked=True)
                else:
                    observed=events[4]["monotonic_ns"]
                    fresh=value.get("foreground")
                    if (not isinstance(fresh,dict) or set(fresh)!={"sandbox_id","run_id","operation_id","backing_generation","backing_exit_confirmed"}
                            or fresh["backing_exit_confirmed"] is not True):
                        raise ValueError("foreground actual physical completion missing")
                    if len(prepared[case])!=1:
                        raise ValueError("actual foreground RPC/phase receipt missing or duplicated")
                    receipt=prepared[case][0]
                    if (not events[4]["monotonic_ns"] < receipt["monotonic_ns"] < event["monotonic_ns"]
                            or (receipt["sandbox_id"],receipt["backing_generation"])!=original):
                        raise ValueError("foreground receipt escaped original IO or changed identity")
                    startup.exact(receipt["evidence"],{"kind":"Fresh","sandbox_id":fresh["sandbox_id"],
                        "run_id":fresh["run_id"],"operation_id":fresh["operation_id"],"guest_rpc_completed":True,
                        "phase_settled":True,"original_owner_preserved":True,"allocated":[2,4096,1]},
                        "foreground exact actual RPC/phase linkage missing")
                    for key,seen,original_value in (("sandbox_id",guests,original[0]),("run_id",guests,None),
                            ("operation_id",operations,None),("backing_generation",backings,original[1])):
                        item=fresh[key]
                        if not foreground.identifier(item) or item==original_value or item in seen:
                            raise ValueError("foreground original/new physical authority identity reused")
                        seen.add(item)
                    expected=common|{"foreground":fresh,"foreground_joined":True,"guest_rpc_completed":True,"phase_settled":True,
                        "original_kernel_io_blocked":True,"release_byte_withheld":True,"original_full_lease":[2,4096,1],
                        "reporting":reporting,"allocated":[2,4096,1]}
                sequence={2:1,4:2,5:3}[index]
                runner=foreground.heartbeat(reporting["heartbeat"],sequence,observed,event["monotonic_ns"],(4,8192) if index==2 else (2,4096))
                foreground.observer(reporting["observer"],observed,event["monotonic_ns"])
                if first_runner is None:first_runner=runner
                if runner!=first_runner or runner in runners:
                    raise ValueError("Critical reporting lost its original generation")
            if index>=3 and not terminal[3]["monotonic_ns"] < event["monotonic_ns"] < terminal[4]["monotonic_ns"]:
                raise ValueError("foreground progress escaped original blocked durable IO")
            startup.exact(value,expected,"Critical actual progress/full original custody changed")
        runners.add(first_runner)
        joined=events[-1]["evidence"]
        startup.complete(joined.get("startup"));critical.no_reads(joined.get("reads"),True)
        startup.exact(joined,{"startup":joined["startup"],"reads":joined["reads"],"startup_drained":True,
            "runtime_drained":True,"foreground_joined":True,"heartbeat_joined":True,"provider_joined":True,"peer_joined":True,
            "pressure_stopped":True,"snapshot_reverified":True,"allocated":[0,0,0]},"Critical accepted producer joins incomplete")
        result["cases"][case]["critical_progress"]=events
    result.update(format="native-critical-progress-report-v1",native_critical_progress_complete=True,
        startup_pressure_guarded=False,remaining_parent_gate="40355 accepted cancellation/provider late results and final reconciliation; production/higher/P4 limits")
    return result


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory",type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory),indent=2))
