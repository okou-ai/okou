#!/usr/bin/env python3
"""Validate actual owned create IO, cancelled observers and positive rollback."""

import hashlib
import pathlib

import create_custody_report as custody
import ext4_superblock
import progress_report as foreground
import report
import snapshot_report as startup

PREFIX = "NATIVE_CREATE_CANCELLATION_WITNESS "
CASES = {f"CreateCancellation-{mode}" for mode in ("fresh", "snapshot")}
PHASES = ("inputs_verified", "create_accepted", "cancel_wait", "create_joined", "producers_joined", "accounting_closed")


def validate(directory):
    directory = pathlib.Path(directory)
    result, collector, terminals = report._validate_cases(directory, CASES, report.PHASES)
    policy, raw = startup.original_inputs(collector["metadata"], result["artifacts"], "native_create_cancellation")
    witnesses = report.collect_case_witnesses(
        directory / 'stdout.log', PREFIX, CASES,
        invalid_message="invalid actual create witness",
    )
    generations, created_ids = set(), set()
    for case, events in witnesses.items():
        terminal = terminals[case]
        report.validate_witness_phases(
            events, PHASES, "missing duplicate or unordered actual create phases",
        )
        identity = report.witness_identity(result["cases"][case])
        if report.witness_identity_changed(events, identity):
            raise ValueError("actual create lost original generation")
        custody.validate_ordered_clocks([
            terminal[1]["monotonic_ns"],
            *(e["monotonic_ns"] for e in events[:5]),
            terminal[2]["monotonic_ns"],
        ])
        custody.validate_ordered_clocks([
            terminal[4]["monotonic_ns"], events[-1]["monotonic_ns"], terminal[-1]["monotonic_ns"],
        ])
        initial, accepted, waiting, joined, producers, closed = [e["evidence"] for e in events]
        preparation = policy["replacement_preparation_bytes"]
        growth = startup.BYTES+preparation
        report.exact(initial,{"policy":policy,"inputs_sha256":hashlib.sha256(raw.encode()).hexdigest(),
            "snapshot_sha256":result["artifacts"]["snapshot_files"]["memory.bin"],"snapshot_bytes":startup.BYTES,
            "preparation_bytes":preparation,
            "allocated":[2,4096,1],"checkpoint_models_stalled_storage":False},"actual create inputs/full original lease changed")
        created = accepted.get("created")
        if not isinstance(created,dict): raise ValueError("actual formatted home absent")
        path = pathlib.PurePosixPath(created.get("home_path", ""))
        if (not path.is_absolute() or ".." in path.parts or path.name != "home.ext4"
                or not foreground.identifier(path.parent.name) or path.parent.name == identity[0]
                or path.parent.name in created_ids):
            raise ValueError("actual home bytes/identity/path changed")
        block = ext4_superblock.decode_hex(
            created.get("superblock_hex"), "actual home bytes/identity/path changed"
        )
        if (not ext4_superblock.has_magic(block)
                or hashlib.sha256(block).hexdigest() != created.get("superblock_sha256")):
            raise ValueError("actual ext4 superblock bytes/hash mismatch")
        created_ids.add(path.parent.name)
        custody.validate_ordered_clocks([
            events[0]["monotonic_ns"], created.get("held_ns"), events[1]["monotonic_ns"],
        ])
        report.exact(created,{"home_path":str(path),"home_bytes":report.NATIVE_HOME_BYTES,
            "ext4_magic":ext4_superblock.MAGIC_HEX,
            "superblock_hex":created["superblock_hex"],"superblock_sha256":created["superblock_sha256"],"held_ns":created["held_ns"]},"actual formatted home shape changed")
        actual = custody.validate_accepted_pressure(
            accepted, events[0]["monotonic_ns"], events[1]["monotonic_ns"], policy,
            "actual create lacks sustained fresh Ready",
        )
        custody.validate_accounting(accepted.get("accounting"), growth)
        report.exact(accepted,{"created":created,"state":"Ready","available_bytes":accepted["available_bytes"],
            "samples":actual,"accounting":accepted["accounting"],"allocated":[4,8192,2],"release_byte_withheld":True},"accepted actual create custody changed")
        custody.validate_cancel_wait(
            waiting, events[1]["monotonic_ns"], events[2]["monotonic_ns"], growth, generations,
            replay_message="actual create heartbeat generation replayed",
            receipt_message="cancelled actual create observer custody changed",
        )
        completion=joined.get("completion")
        if not isinstance(completion,dict): raise ValueError("actual workspace rollback absent")
        custody.validate_accounting(completion.get("accounting"), growth)
        report.exact(completion,{"workspace":str(path.parent),"workspace_absent":True,"cleanup_ns":completion.get("cleanup_ns"),
            "allocated":[4,8192,2],"accounting":completion["accounting"]},"actual workspace cleanup lost full custody")
        custody.validate_ordered_clocks([
            events[2]["monotonic_ns"], joined.get("release_ns"), completion["cleanup_ns"],
            joined.get("joined_ns"), events[3]["monotonic_ns"],
        ])
        custody.validate_accounting(joined.get("accounting"), growth, uncertain=True)
        report.exact(joined,{"completion":completion,"release_ns":joined["release_ns"],"joined_ns":joined["joined_ns"],
            "transaction_joined":True,"cancelled":True,
            "allocated":[2,4096,1],"accounting":joined["accounting"]},"actual create cancellation/uncertainty result changed")
        custody.validate_accounting(producers.get("accounting"), growth, uncertain=True)
        report.exact(producers,{"creation_joined":True,"pressure_stopped":True,"heartbeat_joined":True,
            "provider_joined":True,"peer_joined":True,"snapshot_reverified":True,"allocated":[2,4096,1],
            "accounting":producers["accounting"]},"actual create producers not joined before original saving")
        custody.validate_closed_accounting(closed, growth, "closed actual create P2 uncertainty was discarded")
        result["cases"][case]["create_cancellation"]=events
    result.update(format="native-create-cancellation-report-v2",native_create_cancellation_complete=True,
        checkpoint_models_stalled_storage=False,
        coverage_boundary="direct factory custody and physical rollback; no production memory-policy activation")
    return result


if __name__ == "__main__":
    report.run_cli(validate, __doc__)
