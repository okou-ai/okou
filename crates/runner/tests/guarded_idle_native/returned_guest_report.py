#!/usr/bin/env python3
"""Require six actual returned-Guest stages, late custody and joined cleanup."""

import argparse
import hashlib
import json
import pathlib
import re

import create_cancellation_report as create
import foreground_report as foreground
import pressure_report as pressure
import read_cancellation_report as reads
import report
import startup_report as startup

PREFIX = "NATIVE_RETURNED_GUEST_WITNESS "
STAGES = ("start", "mount", "park")
CASES = {f"ReturnedGuest-{stage}-{mode}" for stage in STAGES for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "unaccepted_pool_wait", "stage_accepted", "cancel_wait",
          "late_joined", "cleanup_held", "cleanup_joined", "producers_joined", "accounting_closed")
ZERO = {"registered_operations": 0, "started": 0, "ordinary_growth_bytes": 0,
        "cleanup_growth_bytes": 0, "tracked_tasks": 0, "uncertain": 0}


def home(value, sandbox_id, filesystem_uuid=None):
    if not isinstance(value, dict):
        raise ValueError("actual returned home missing")
    path = pathlib.PurePosixPath(value.get("path", ""))
    block_hex = value.get("superblock_hex")
    if (not path.is_absolute() or ".." in path.parts or path.name != "home.ext4"
            or path.parent.name != sandbox_id or not isinstance(block_hex, str)
            or not re.fullmatch(r"[0-9a-f]{2048}", block_hex)):
        raise ValueError("actual returned home path/bytes changed")
    block = bytes.fromhex(block_hex)
    if block[56:58] != b"\x53\xef":
        raise ValueError("actual returned home is not ext4")
    actual_uuid = block[104:120].hex()
    if filesystem_uuid is not None and actual_uuid != filesystem_uuid:
        raise ValueError("actual returned home generation changed")
    startup.exact(value, {"path": str(path), "bytes": report.NATIVE_HOME_BYTES, "ext4_magic": "53ef",
        "filesystem_uuid": actual_uuid, "superblock_hex": block_hex,
        "superblock_sha256": hashlib.sha256(block).hexdigest()}, "actual returned home bytes/hash changed")
    return path, actual_uuid


def result(value, stage=None, retained=False):
    stage = "home_mount" if stage == "mount" else stage
    error = "optional pool wait cancelled" if stage is None else f"{stage}: optional work cancelled; resource retained"
    startup.exact(value, {"finished": True, "prepared": False, "published": False,
        "retained_resource": retained, "error": error}, "late result became prepared/published or lost custody")


def validate(directory):
    directory = pathlib.Path(directory)
    output, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, inputs, raw = startup.original_inputs(collector["metadata"], output["artifacts"], "native_returned_guest")
    witnesses = {case: [] for case in CASES}
    for line in (directory/"stdout.log").read_text().splitlines():
        if not line.startswith(PREFIX):
            continue
        event = json.loads(line[len(PREFIX):], object_pairs_hook=pressure.unique_object)
        if (not isinstance(event, dict) or set(event) != {"version", "case", "phase", "monotonic_ns", "unix_ns", "sandbox_id", "backing_generation", "evidence"}
                or type(event["version"]) is not int or event["version"] != 1 or event["case"] not in CASES
                or not report.positive_integer(event["monotonic_ns"]) or not report.positive_integer(event["unix_ns"])
                or not isinstance(event["evidence"], dict)):
            raise ValueError("invalid actual returned Guest witness")
        witnesses[event["case"]].append(event)
    identities, generations, home_uuids = set(), set(), set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        stage = case.split("-")[1]
        if tuple(e["phase"] for e in events) != PHASES:
            raise ValueError("missing duplicate or unordered returned Guest phases")
        identity = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
        if any((e["sandbox_id"], e["backing_generation"]) != identity for e in events):
            raise ValueError("returned Guest lost original identity")
        create.ordered([terminal[1]["monotonic_ns"], *(e["monotonic_ns"] for e in events[:-1]), terminal[2]["monotonic_ns"]])
        create.ordered([terminal[4]["monotonic_ns"], events[-1]["monotonic_ns"], terminal[-1]["monotonic_ns"]])
        initial, unaccepted, accepted, waiting, late, cleanup, cleaned, producers, closed = [e["evidence"] for e in events]
        growth = startup.BYTES+policy["replacement_preparation_bytes"]
        startup.exact(initial, {"policy": policy, "inputs_sha256": hashlib.sha256(raw.encode()).hexdigest(),
            "snapshot_sha256": output["artifacts"]["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
            "prefetch_overhead_bytes": inputs["prefetch_overhead_bytes"], "stage": stage,
            "allocated": [2,4096,1], "checkpoint_models_stalled_io": False}, "returned Guest original inputs changed")
        create.ordered([events[0]["monotonic_ns"], *(unaccepted.get(k) for k in ("pool_pending_ns", "foreground_acquired_ns", "joined_ns")),
                        unaccepted.get("observer", {}).get("completed_ns"), unaccepted.get("pool_released_ns"), events[1]["monotonic_ns"]])
        foreground.observer(unaccepted.get("observer"), unaccepted["joined_ns"], unaccepted["pool_released_ns"])
        result(unaccepted.get("result"))
        startup.exact(unaccepted, {**{k: unaccepted[k] for k in ("pool_pending_ns", "foreground_acquired_ns", "joined_ns", "pool_released_ns", "result", "observer")},
            "wait_pending": True, "wait_dropped": True, "no_provider_create": True,
            "allocated": [2,4096,1], "accounting": ZERO}, "unaccepted pool wait entered provider/P2 or lost original")
        actual = accepted.get("actual")
        if not isinstance(actual, dict) or not isinstance(actual.get("created"), dict):
            raise ValueError("actual returned Guest missing")
        created, stages = actual["created"], actual.get("stages")
        sandbox_id = created.get("sandbox_id")
        if not foreground.identifier(sandbox_id) or sandbox_id == identity[0] or sandbox_id in identities:
            raise ValueError("returned Guest identity reused")
        identities.add(sandbox_id)
        path, fs_uuid = home(created.get("home"), sandbox_id)
        if fs_uuid == "0"*32 or fs_uuid in home_uuids:
            raise ValueError("actual returned home filesystem generation replayed")
        home_uuids.add(fs_uuid)
        startup.exact(created, {"sandbox_id": sandbox_id, "returned_ns": created.get("returned_ns"), "home": created["home"]}, "returned creation shape changed")
        if not isinstance(stages, list) or [s.get("stage") for s in stages] != list(STAGES[:STAGES.index(stage)+1]):
            raise ValueError("actual successful Guest stages missing/substituted")
        backing = stages[0].get("backing_generation")
        if not foreground.identifier(backing) or backing == identity[1] or backing in identities:
            raise ValueError("actual returned backing generation reused")
        identities.add(backing)
        create.ordered([events[1]["monotonic_ns"], created["returned_ns"], *(s.get("completed_ns") for s in stages), events[2]["monotonic_ns"]])
        for item in stages:
            home(item.get("home"), sandbox_id, fs_uuid)
            startup.exact(item, {"stage": item["stage"], "completed_ns": item["completed_ns"], "sandbox_id": sandbox_id,
                "backing_generation": backing, "actual_success": True, "home": item["home"]}, "successful actual Guest stage changed")
        startup.exact(actual, {"created": created, "stages": stages, "cleanup": None}, "Guest cleaned before cancelled result")
        samples = accepted.get("samples")
        reads.samples(samples, events[0]["monotonic_ns"], events[2]["monotonic_ns"], policy)
        fresh = []
        for sample in samples:
            if (pressure.integer(sample["available_bytes"], policy["recovery_available_bytes"])
                    and sample["age_ns"]+events[2]["monotonic_ns"]-sample["finished_ns"] < policy["max_sample_age_millis"]*1_000_000):
                fresh.append(sample)
            else:
                fresh = []
        if (not pressure.integer(accepted.get("available_bytes"), policy["recovery_available_bytes"])
                or len(fresh)<2 or fresh[-1]["read_start_offset_ns"]-fresh[0]["read_start_offset_ns"] < policy["pressure_recovery_sustain_millis"]*1_000_000
                or not any(v["available_bytes"] == accepted["available_bytes"] for v in fresh)):
            raise ValueError("actual returned Guest lacks sustained fresh Ready")
        create.accounting(accepted.get("accounting"), growth)
        startup.exact(accepted, {"actual": actual, "samples": samples, "available_bytes": accepted["available_bytes"],
            "allocated": [4,8192,2], "accounting": accepted["accounting"], "release_byte_withheld": True}, "accepted Guest lost full custody")
        create.ordered([events[2]["monotonic_ns"], *(waiting.get(k) for k in ("cancelled_ns", "first_dropped_ns", "second_pending_ns", "foreground_acquired_ns")), events[3]["monotonic_ns"]])
        create.accounting(waiting.get("accounting"), growth)
        foreground.observer(waiting.get("observer"), waiting["foreground_acquired_ns"], events[3]["monotonic_ns"])
        generation = foreground.heartbeat(waiting.get("heartbeat"), 1, waiting["foreground_acquired_ns"], events[3]["monotonic_ns"], allocated=(4,8192))
        if generation in generations:
            raise ValueError("returned heartbeat generation replayed")
        generations.add(generation)
        startup.exact(waiting, {**{k: waiting[k] for k in ("cancelled_ns", "first_dropped_ns", "second_pending_ns", "foreground_acquired_ns", "accounting", "heartbeat", "observer")},
            "first_pending": True, "first_dropped": True, "second_pending": True, "release_byte_withheld": True,
            "allocated": [4,8192,2]}, "cancelled Guest observer custody changed")
        create.ordered([events[3]["monotonic_ns"], late.get("released_ns"), late.get("joined_ns"), events[4]["monotonic_ns"]])
        result(late.get("result"), stage, True)
        create.accounting(late.get("accounting"), growth, True)
        startup.exact(late, {**{k: late[k] for k in ("released_ns", "joined_ns", "result", "accounting")}, "allocated": [4,8192,2]}, "late result dropped actual Guest/full lease")
        cleanup_actual = cleanup.get("actual", {})
        completion = cleanup_actual.get("cleanup")
        if not isinstance(completion, dict):
            raise ValueError("actual required Guest cleanup missing")
        home(completion.get("last_home"), sandbox_id, fs_uuid)
        # The cleanup owner retains the original uncertain Fresh registration;
        # required retirement is tracked separately until this physical call returns.
        clean_accounting = completion.get("accounting")
        if not isinstance(clean_accounting, dict) or not pressure.integer(clean_accounting.get("tracked_tasks"), 1):
            raise ValueError("required cleanup physical owner missing")
        startup.exact(clean_accounting, {"registered_operations": 2, "started": 1, "ordinary_growth_bytes": growth,
            "cleanup_growth_bytes": policy["tail_growth_bytes"], "tracked_tasks": clean_accounting["tracked_tasks"], "uncertain": 1}, "required cleanup discarded uncertain Fresh growth or its required tail")
        startup.exact(completion, {"sandbox_id": sandbox_id, "backing_generation": backing, "positive_backing_wait": True,
            "workspace": str(path.parent), "workspace_absent": True, "last_home": completion["last_home"],
            "cleanup_ns": completion.get("cleanup_ns"), "allocated": [4,8192,2], "accounting": clean_accounting}, "actual cleanup lost exact backing/workspace/full leases")
        startup.exact(cleanup_actual, {"created": created, "stages": stages, "cleanup": completion}, "cleanup switched actual Guest")
        create.ordered([events[4]["monotonic_ns"], completion["cleanup_ns"], cleanup.get("pending_ns"), events[5]["monotonic_ns"]])
        foreground.observer(cleanup.get("observer"), cleanup["pending_ns"], events[5]["monotonic_ns"])
        if foreground.heartbeat(cleanup.get("heartbeat"), 2, cleanup["pending_ns"], events[5]["monotonic_ns"], allocated=(4,8192)) != generation:
            raise ValueError("cleanup heartbeat generation changed")
        result(cleanup.get("result"), stage, True)
        startup.exact(cleanup, {**{k: cleanup[k] for k in ("actual", "pending_ns", "result", "heartbeat", "observer")},
            "invalid_mode": "Draining", "cleanup_pending": True, "release_byte_withheld": True,
            "allocated": [4,8192,2], "accounting": clean_accounting}, "required cleanup custody/wait changed")
        create.ordered([events[5]["monotonic_ns"], cleaned.get("release_ns"), cleaned.get("joined_ns"), events[6]["monotonic_ns"]])
        result(cleaned.get("result"), stage)
        create.accounting(cleaned.get("accounting"), growth, True)
        startup.exact(cleaned, {**{k: cleaned[k] for k in ("release_ns", "joined_ns", "result", "accounting")},
            "positive_backing_wait": True, "blank_count": 0, "allocated": [2,4096,1]}, "late cleanup failed to join before lease release")
        create.accounting(producers.get("accounting"), growth, True)
        startup.exact(producers, {"optional_joined": True, "pressure_stopped": True, "heartbeat_joined": True,
            "provider_joined": True, "peer_joined": True, "snapshot_reverified": True,
            "allocated": [2,4096,1], "accounting": producers["accounting"]}, "returned Guest dependencies not joined before original saving")
        startup.exact(closed, {"registered_operations": 1, "tracked_tasks": 0, "started": 0, "uncertain": 1,
            "ordinary_growth_bytes": growth, "cleanup_growth_bytes": 0, "closed": True, "allocated": [0,0,0]}, "closed returned Guest P2 uncertainty discarded")
        output["cases"][case]["returned_guest"] = events
    output.update(format="native-returned-guest-report-v1", native_returned_guest_complete=True,
        checkpoint_models_stalled_io=False, remaining_parent_gate="40788 post-merge reconciliation; production/higher/P4 limits")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory), indent=2))
