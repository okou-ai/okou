#!/usr/bin/env python3
"""Validate actual owned create IO, cancelled observers and positive rollback."""

import argparse
import hashlib
import json
import pathlib
import re

import foreground_report as foreground
import pressure_report as pressure
import read_cancellation_report as reads
import report
import startup_report as startup

PREFIX = "NATIVE_CREATE_CANCELLATION_WITNESS "
CASES = {f"CreateCancellation-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "create_accepted", "cancel_wait", "create_joined", "producers_joined", "accounting_closed")
ERROR = "creation cancelled/lost; joined physical rollback, Fresh remains uncertain"


def ordered(values):
    if any(not report.positive_integer(v) for v in values) or any(a >= b for a,b in zip(values,values[1:])):
        raise ValueError("actual create physical clock order changed")


def accounting(value, growth, uncertain=False):
    tracked = value.get("tracked_tasks") if isinstance(value,dict) else None
    if not pressure.integer(tracked, 0 if uncertain else 1) or (uncertain and tracked != 0):
        raise ValueError("actual create tracked custody changed")
    startup.exact(value, {"registered_operations":1, "started":0 if uncertain else 1,
        "ordinary_growth_bytes":growth,"cleanup_growth_bytes":0,"tracked_tasks":tracked,"uncertain":int(uncertain)},
        "actual create original P2 allowance/uncertainty changed")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, inputs, raw = startup.original_inputs(collector["metadata"], result["artifacts"], "native_create_cancellation")
    witnesses = {case:[] for case in CASES}
    for line in (directory/"stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX): continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event,dict) or set(event) != {"version","case","phase","monotonic_ns","unix_ns","sandbox_id","backing_generation","evidence"}
                or type(event["version"]) is not int or event["version"] != 1 or event["case"] not in CASES
                or not report.positive_integer(event["monotonic_ns"]) or not report.positive_integer(event["unix_ns"])
                or not isinstance(event["evidence"],dict)):
            raise ValueError("invalid actual create witness")
        witnesses[event["case"]].append(event)
    generations, created_ids = set(), set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered actual create phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        if any((e["sandbox_id"],e["backing_generation"]) != identity for e in events):
            raise ValueError("actual create lost original generation")
        ordered([terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events[:5]), terminal[2]["monotonic_ns"]])
        ordered([terminal[4]["monotonic_ns"], events[-1]["monotonic_ns"], terminal[-1]["monotonic_ns"]])
        initial, accepted, waiting, joined, producers, closed = [e["evidence"] for e in events]
        preparation = policy["replacement_preparation_bytes"]
        growth = startup.BYTES+preparation
        startup.exact(initial,{"policy":policy,"inputs_sha256":hashlib.sha256(raw.encode()).hexdigest(),
            "snapshot_sha256":result["artifacts"]["snapshot_files"]["memory.bin"],"snapshot_bytes":startup.BYTES,
            "prefetch_overhead_bytes":inputs["prefetch_overhead_bytes"],"preparation_bytes":preparation,
            "allocated":[2,4096,1],"checkpoint_models_stalled_storage":False},"actual create inputs/full original lease changed")
        created = accepted.get("created")
        if not isinstance(created,dict): raise ValueError("actual formatted home absent")
        path = pathlib.PurePosixPath(created.get("home_path", ""))
        if (not path.is_absolute() or ".." in path.parts or path.name != "home.ext4"
                or not foreground.identifier(path.parent.name) or path.parent.name == identity[0]
                or path.parent.name in created_ids or not isinstance(created.get("superblock_hex"),str)
                or not re.fullmatch(r"[0-9a-f]{2048}",created["superblock_hex"])):
            raise ValueError("actual home bytes/identity/path changed")
        block=bytes.fromhex(created["superblock_hex"])
        if block[56:58] != b"\x53\xef" or hashlib.sha256(block).hexdigest() != created.get("superblock_sha256"):
            raise ValueError("actual ext4 superblock bytes/hash mismatch")
        created_ids.add(path.parent.name)
        ordered([events[0]["monotonic_ns"],created.get("held_ns"),events[1]["monotonic_ns"]])
        startup.exact(created,{"home_path":str(path),"home_bytes":report.NATIVE_HOME_BYTES,"ext4_magic":"53ef",
            "superblock_hex":created["superblock_hex"],"superblock_sha256":created["superblock_sha256"],"held_ns":created["held_ns"]},"actual formatted home shape changed")
        actual = accepted.get("samples")
        reads.samples(actual, events[0]["monotonic_ns"],events[1]["monotonic_ns"],policy)
        fresh = []
        for value in actual:
            if (pressure.integer(value["available_bytes"],policy["recovery_available_bytes"])
                    and value["age_ns"]+events[1]["monotonic_ns"]-value["finished_ns"] < policy["max_sample_age_millis"]*1_000_000): fresh.append(value)
            else: fresh=[]
        if (not pressure.integer(accepted.get("available_bytes"),policy["recovery_available_bytes"])
                or len(fresh)<2 or fresh[-1]["read_start_offset_ns"]-fresh[0]["read_start_offset_ns"] < policy["pressure_recovery_sustain_millis"]*1_000_000
                or not any(v["available_bytes"] == accepted.get("available_bytes") for v in fresh)):
            raise ValueError("actual create lacks sustained fresh Ready")
        accounting(accepted.get("accounting"),growth)
        startup.exact(accepted,{"created":created,"state":"Ready","available_bytes":accepted["available_bytes"],
            "samples":actual,"accounting":accepted["accounting"],"allocated":[4,8192,2],"release_byte_withheld":True},"accepted actual create custody changed")
        ordered([events[1]["monotonic_ns"], *(waiting.get(k) for k in ("cancelled_ns","first_dropped_ns","second_pending_ns","foreground_acquired_ns")),events[2]["monotonic_ns"]])
        accounting(waiting.get("accounting"),growth)
        foreground.observer(waiting.get("observer"),waiting["foreground_acquired_ns"],events[2]["monotonic_ns"])
        generation=foreground.heartbeat(waiting.get("heartbeat"),1,waiting["foreground_acquired_ns"],events[2]["monotonic_ns"],allocated=(4,8192))
        if generation in generations: raise ValueError("actual create heartbeat generation replayed")
        generations.add(generation)
        startup.exact(waiting,{**{k:waiting[k] for k in ("cancelled_ns","first_dropped_ns","second_pending_ns","foreground_acquired_ns","accounting","heartbeat","observer")},
            "first_pending":True,"first_dropped":True,"second_pending":True,"release_byte_withheld":True,"allocated":[4,8192,2]},"cancelled actual create observer custody changed")
        completion=joined.get("completion")
        if not isinstance(completion,dict): raise ValueError("actual workspace rollback absent")
        accounting(completion.get("accounting"),growth)
        startup.exact(completion,{"workspace":str(path.parent),"workspace_absent":True,"cleanup_ns":completion.get("cleanup_ns"),
            "allocated":[4,8192,2],"accounting":completion["accounting"]},"actual workspace cleanup lost full custody")
        ordered([events[2]["monotonic_ns"],joined.get("release_ns"),completion["cleanup_ns"],joined.get("joined_ns"),events[3]["monotonic_ns"]])
        accounting(joined.get("accounting"),growth,True)
        startup.exact(joined,{"completion":completion,"release_ns":joined["release_ns"],"joined_ns":joined["joined_ns"],
            "finished":True,"prepared":False,"published":False,"retained_resource":False,"error":ERROR,
            "allocated":[2,4096,1],"accounting":joined["accounting"]},"actual create cancellation/uncertainty result changed")
        accounting(producers.get("accounting"),growth,True)
        startup.exact(producers,{"blank_shutdown_joined":True,"pressure_stopped":True,"heartbeat_joined":True,
            "provider_joined":True,"peer_joined":True,"snapshot_reverified":True,"allocated":[2,4096,1],
            "accounting":producers["accounting"]},"actual create producers not joined before original saving")
        startup.exact(closed,{"registered_operations":1,"tracked_tasks":0,"started":0,"uncertain":1,
            "ordinary_growth_bytes":growth,"cleanup_growth_bytes":0,"closed":True,"allocated":[0,0,0]},"closed actual create P2 uncertainty was discarded")
        result["cases"][case]["create_cancellation"]=events
    result.update(format="native-create-cancellation-report-v1",native_create_cancellation_complete=True,
        checkpoint_models_stalled_storage=False,remaining_parent_gate="40787 actual returned Guest/late results; 40788 post-merge reconciliation; production/higher/P4 limits")
    return result


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("directory",type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory),indent=2))
