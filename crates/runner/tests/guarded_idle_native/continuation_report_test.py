#!/usr/bin/env python3
"""Real-file/CLI regressions for complete native continuation evidence."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import continuation_report as continuation
import report
import report_test


class ContinuationReportTests(unittest.TestCase):
    def setUp(self):
        report_test.NativeReportTests.setUp(self)
        self.events = self.events[:60]
        self.samples = self.samples[:60]
        gib = 1024**3
        policy = {
            "host_total_bytes":64*gib,"operating_floor_bytes":gib,"cleanup_reserve_bytes":256*1024**2,
            "critical_available_bytes":12*gib,"recovery_available_bytes":20*gib,
            "live_growth_bytes":4*1024**2,"tail_growth_bytes":65*1024**2,
            "replacement_preparation_bytes":32*1024**2,"max_sample_age_millis":1000,
            "max_operations":8,"max_cleanup_inflight":2,"pressure_sample_period_millis":50,
            "pressure_recovery_sustain_millis":100,"pressure_wave_cooldown_millis":100,
            "pressure_optional_start_interval_millis":100,"pressure_max_wave_entries":1,
        }
        raw = json.dumps(policy)
        self.artifacts["policy_sha256"] = hashlib.sha256(raw.encode()).hexdigest()
        self.collector["metadata"]["native_continuation_policy_json"] = raw
        self.witnesses = []
        for offset, case in enumerate(sorted(continuation.CASES)):
            events = self.events[offset*6:offset*6+6]
            for event in events: event["case"] = case
            run, next_run = str(uuid.uuid4()), str(uuid.uuid4())
            home_hash = hashlib.sha256((run.encode()*2048)[:65536]).hexdigest()
            base = {"thread_id":str(uuid.uuid4()),"original_home_sha256":home_hash,
                    "original_home_bytes":65536,"final_identity_verified":True,
                    "full_original_prefix_verified":True,"preparation_observed_by_native_process":True}
            original = {**base,"original_run_id":run,"seed_history_sha256":continuation.SEED_HASH,
                        "seed_history_bytes":len(continuation.SEED),"original_history_sha256":"3"*64,
                        "original_history_bytes":len(continuation.SEED)+256,
                        "exit_code":1 if case.startswith("ContinuationNonzero-") else 0,
                        "final_identity_verified":not case.startswith("ContinuationNonzero-"),
                        "reusable_identity_withheld_after_nonzero":case.startswith("ContinuationNonzero-"),
                        "original_full_lease_witness":True}
            condition = {"policy":policy,"available_bytes":32*gib,"age_ns":2,"read_duration_ns":1,
                         "allocated":[2,4096,1],"profile_can_fit":case.startswith(("ContinuationReplacement-","ContinuationRestore-","ContinuationAged-"))}
            continued = {**base,"continued_run_id":next_run,"continued_sandbox_id":str(uuid.uuid4()),
                         "restored_history_sha256":"3"*64,"restored_history_bytes":len(continuation.SEED)+256,
                         "continued_history_sha256":"4"*64,"continued_history_bytes":len(continuation.SEED)+512,
                         "exit_code":0,"home_cache_hit":True,"history_proof_bound":True}
            saved = {"required_cleanup_joined":True,"complete_continued_bytes_restored":True,
                     "verified_final_identity_preserved":True}
            clocks = (events[0]["monotonic_ns"]+3,events[0]["monotonic_ns"]+6,
                      events[-2]["monotonic_ns"]+3,events[-2]["monotonic_ns"]+6)
            for phase, proof, clock in zip(continuation.PHASES,(original,condition,continued,saved),clocks):
                self.witnesses.append({"version":1,"case":case,"phase":phase,
                                      "monotonic_ns":clock,"unix_ns":clock+1000,
                                      "sandbox_id":events[1]["sandbox_id"],
                                      "backing_generation":events[1]["backing_generation"],"evidence":proof})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"stdout.log").write_text("\n".join(
            [report.PREFIX+json.dumps(e) for e in self.events]
            + [continuation.PREFIX+json.dumps(e) for e in self.witnesses]))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(s) for s in self.samples))

    def validate(self):
        self.write()
        return continuation.validate(self.root)

    def test_complete_ten_modes_keep_measurement_limits(self):
        result = self.validate()
        self.assertEqual(len(result["cases"]),10)
        self.assertTrue(result["native_continuation_corpus_complete"])
        self.assertFalse(result["memory_envelope_calibrated"])
        self.assertFalse(result["production_protection_proven"])
        self.assertNotIn("native_terminal_corpus_complete",result)
        for event in self.witnesses:
            if event["phase"] == "original_executor_completed":
                self.assertEqual(result["cases"][event["case"]]["continuation"]["thread_id"],
                                 event["evidence"]["thread_id"])

    def test_cli_accepts_complete_files_and_rejects_missing_witness(self):
        self.write()
        cmd = [sys.executable,str(pathlib.Path(__file__).with_name("continuation_report.py")),str(self.root)]
        result = subprocess.run(cmd,capture_output=True,text=True,check=True)
        self.assertEqual(json.loads(result.stdout)["format"],"native-continuation-phase-report-v1")
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(cmd,capture_output=True).returncode,0)

    def test_missing_mode_duplicate_and_cross_corpus_are_rejected(self):
        for mutate in (lambda:self.events.pop(),lambda:self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
                       lambda:self.witnesses[0].update(case="Logical-fresh")):
            self.setUp()
            mutate()
            with self.assertRaises(ValueError): self.validate()

    def test_complete_original_input_and_history_hash_size_are_required(self):
        for key,value in (("seed_history_sha256","0"*64),("seed_history_bytes",1),
                          ("original_history_bytes",len(continuation.SEED)),
                          ("original_history_sha256","5"*64),("original_home_sha256","6"*64)):
            with self.subTest(key=key):
                self.setUp()
                self.witnesses[0]["evidence"][key]=value
                with self.assertRaises(ValueError): self.validate()

    def test_final_metadata_preparation_cache_and_full_prefix_are_required(self):
        for index,key in ((0,"final_identity_verified"),(0,"preparation_observed_by_native_process"),
                          (0,"original_full_lease_witness"),(2,"home_cache_hit"),
                          (2,"history_proof_bound"),(2,"full_original_prefix_verified")):
            with self.subTest(key=key):
                self.setUp()
                self.witnesses[index]["evidence"][key]=False
                with self.assertRaises(ValueError): self.validate()

    def test_original_generation_order_and_distinct_incoming_are_required(self):
        for mutate in (lambda:self.witnesses[2].update(backing_generation=str(uuid.uuid4())),
                       lambda:self.witnesses[2].update(monotonic_ns=self.events[4]["monotonic_ns"]),
                       lambda:self.witnesses[2]["evidence"].update(continued_sandbox_id=self.events[1]["sandbox_id"]),
                       lambda:self.witnesses[2]["evidence"].update(continued_run_id=self.witnesses[0]["evidence"]["original_run_id"])):
            self.setUp()
            mutate()
            with self.assertRaises(ValueError): self.validate()

    def test_actual_policy_headroom_age_budget_and_hash_are_required(self):
        for key,value in (("available_bytes",1),("age_ns",10**12),("allocated",[True,4096,1]),
                          ("profile_can_fit",False),("read_duration_ns",100)):
            self.setUp()
            self.witnesses[1]["evidence"][key]=value
            with self.assertRaises(ValueError): self.validate()
        self.setUp()
        self.collector["metadata"]["native_continuation_policy_json"]+=" "
        with self.assertRaises(ValueError): self.validate()

    def test_nonzero_terminal_and_required_saving_cannot_be_weakened(self):
        self.witnesses[0]["evidence"]["exit_code"]=True
        with self.assertRaises(ValueError): self.validate()
        self.setUp()
        self.witnesses[3]["evidence"]["required_cleanup_joined"]=False
        with self.assertRaises(ValueError): self.validate()
        self.setUp()
        self.witnesses[3]["evidence"]["verified_final_identity_preserved"]=False
        with self.assertRaises(ValueError): self.validate()
        self.setUp()
        self.events[3]["evidence"]["full_logical_lease"]=[2,2048,1]
        with self.assertRaises(ValueError): self.validate()

    def test_nonzero_withholds_reusable_identity_and_keeps_verified_home_history(self):
        for phase, key, value in (("original_executor_completed", "final_identity_verified", True),
                                  ("original_executor_completed", "reusable_identity_withheld_after_nonzero", False),
                                  ("continued_executor_completed", "history_proof_bound", False),
                                  ("continued_executor_completed", "final_identity_verified", False)):
            with self.subTest(phase=phase, key=key):
                self.setUp()
                event = next(e for e in self.witnesses if e["case"] == "ContinuationNonzero-fresh" and e["phase"] == phase)
                event["evidence"][key] = value
                with self.assertRaises(ValueError): self.validate()

    def test_collector_failure_intervention_and_unknown_windows_are_rejected(self):
        self.collector["cleanup_intervened"]=True
        with self.assertRaises(ValueError): self.validate()
        self.setUp()
        for sample in self.samples:
            for process in sample["processes"]:
                process["rss_bytes"]=None
                process["pss_bytes"]=None
                process["residency_state"]="unavailable"
                process["residency_reason"]="permission_denied"
        with self.assertRaises(ValueError): self.validate()


if __name__=="__main__":
    unittest.main()
