#!/usr/bin/env python3
"""Real-file/CLI refusals for actual read cancellation and physical ownership."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import optional_report_test
import read_cancellation_report as cancellation
import report
import startup_report as startup


class ReadCancellationTests(unittest.TestCase):
    def setUp(self):
        optional_report_test.OptionalReportTests.setUp(self)
        self.events, self.samples = self.events[:12], self.samples[:12]
        for item in self.events+self.samples:
            item["monotonic_ns"] *= 100_000_000
        raw_policy, raw_inputs = json.dumps(self.policy), json.dumps(self.inputs)
        self.collector["metadata"].update(native_read_cancellation_policy_json=raw_policy,
            native_read_cancellation_inputs_json=raw_inputs, native_read_cancellation_snapshot_bytes=startup.BYTES)
        self.witnesses = []
        zero = {"registered_operations": 0, "started": 0, "ordinary_growth_bytes": 0,
                "tracked_tasks": 0, "cleanup_growth_bytes": 0, "uncertain": 0}
        for index, case in enumerate(sorted(cancellation.CASES)):
            terminal = self.events[index*6:index*6+6]
            for item in terminal: item["case"] = case
            base = terminal[1]["monotonic_ns"]
            runner = str(uuid.uuid4())
            def clock(ms): return base+ms*1_000_000
            def read(guarded, joined):
                value = {"accepted": 1, "completed": 0, "cancelled": int(joined), "failed": 0,
                         "read_bytes": cancellation.CHUNK if joined else 0, "last_error": None}
                if guarded: value.update(uncertain=0, deferred=0, finished=joined)
                return value
            def sample(ms):
                return {"started_ns": clock(ms), "finished_ns": clock(ms)+3, "read_start_offset_ns": ms*1_000_000,
                        "available_bytes": 32*1024**3, "age_ns": 2, "read_duration_ns": 1}
            ready = [sample(200),sample(400)]
            values = [{"policy": self.policy, "inputs_sha256": hashlib.sha256(raw_inputs.encode()).hexdigest(),
                "snapshot_sha256": self.artifacts["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
                "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": 1024**2,
                "checkpoint_bytes": cancellation.CHUNK, "startup_pressure_guarded": False,
                "checkpoint_models_stalled_storage": False, "allocated": [2,4096,1]}]
            for guarded in (False,True):
                held, cancelled, first, second, delivered, observed, released, drained = (
                    (490,510,520,530,540,560,610,690) if guarded else (40,60,61,62,70,80,110,120))
                accounting = dict(zero)
                if guarded: accounting.update(registered_operations=1,started=1,ordinary_growth_bytes=startup.BYTES+1024**2,tracked_tasks=1)
                heartbeat = {"receipt": {"received_ns": clock(delivered), "acknowledgement_status": 204,
                    "state": {"runnerId": runner, "snapshotGeneration": 1, "snapshotSequence": 2 if guarded else 1,
                        "group": "native-foreground", "mode": "running", "allocatedVcpu": 2,"allocatedMemoryMb": 4096}},
                    "send_joined": True,"completed_ns": clock(delivered+5)}
                observer = {"started_ns": clock(observed),"completed_ns":clock(observed+5),
                    "available_bytes":32*1024**3,"age_ns":2,"read_duration_ns":1,"joined":True}
                values.extend([
                    {"state":"Ready" if guarded else "Unknown","available_bytes":32*1024**3 if guarded else None,
                     "samples":copy.deepcopy(ready) if guarded else [],"held_ns":clock(held),"checkpoint_bytes":cancellation.CHUNK,
                     "read":read(guarded,False),"accounting":accounting,"allocated":[2,4096,1],"release_byte_withheld":True},
                    {"held_ns":clock(held),"cancelled_ns":clock(cancelled),"first_drain_dropped_ns":clock(first),"second_pending_ns":clock(second),
                     "first_drain_pending":True,"first_drain_dropped":True,"second_drain_pending":True,
                     "release_byte_withheld":True,"checkpoint_bytes":cancellation.CHUNK,"accounting":copy.deepcopy(accounting),
                     "allocated":[2,4096,1],"heartbeat":heartbeat,"observer":observer},
                    {"read":read(guarded,True),"physical_drain_joined":True,"accounting":dict(zero),"allocated":[2,4096,1],
                     "release_ns":clock(released),"joined_ns":clock(drained),"samples":copy.deepcopy(ready)+[sample(620)] if guarded else []},
                ])
            values.append({"startup":read(False,True),"runtime":read(True,True),"startup_drained":True,"runtime_drained":True,
                "pressure_stopped":True,"heartbeat_joined":True,"provider_joined":True,"peer_joined":True,
                "snapshot_reverified":True,"accounting":dict(zero),"allocated":[2,4096,1]})
            for phase,value,ms in zip(cancellation.PHASES,values,(10,50,100,130,500,600,700,800)):
                self.witnesses.append({"version":1,"case":case,"phase":phase,"monotonic_ns":clock(ms),"unix_ns":clock(ms)+1000,
                    "sandbox_id":terminal[1]["sandbox_id"],"backing_generation":terminal[1]["backing_generation"],"evidence":value})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(v) for v in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(e) for e in self.events]
            +[cancellation.PREFIX+json.dumps(e) for e in self.witnesses]))

    def validate(self):
        self.write()
        return cancellation.validate(self.root)

    def refused(self,mutations):
        original=copy.deepcopy(self.witnesses)
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.witnesses=copy.deepcopy(original)
                mutation()
                with self.assertRaises(ValueError): self.validate()

    def test_both_modes_retain_physical_and_production_claim_limits(self):
        value=self.validate()
        self.assertEqual(set(value["cases"]),cancellation.CASES)
        self.assertTrue(value["native_read_cancellation_complete"])
        for key in ("startup_pressure_guarded","checkpoint_models_stalled_storage","memory_envelope_calibrated","production_protection_proven"):
            self.assertFalse(value[key])

    def test_cli_requires_complete_real_files_and_producer_joins(self):
        self.write()
        command=[sys.executable,str(pathlib.Path(__file__).with_name("read_cancellation_report.py")),str(self.root)]
        self.assertEqual(json.loads(subprocess.check_output(command))["format"],"native-read-cancellation-report-v1")
        self.witnesses.pop();self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def test_ready_accepts_distinct_actual_available_values_above_watermark(self):
        for witness in self.witnesses:
            for value in witness["evidence"].get("samples",[]):
                if value["read_start_offset_ns"]==200_000_000:
                    value["available_bytes"]-=1024**2
        self.assertTrue(self.validate()["native_read_cancellation_complete"])

    def test_missing_duplicate_unknown_and_reordered_phases_are_refused(self):
        self.refused((lambda:self.witnesses.pop(2),lambda:self.witnesses.append(copy.deepcopy(self.witnesses[1])),
            lambda:self.witnesses[0].update(case="Startup-fresh"),lambda:self.witnesses[2].update(monotonic_ns=1)))

    def test_original_input_bytes_lease_and_checkpoint_claims_are_required(self):
        self.refused(tuple(lambda k=k,v=v:self.witnesses[0]["evidence"].update({k:v}) for k,v in (
            ("snapshot_bytes",1),("snapshot_sha256","0"*64),("inputs_sha256","0"*64),("allocated",[2,4096,True]),
            ("checkpoint_bytes",0),("startup_pressure_guarded",True),("checkpoint_models_stalled_storage",True))))

    def test_accepted_reads_cannot_be_failed_finished_or_fabricated_bytes(self):
        self.refused(tuple(lambda i=i,k=k,v=v:self.witnesses[i]["evidence"]["read"].update({k:v})
            for i in (1,4) for k,v in (("accepted",True),("completed",1),("cancelled",1),("read_bytes",1),("last_error","failed"))))

    def test_cancelled_reads_require_exact_actual_bytes_and_joined_outcome(self):
        self.refused(tuple(lambda i=i,k=k,v=v:self.witnesses[i]["evidence"]["read"].update({k:v})
            for i in (3,6) for k,v in (("cancelled",0),("completed",1),("failed",1),("read_bytes",0),("read_bytes",startup.BYTES))))
        self.refused((lambda:self.witnesses[6]["evidence"]["read"].update(uncertain=1),lambda:self.witnesses[6]["evidence"]["read"].update(finished=False)))

    def test_both_real_drain_pending_observations_and_dropped_first_are_required(self):
        self.refused(tuple(lambda i=i,k=k:self.witnesses[i]["evidence"].update({k:False}) for i in (2,5)
            for k in ("first_drain_pending","first_drain_dropped","second_drain_pending","release_byte_withheld")))

    def test_waits_keep_original_full_lease_and_guarded_growth(self):
        self.refused((lambda:self.witnesses[5]["evidence"]["accounting"].update(ordinary_growth_bytes=0),
            lambda:self.witnesses[5]["evidence"]["accounting"].update(registered_operations=0),
            lambda:self.witnesses[5]["evidence"]["accounting"].update(tracked_tasks=0),
            lambda:self.witnesses[5]["evidence"]["accounting"].update(tracked_tasks=True),
            lambda:self.witnesses[2]["evidence"].update(allocated=[0,0,0]),
            lambda:self.witnesses[2]["evidence"]["accounting"].update(ordinary_growth_bytes=1)))

    def test_actual_ready_cannot_be_stale_replayed_short_or_unknown(self):
        self.refused((lambda:self.witnesses[4]["evidence"].update(state="Unknown"),
            lambda:self.witnesses[4]["evidence"].update(samples=[]),
            lambda:self.witnesses[4]["evidence"]["samples"][1].update(read_start_offset_ns=200_000_000),
            lambda:self.witnesses[4]["evidence"]["samples"][1].update(read_start_offset_ns=210_000_000),
            lambda:self.witnesses[4]["evidence"]["samples"][0].update(age_ns=2_000_000_000)))

    def test_ready_cannot_bridge_critical_unknown_or_incomplete_recovery(self):
        original=copy.deepcopy(self.witnesses)
        for available in (1, None, self.policy["recovery_available_bytes"]-1):
            with self.subTest(available=available):
                self.witnesses=copy.deepcopy(original)
                for index in (4,6):
                    values=self.witnesses[index]["evidence"]["samples"]
                    interrupted=copy.deepcopy(values[0])
                    for key in ("started_ns","finished_ns","read_start_offset_ns"):
                        interrupted[key]+=100_000_000
                    interrupted["available_bytes"]=available
                    values.insert(1,interrupted)
                with self.assertRaises(ValueError):self.validate()

    def test_ready_offsets_must_share_the_actual_monotonic_read_windows(self):
        original=copy.deepcopy(self.witnesses)
        for shift in (10,-10):
            with self.subTest(shift=shift):
                self.witnesses=copy.deepcopy(original)
                for index in (4,6):
                    values=self.witnesses[index]["evidence"]["samples"]
                    for key in ("started_ns","finished_ns"):
                        values[1][key]=values[0][key]+shift
                with self.assertRaises(ValueError):self.validate()

    def test_concurrent_read_windows_can_overlap_with_ordered_actual_starts(self):
        for index in (4,6):
            values=self.witnesses[index]["evidence"]["samples"]
            values[1]["started_ns"]=values[0]["started_ns"]-10
        self.assertTrue(self.validate()["native_read_cancellation_complete"])

    def test_startup_stays_unguarded_unknown_and_no_fake_source(self):
        self.refused((lambda:self.witnesses[1]["evidence"].update(state="Ready"),
            lambda:self.witnesses[1]["evidence"].update(available_bytes=1),
            lambda:self.witnesses[3]["evidence"].update(samples=copy.deepcopy(self.witnesses[4]["evidence"]["samples"]))))

    def test_real_reporting_must_complete_after_second_pending_and_before_release(self):
        self.refused((lambda:self.witnesses[2]["evidence"]["observer"].update(started_ns=1),
            lambda:self.witnesses[2]["evidence"]["observer"].update(joined=False),
            lambda:self.witnesses[2]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda:self.witnesses[5]["evidence"]["heartbeat"].update(send_joined=False),
            lambda:self.witnesses[5]["evidence"]["heartbeat"]["receipt"]["state"].update(runnerId=str(uuid.uuid4()))))

    def test_drain_clocks_must_be_ordered_and_not_boolean(self):
        self.refused(tuple(lambda i=i,k=k,v=v:self.witnesses[i]["evidence"].update({k:v}) for i in (2,5)
            for k,v in (("cancelled_ns",True),("first_drain_dropped_ns",1),("second_pending_ns",1),("held_ns",1))))

    def test_guarded_join_requires_new_post_release_actual_settlement(self):
        self.refused((lambda:self.witnesses[6]["evidence"]["samples"].pop(),
            lambda:self.witnesses[6]["evidence"]["samples"][0].update(available_bytes=1),
            lambda:self.witnesses[6]["evidence"].update(release_ns=1),
            lambda:self.witnesses[6]["evidence"].update(joined_ns=1),
            lambda:self.witnesses[6]["evidence"].update(physical_drain_joined=False),
            lambda:self.witnesses[6]["evidence"]["accounting"].update(ordinary_growth_bytes=1)))

    def test_all_producers_and_immutable_inputs_join_before_original_saving(self):
        self.refused(tuple(lambda k=k:self.witnesses[7]["evidence"].update({k:False}) for k in (
            "startup_drained","runtime_drained","pressure_stopped","heartbeat_joined","provider_joined","peer_joined","snapshot_reverified")))

    def test_inherited_physical_tail_and_backing_proof_is_still_required(self):
        self.events[3]["evidence"]["full_logical_lease"]=[0,0,0]
        with self.assertRaises(ValueError):self.validate()


if __name__=="__main__":
    unittest.main()
