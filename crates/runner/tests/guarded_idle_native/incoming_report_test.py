#!/usr/bin/env python3
"""Real-file/CLI regressions for incoming, original and aged physical custody."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import foreground_report_test
import incoming_report as incoming
import report


class IncomingReportTests(unittest.TestCase):
    def setUp(self):
        foreground_report_test.ForegroundReportTests.setUp(self)
        terminal, samples = copy.deepcopy(self.events[:6]), copy.deepcopy(self.samples[:6])
        base = [copy.deepcopy(e["evidence"]) for e in self.witnesses[:6]]
        metadata = self.collector["metadata"]
        for field in ("policy_json", "inputs_json", "snapshot_bytes"):
            metadata["native_incoming_"+field] = metadata["native_foreground_"+field]
        self.events, self.samples, self.witnesses = [], [], []
        for offset, case in enumerate(sorted(incoming.CASES)):
            kind = case.split("-")[0].removeprefix("Incoming")
            aged, restored = kind == "Aged", kind == "Restore"
            events, observations = copy.deepcopy(terminal), copy.deepcopy(samples)
            shift = offset*10_000_000_000
            original, backing, new, new_backing, operation, runner = [str(uuid.uuid4()) for _ in range(6)]
            for event in events:
                event.update(case=case, sandbox_id=original, backing_generation=backing,
                    monotonic_ns=event["monotonic_ns"]+shift, unix_ns=event["unix_ns"]+shift)
            for sample in observations:
                sample["monotonic_ns"] += shift
                for process in sample["processes"]:
                    process["observed_monotonic_ns"] = sample["monotonic_ns"]
            self.events.extend(events); self.samples.extend(observations)
            start, tail, tail_done = [events[n]["monotonic_ns"] for n in (1,3,4)]
            allocated = [2,4096,1] if aged else [4,8192,2]
            blocked_allocated = [4,8192,2] if kind == "Replacement" else [2,4096,1]
            def observer(begin):
                return {"started_ns": begin+10_000_000, "completed_ns": begin+20_000_000,
                    "available_bytes": 32*1024**3, "age_ns": 2, "read_duration_ns": 1, "joined": True}
            def heartbeat(sequence, begin, resources):
                return {"receipt": {"received_ns": begin+10_000_000, "acknowledgement_status": 204,
                    "state": {"runnerId": runner, "snapshotGeneration": 1, "snapshotSequence": sequence,
                        "group": "native-foreground", "mode": "running", "allocatedVcpu": resources[0],
                        "allocatedMemoryMb": resources[1]}}, "send_joined": True, "completed_ns": begin+20_000_000}
            grant = {"started_ns": start+20_000_000, "finished_ns": start+30_000_000,
                "operation_id": operation, "samples": [{"started_ns": start+22_000_000,
                    "finished_ns": start+22_000_003, "read_start_offset_ns": 1,
                    "available_bytes": 32*1024**3, "age_ns": 2, "read_duration_ns": 1}]}
            initial = copy.deepcopy(base[0])
            initial.update(kind=kind, physical_credit_from_logical_transfer=False)
            pool = {key: copy.deepcopy(base[1][key]) for key in ("startup", "startup_drained", "reads", "state")}
            pool.update(pool_held_ns=start+60_000_000, status_held_ns=start+70_000_000,
                pool_wait_polled_ns=start+80_000_000, pool_wait_polled_pending=True,
                observer=observer(start+80_000_000), allocated=allocated)
            status = {"state": "Ready", "available_bytes": 32*1024**3, "reads": copy.deepcopy(base[2]["reads"]),
                "runtime_drained": True, "runtime_completed_ns": start+380_000_000,
                "pool_released_ns": start+400_000_000, "status_held_ns": start+70_000_000,
                "status_wait_polled_ns": start+410_000_000, "status_waits_before": 0, "status_waits_after": 1,
                "actual_idle_snapshot_wait": True, "inventory_matches_original_incoming": True,
                "original_owner_restored": restored, "status_publication": "aged_internal" if aged else "after_insertion",
                "heartbeat": heartbeat(1,start+420_000_000,allocated), "observer": observer(start+450_000_000),
                "allocated": allocated, "samples": [{"started_ns": start+delta, "finished_ns": start+delta+3,
                    "read_start_offset_ns": delta, "available_bytes": 32*1024**3, "age_ns": 2, "read_duration_ns": 1}
                    for delta in (120_000_000,240_000_000,360_000_000)]}
            blocked = {"join_polled_ns": start+600_000_000,
                "join_kind": "blank_preparation" if aged else "original_cleanup", "join_polled_pending": True,
                "kernel_io_entered": True, "release_byte_withheld": True, "full_original_lease": [2,4096,1],
                "allocated": blocked_allocated, "heartbeat": heartbeat(2,tail+10_000_000,blocked_allocated),
                "observer": observer(tail+40_000_000)}
            creation = tail_done+20_000_000 if aged else start+40_000_000
            prepared = {"sandbox_id": new, "backing_generation": new_backing, "operation_id": operation,
                "prepared_ns": tail_done+30_000_000 if aged else start+50_000_000, "phase_settled": True}
            if aged:
                prepared.update(retired_exact=True, original_lease_reused=True)
            else:
                prepared.update(grant_started_ns=grant["started_ns"], grant_finished_ns=grant["finished_ns"],
                    guest_rpc_completed=True, separate_incoming_lease=True)
            finished = {"kind": kind, "preparation": prepared, "fresh_grant": grant,
                "incoming_sandbox_id": original if restored else new,
                "incoming_backing_generation": backing if restored else new_backing,
                "new_backing_generation": new_backing, "new_backing_exit_confirmed": True,
                "original_exit_confirmed": True, "original_owner_restored": restored,
                "separate_incoming_lease": not aged, "original_full_lease_retained": True, "allocated": [2,4096,1]}
            joined = copy.deepcopy(base[5]); joined.pop("foreground_joined")
            joined.update(incoming_work_joined=True, original_full_lease_retained=True,
                allocated=[2,4096,1], inventory_empty=True)
            values = {"inputs_verified": (initial,start+10_000_000), "guest_creation_started": ({"sandbox_id":new},creation),
                "pool_wait_progress": (pool,start+110_000_000), "status_wait_progress": (status,start+500_000_000),
                "physical_io_wait_progress": (blocked,tail+100_000_000),
                "incoming_completed": (finished,tail_done+100_000_000), "producers_joined": (joined,tail_done+200_000_000)}
            for phase in incoming.phases(kind):
                value, clock = values[phase]
                self.witnesses.append({"version": 1, "case": case, "phase": phase, "monotonic_ns": clock,
                    "unix_ns": clock+1000, "sandbox_id": original, "backing_generation": backing, "evidence": value})

    def event(self, kind, phase):
        return next(e for e in self.witnesses if e["case"] == f"Incoming{kind}-fresh" and e["phase"] == phase)

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(sample) for sample in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            + [incoming.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return incoming.validate(self.root)

    def refused(self, changes):
        original = copy.deepcopy(self.witnesses)
        for change in changes:
            self.witnesses = copy.deepcopy(original)
            change()
            with self.assertRaises(ValueError): self.validate()

    def test_six_complete_modes_keep_production_claim_limits(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), incoming.CASES)
        self.assertTrue(value["native_incoming_progress_complete"])
        for field in ("startup_pressure_guarded", "memory_envelope_calibrated", "production_protection_proven"):
            self.assertFalse(value[field])

    def test_real_cli_requires_complete_actual_files(self):
        self.write()
        command = [sys.executable,str(pathlib.Path(__file__).with_name("incoming_report.py")),str(self.root)]
        self.assertTrue(json.loads(subprocess.check_output(command))["native_incoming_progress_complete"])
        self.witnesses.pop(); self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def test_missing_duplicate_and_wrong_original_generations_are_refused(self):
        self.refused((lambda:self.witnesses.pop(),lambda:self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda:self.witnesses[1].update(backing_generation=str(uuid.uuid4())),
            lambda:self.witnesses[0].update(version=True)))

    def test_original_snapshot_and_logical_credit_cannot_be_fabricated(self):
        self.refused(tuple(lambda key=key,value=value:self.witnesses[0]["evidence"].update({key:value})
            for key,value in (("snapshot_bytes",1),("snapshot_sha256","0"*64),
                ("inputs_sha256",hashlib.sha256(b"changed").hexdigest()),("physical_credit_from_logical_transfer",True))))

    def test_complete_startup_unknown_and_runtime_reads_are_required(self):
        self.refused((lambda:self.event("Replacement","pool_wait_progress")["evidence"]["startup"].update(read_bytes=1),
            lambda:self.event("Restore","pool_wait_progress")["evidence"]["reads"].update(accepted=1),
            lambda:self.event("Aged","status_wait_progress")["evidence"]["reads"].update(cancelled=1),
            lambda:self.event("Aged","producers_joined")["evidence"]["reads"].update(finished=False)))

    def test_specific_pending_pool_status_and_runtime_before_release_are_required(self):
        self.refused((lambda:self.event("Replacement","pool_wait_progress")["evidence"].update(pool_wait_polled_pending=False),
            lambda:self.event("Restore","status_wait_progress")["evidence"].update(status_waits_after=2),
            lambda:self.event("Aged","status_wait_progress")["evidence"].update(actual_idle_snapshot_wait=False),
            lambda:self.event("Replacement","status_wait_progress")["evidence"].update(runtime_completed_ns=
                self.event("Replacement","status_wait_progress")["evidence"]["pool_released_ns"])))

    def test_actual_sustained_fresh_ready_observations_are_required(self):
        self.refused((lambda:self.event("Aged","status_wait_progress")["evidence"].update(samples=[]),
            lambda:self.event("Restore","status_wait_progress")["evidence"]["samples"][0].update(age_ns=10**10),
            lambda:self.event("Replacement","status_wait_progress")["evidence"].update(available_bytes=1)))

    def test_separate_incoming_and_original_full_leases_are_required(self):
        self.refused((lambda:self.event("Replacement","pool_wait_progress")["evidence"].update(allocated=[2,4096,1]),
            lambda:self.event("Restore","status_wait_progress")["evidence"].update(allocated=[4,8192,True]),
            lambda:self.event("Replacement","physical_io_wait_progress")["evidence"].update(full_original_lease=[0,0,0]),
            lambda:self.event("Aged","incoming_completed")["evidence"]["preparation"].update(original_lease_reused=False)))

    def test_fresh_authority_actual_phase_and_guest_rpc_are_required(self):
        self.refused((lambda:self.event("Replacement","incoming_completed")["evidence"]["fresh_grant"].update(samples=[]),
            lambda:self.event("Aged","incoming_completed")["evidence"]["preparation"].update(operation_id=str(uuid.uuid4())),
            lambda:self.event("Restore","incoming_completed")["evidence"]["preparation"].update(guest_rpc_completed=False),
            lambda:self.event("Replacement","incoming_completed")["evidence"]["preparation"].update(phase_settled=False)))

    def test_restoration_must_return_the_same_original_owner(self):
        self.refused((lambda:self.event("Restore","incoming_completed")["evidence"].update(incoming_sandbox_id=str(uuid.uuid4())),
            lambda:self.event("Restore","incoming_completed")["evidence"].update(incoming_backing_generation=str(uuid.uuid4())),
            lambda:self.event("Restore","status_wait_progress")["evidence"].update(original_owner_restored=False)))

    def test_aged_actual_creation_must_follow_original_durable_tail(self):
        original_tail = next(e for e in self.events if e["case"] == "IncomingAged-fresh" and e["phase"] == "required_tail_completed")
        self.refused((lambda:self.event("Aged","guest_creation_started").update(monotonic_ns=original_tail["monotonic_ns"]-1),
            lambda:self.event("Aged","incoming_completed")["evidence"]["preparation"].update(retired_exact=False),
            lambda:self.event("Aged","guest_creation_started")["evidence"].update(sandbox_id=str(uuid.uuid4()))))

    def test_new_and_original_backing_positive_exit_are_both_required(self):
        self.refused((lambda:self.event("Replacement","incoming_completed")["evidence"].update(new_backing_exit_confirmed=False),
            lambda:self.event("Restore","incoming_completed")["evidence"].update(original_exit_confirmed=False),
            lambda:self.event("Aged","incoming_completed")["evidence"]["preparation"].update(backing_generation=
                self.event("Aged","incoming_completed")["backing_generation"])))

    def test_blocked_io_needs_independent_acknowledged_progress(self):
        self.refused((lambda:self.event("Replacement","physical_io_wait_progress")["evidence"].update(release_byte_withheld=False),
            lambda:self.event("Restore","physical_io_wait_progress")["evidence"].update(join_polled_pending=False),
            lambda:self.event("Aged","physical_io_wait_progress")["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda:self.event("Replacement","status_wait_progress")["evidence"]["observer"].update(joined=False)))

    def test_all_accepted_producers_and_final_full_lease_must_join(self):
        self.refused(tuple(lambda key=key:self.event("Aged","producers_joined")["evidence"].update({key:None}) for key in (
            "incoming_work_joined","heartbeat_joined","provider_joined","peer_joined","registered_operations",
            "tracked_tasks","snapshot_reverified","original_full_lease_retained","inventory_empty")))

    def test_inherited_original_physical_proof_cannot_be_replaced_by_progress(self):
        self.events[4]["evidence"]["written_and_verified_bytes"] = 1
        with self.assertRaises(ValueError): self.validate()


if __name__ == "__main__":
    unittest.main()
