#!/usr/bin/env python3
"""Shared strict original custody; each operation supplies its own wire contract."""
from dataclasses import dataclass
import hashlib
import json
import pathlib
import re
import struct
import subprocess
from typing import Callable

import batch_aba_report as batch
import claim_producer_report as retained
import cleanup_report as cleanup
import foreground_report as foreground
import later_parking_report as later
import pressure_report as pressure
import report
from startup_report import exact


@dataclass(frozen=True)
class Contract:
    name: str
    wire: Callable[..., int]

    def field(self, restore, final_exec, quiesce):
        return {"FixedRestore": restore, "FinalExec": final_exec, "Quiesce": quiesce}[self.name]

    @property
    def key(self):
        return self.field("fixed_restore", "final_exec", "quiesce")

    @property
    def prefix(self):
        return "NATIVE_" + self.key.upper() + "_WITNESS "

    @property
    def cases(self):
        return {f"{self.name}-{boundary}-{fault}-{mode}" for boundary in ("capture", "terminal")
                for fault in ("drop", "observer-unwind", "producer-unwind") for mode in ("fresh", "snapshot")}


PHASES = ("original_session", "original_data_durable", "request_captured", "observation_waiting",
          "observation_lost", "late_wait_progress", "actual_terminal_drained", "required_cleanup_refused",
          "original_owners_retained")
LEASE = {"original_full_lease_active": True, "allocated": [2, 4096, 1]}


def blob(value, maximum):
    if not isinstance(value, str) or len(value) > maximum*2 or not re.fullmatch(r"(?:[0-9a-f]{2})*", value):
        raise ValueError("original bytes are missing, oversized or noncanonical")
    return bytes.fromhex(value)


def original_frame(value, kind, sequence=None, maximum=65536+64):
    if not isinstance(value, dict):
        raise ValueError("original fixed frame missing")
    raw = blob(value.get("raw_hex"), maximum)
    if (len(raw) < 9 or int.from_bytes(raw[:4], "big") != len(raw)-4 or raw[4] != kind
            or not (seq := int.from_bytes(raw[5:9], "big")) or sequence not in (None, seq)):
        raise ValueError("fixed original framing/type/sequence changed")
    exact(value, {"message_type": kind, "sequence": seq, "raw_hex": raw.hex(),
                  "sha256": hashlib.sha256(raw).hexdigest()}, "fixed frame hash or fields changed")
    return seq, raw[9:]


def fixed_wire(value, kind, sequence=None, unix_window=None, history=None):
    seq, data = original_frame(value, kind, sequence)
    if kind == 0x1a:
        if len(data) != 278:
            raise ValueError("fixed request shape changed")
        timeout, seconds, nanos, timezone, size = struct.unpack(">IQIBH", data[:19])
        if timeout != 300000 or seconds > 2**63-1 or nanos >= 10**9 or timezone != 2 or size != 3 or data[19:22] != b"UTC":
            raise ValueError("actual production fixed helper inputs changed")
        if unix_window is not None and not unix_window[0] <= seconds*10**9+nanos <= unix_window[1]:
            raise ValueError("fixed restore clock input is outside its original Host phase")
    else:
        # Exited(0), duration, empty captured stdout, captured bounded stderr,
        # empty diagnostic. Decode original bytes, not the receipt's success flag.
        if len(data) < 23 or data[:5] != bytes(5) or data[9:15] != b"\x01\0\0\0\0\0" or data[15:17] != b"\x01\0":
            raise ValueError("actual fixed helper result was not successful captured output")
        size = int.from_bytes(data[17:21], "big")
        if size > 65536 or len(data) != 23+size or data[-2:] != bytes(2):
            raise ValueError("fixed stderr/diagnostic shape changed")
    return seq


def validate(directory, contract):
    wire = contract.wire
    PREFIX, CASES = contract.prefix, contract.cases
    request_kind = contract.field(0x1a, 0x0b, 0x05)
    result_kind = contract.field(0x1b, 0x0e, 0x06)
    running = contract.field("running_helper_observed", "running_exec_observed", "preterminal_quiesce_observed")
    directory = pathlib.Path(directory)
    collector = json.loads(retained.regular(directory/"report.json", 1024**2), object_pairs_hook=pressure.unique_object)
    if (collector.get("format") != "runner-memory-calibration-v2" or collector.get("success") is not False
            or type(collector.get("driver_exit_code")) is not int or collector["driver_exit_code"] != 101
            or collector.get("driver_wait_confirmed") is not True or collector.get("cleanup_confirmed") is not True
            or type(collector.get("cleanup_intervened")) is not bool or collector.get("remaining_children") != []
            or collector.get("errors") != [] or any(collector.get(key) is not False for key in
               ("timed_out", "headroom_stop", "logs_truncated", "calibrated", "native_vm_exit_confirmed"))):
        raise ValueError("original failed driver/collector outcome changed")
    stdout = retained.regular(directory/"stdout.log", 16*1024**2).decode()
    stderr = retained.regular(directory/"stderr.log", 16*1024**2).decode()
    if "test result: FAILED" not in stdout or f"Error: {contract.name}Uncertain" not in stderr:
        raise ValueError("original fixed uncertainty failure missing")
    artifacts, samples = report._load_measurement_inputs(directory, collector)
    policy = cleanup.supplied_policy(collector, {"artifacts": artifacts}, "native_" + contract.key + "_policy_json")
    events, terminals, continuation = [], [], []
    for line in stdout.splitlines():
        for prefix, target in ((PREFIX, events), (report.PREFIX, terminals),
                               ("NATIVE_CONTINUATION_WITNESS ", continuation)):
            if line.startswith(prefix):
                target.append(json.loads(line[len(prefix):], object_pairs_hook=pressure.unique_object))
    if (tuple(e.get("phase") for e in events) != PHASES or len(terminals) != 2
            or tuple(e.get("phase") for e in terminals) != ("case_started", "terminal_started")
            or len(continuation) != 1 or continuation[0].get("phase") != "original_executor_completed"):
        raise ValueError("fixed original phases missing, duplicated, reordered or credited as cleanup")
    case = terminals[0]["case"]
    if case not in CASES:
        raise ValueError("unexpected fixed restore case")
    identity = tuple(later.identifier(terminals[1][key]) for key in ("sandbox_id", "backing_generation"))
    if identity[0] == identity[1]:
        raise ValueError("fixed backing identity collapsed")
    ordered = [terminals[0], continuation[0], *events[:2], terminals[1], *events[2:]]
    fields = {"version", "case", "phase", "monotonic_ns", "unix_ns", "sandbox_id", "backing_generation", "evidence"}
    for event in ordered:
        if (not isinstance(event, dict) or set(event) != fields or type(event["version"]) is not int
                or event["version"] != 1 or event["case"] != case or not isinstance(event["evidence"], dict)
                or not report.positive_integer(event["monotonic_ns"]) or not report.positive_integer(event["unix_ns"])):
            raise ValueError("malformed fixed original event")
    if (any(tuple(e[k] for k in ("sandbox_id", "backing_generation")) != identity for e in ordered[1:])
            or any(a["monotonic_ns"] >= b["monotonic_ns"] or a["unix_ns"] >= b["unix_ns"] for a,b in zip(ordered,ordered[1:]))):
        raise ValueError("fixed original identity or clocks changed")
    exact(terminals[0]["evidence"], {"artifacts": artifacts}, "fixed source/artifact binding changed")
    exact(terminals[1]["evidence"], {}, "fixed terminal start changed")
    session, durable, captured, waiting, lost, progress, joined, refused, owners = [e["evidence"] for e in events]
    history, thread = (later.identifier(session.get(k)) for k in ("history_run_id", "thread_id"))
    original = blob(session.get("history_hex"), 4*1024**2)
    if not original or history in identity or thread in {*identity,history}:
        raise ValueError("complete original native session identity/bytes absent")
    physical = session.get("physical_history", {})
    raw_history = blob(physical.get("raw_hex"), 4*1024**2)
    path = physical.get("path")
    if (not raw_history or not isinstance(path,str) or not re.fullmatch(
            r"/home/user/\.codex/sessions/2026/06/04/rollout-[0-9T:-]+-"+re.escape(thread)+r"\.jsonl(?:\.zst)?", path)):
        raise ValueError("original physical history file binding missing")
    exact(physical, {"path":path,"bytes":len(raw_history),"sha256":hashlib.sha256(raw_history).hexdigest(),
                     "raw_hex":raw_history.hex()}, "original physical history changed")
    exact(session, {"history_run_id":history,"thread_id":thread,"history_hex":original.hex(),
                    "history_sha256":hashlib.sha256(original).hexdigest(),"history_bytes":len(original),
                    "physical_history":physical,"final_identity_verified":True,"executor_completed":True,"exit_code":0},
          "fixed restore did not retain complete real Executor history")
    previous = continuation[0]["evidence"]
    for key,value in {"original_run_id":history,"thread_id":thread,"original_history_sha256":session["history_sha256"],
                      "original_history_bytes":len(original),"exit_code":0,"final_identity_verified":True,
                      "full_original_prefix_verified":True,"preparation_observed_by_native_process":True,
                      "original_full_lease_witness":True}.items():
        exact(previous.get(key),value,"original native Executor evidence disagrees")
    payload = (history.encode()*2048)[:65536]
    exact(durable, {"history_run_id":history,"payload_sha256":hashlib.sha256(payload).hexdigest(),"payload_bytes":65536,
                    "original_private_and_home_verified":True,"guest_sync_completed":True}, "required data was not durable before fixed loss")
    operation = later.identifier(captured.get("operation_run_id"))
    if operation in {*identity,history,thread}:
        raise ValueError("fixed operation identity reused")
    started = batch.clock(captured.get("prepare_started_ns"),terminals[1]["monotonic_ns"],events[2]["monotonic_ns"])
    sequence = wire(captured.get("request"),request_kind,
                    unix_window=(terminals[1]["unix_ns"],events[2]["unix_ns"]), history=history)
    exact(captured, {"history_run_id":history,"operation_run_id":operation,"prepare_started_ns":started,
                     "request":captured["request"],"backend_dispatched":False,
                     contract.field("canonical_fixed_helper", "canonical_final_exec", "canonical_quiesce"):True}|LEASE,
          "fixed request capture changed")
    terminal = case.startswith(contract.name+"-terminal-")
    unwound = "-producer-unwind-" in case
    if terminal:
        wire(waiting.get("response"),result_kind,sequence)
    elif waiting.get("response") is not None:
        raise ValueError("capture was misrepresented as Guest acceptance")
    exact(waiting, {"boundary":"terminal" if terminal else "capture","request":captured["request"],
                    "response":waiting["response"],contract.field("public_restore_polled_pending", "public_repark_polled_pending", "public_repark_polled_pending"):True,
                    running:False}|LEASE,
          "fixed waiting boundary or custody changed")
    lost_ns = batch.clock(lost.get("lost_ns"),events[3]["monotonic_ns"],events[4]["monotonic_ns"])
    exact(lost, {"lost_ns":lost_ns,"observer_unwound":"-observer-unwind-" in case,"state":"Uncertain",
                 "commit_refused":True,"repark_refused":True,"incoming_refused":True,"original_metadata_preserved":True,
                 "pool_empty":True,"original_exit_polled_pending":True}|LEASE,"fixed cancellation reopened original reuse")
    held = batch.clock(progress.get("pool_held_ns"),events[4]["monotonic_ns"],events[5]["monotonic_ns"])
    status_held = batch.clock(progress.get("status_held_ns"),held,events[5]["monotonic_ns"])
    status_wait = batch.clock(progress.get("status_wait_polled_ns"),status_held,events[5]["monotonic_ns"])
    waits_before,waits_after = (progress.get(key) for key in ("status_waits_before","status_waits_after"))
    if not pressure.integer(waits_before) or type(waits_after) is not int or waits_after != waits_before+1:
        raise ValueError("actual fixed status publication wait missing")
    pending = batch.clock(progress.get("heartbeat_pending_ns"),status_wait,events[5]["monotonic_ns"])
    foreground.observer(progress.get("observer"),pending,events[5]["monotonic_ns"])
    released = batch.clock(progress.get("pool_released_ns"),progress["observer"]["completed_ns"],events[5]["monotonic_ns"])
    runner,generation = foreground.heartbeat(progress.get("heartbeat"),1,released,events[5]["monotonic_ns"],(2,4096))
    status_released = batch.clock(progress.get("status_released_ns"),progress["heartbeat"]["completed_ns"],events[5]["monotonic_ns"])
    status_published = batch.clock(progress.get("status_published_ns"),status_released,events[5]["monotonic_ns"])
    after = batch.clock(progress.get("sample_after_ns"),status_published,events[5]["monotonic_ns"])
    sample = batch.clock(progress.get("p1_sample_ns"),after,events[5]["monotonic_ns"])
    if runner in {*identity,history,thread,operation} or generation != 1 or not any(s["monotonic_ns"]==sample for s in samples):
        raise ValueError("fixed independent heartbeat or original P1 acknowledgement missing")
    exact(progress, {"pool_held_ns":held,"status_held_ns":status_held,"heartbeat_pending_ns":pending,
                     "observer":progress["observer"],"pool_released_ns":released,"heartbeat":progress["heartbeat"],
                     "status_released_ns":status_released,"sample_after_ns":after,"p1_sample_ns":sample,
                     "status_wait_polled_ns":status_wait,"status_waits_before":waits_before,
                     "status_waits_after":waits_after,"status_published_ns":status_published,
                     "selected_delivery_withheld":True,"additional_full_profile_refused":True}|LEASE,"late fixed work lost custody")
    wire(joined.get("response"),result_kind,sequence)
    if terminal:
        exact(joined["response"],waiting["response"],"fixed late terminal was substituted")
    delivered = batch.clock(joined.get("delivery_requested_ns"),events[5]["monotonic_ns"],events[6]["monotonic_ns"])
    finished = batch.clock(joined.get("joined_ns"),delivered,events[6]["monotonic_ns"])
    exact(joined, {"request":captured["request"],"response":joined["response"],"delivery_requested_ns":delivered,"joined_ns":finished,
                   contract.field("canonical_helper_exited_zero", "canonical_final_exec_exited_zero", "canonical_quiesce_acknowledged"):True,
                   contract.field("helper_stdin_stderr_joined", "exec_stdin_stdout_stderr_joined", "guest_dispatcher_completed"):True,"exchange_joined":not unwound,
                   "transport_producer_unwound":unwound,"connection_retained_pending":not unwound,
                   running:False,"ordinary_reuse_reopened":False}|LEASE,"fixed late-result joins or evidence limits changed")
    home = refused.get("original_home",{})
    expected_path = pathlib.PurePosixPath(home.get("path", ""))
    if (not expected_path.is_absolute() or ".." in expected_path.parts or expected_path.parts[-3:] != ("workspaces",identity[0],"home.ext4")
            or str(expected_path) != home["path"] or not re.fullmatch(r"[0-9a-f]{32}",home.get("filesystem_uuid", ""))
            or not re.fullmatch(r"[0-9a-f]{64}",home.get("superblock_sha256", ""))):
        raise ValueError("fixed original home identity missing")
    exact(home, {"path":str(expected_path),"bytes":16384*1024**2,"filesystem_uuid":home["filesystem_uuid"],
                 "superblock_sha256":home["superblock_sha256"]},"fixed home profile changed")
    error = refused.get("error")
    expected_error = contract.field("normal operations are not available on this connection",
        "normal operations are not available on this connection",
        "park policy dirty while unpark is a no-op: park attempt dropped after guest quiesce started")
    if not isinstance(error,str) or len(error)>4096 or expected_error not in error:
        raise ValueError("actual operation-specific required-cleanup refusal missing")
    exact(refused, {"error":error,contract.field("normal_operations_not_parkable", "normal_operations_not_parkable", "park_policy_dirty"):True,"completed_lease_refused":True,
                    "required_saving_complete":False,"cleanup_complete":False,"original_home":home}|LEASE,
          "fixed refused saving was credited as complete")
    attempt,attempt_sandbox = (later.identifier(owners.get(key)) for key in ("promotion_probe_run_id","promotion_probe_sandbox_id"))
    if len({*identity,history,thread,operation,runner,attempt,attempt_sandbox}) != 8:
        raise ValueError("fixed original promotion probe reused identity")
    accounting = dict.fromkeys(cleanup.COUNTS,0)|{"registered_operations":2,"uncertain":2,
        "cleanup_growth_bytes":policy["live_growth_bytes"]+policy["tail_growth_bytes"],"closed":True}
    exact(owners, {"original_home":home,"promotion_lock_busy":True,"promotion_probe_run_id":attempt,
        "promotion_probe_sandbox_id":attempt_sandbox,"original_capsule_retained":True,"original_session_history_retained":True,
        "original_backing_retained":True,"original_exit_polled_pending":True,"tracker_joined":True,
        "heartbeat_provider_peer_joined":True,"accounting":accounting,"required_saving_complete":False,"cleanup_complete":False,
        "physical_relief_proven":False,"memory_credit":False,
        contract.field("running_helper_boundary", "running_exec_boundary", "native_busy_resume_boundary"):"blocked",
        "preterminal_acceptance_boundary":"blocked",
        "original_cleanup_io_progress":contract.field("blocked_not_parkable", "blocked_not_parkable", "blocked_dirty")}|LEASE,
        "fixed unresolved owners/growth were released or acceptance fabricated")
    image = directory/"retained-home.ext4"
    # fstat and the full superblock bind the original regular retained image.
    import os
    import stat
    fd = os.open(image,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,"rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or os.fstat(stream.fileno()).st_size != home["bytes"]:
            raise ValueError("fixed retained original image is not complete")
        stream.seek(1024); block=stream.read(1024)
        if block[56:58]!=b"\x53\xef" or block[104:120].hex()!=home["filesystem_uuid"] or hashlib.sha256(block).hexdigest()!=home["superblock_sha256"]:
            raise ValueError("fixed original home superblock changed")
        # Retain the checked inode through every real reader, even if its path
        # is renamed or replaced while the consumer runs.
        for name,expected in (("/guarded-idle-payload",payload),("/guarded-idle-ordinary",b"native ordinary home bytes"),
                (f"/.vm0/guest-agent/runs/{history}/fixture-private",b"fixture private bytes"),
                (path.removeprefix("/home/user"),raw_history)):
            result=subprocess.run(["/usr/sbin/debugfs","-R","cat "+name,f"/proc/self/fd/{stream.fileno()}"],
                                  capture_output=True,timeout=30,pass_fds=(stream.fileno(),))
            if result.returncode or result.stdout!=expected:
                raise ValueError("fixed complete original home/private/session/history bytes lost")
    return {"format":"native-"+contract.key.replace("_","-")+"-custody-v1","case":case,"artifacts":artifacts,
        "native_"+contract.key+"_retained_custody_observed":True,"original_driver_exit_code":101,
        "original_collector_success":False,"collector_cleanup_intervened":collector["cleanup_intervened"],
        "original_complete_data_verified":True,"required_saving_complete":False,"cleanup_complete":False,
        "physical_relief_proven":False,"memory_credit":False,running:False,
        "blocked_boundaries":["preterminal_acceptance",contract.field("running_helper","running_exec","native_busy_or_resume"),"original_cleanup_io_progress"],
        "native_wait":report.window(samples,events[2]["monotonic_ns"],events[6]["monotonic_ns"])}
