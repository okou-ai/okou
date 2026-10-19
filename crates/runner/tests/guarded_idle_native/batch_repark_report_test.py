#!/usr/bin/env python3
"""Synthetic original-file/CLI physical rollback reader tests, never KVM proof."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import uuid

import batch_aba_report_test as batch_test
import batch_repark_report as repark


class BatchReparkReportTests(batch_test.BatchAbaReportTests):
    def setUp(self):
        super().setUp()
        raw = self.collector["metadata"].pop("native_batch_aba_policy_json")
        self.collector["metadata"]["native_batch_repark_policy_json"] = raw
        for event in self.events+self.witnesses:
            event["case"] = event["case"].replace("BatchAba-", "BatchRepark-")
        self.physical = []
        for blocked in (e for e in self.witnesses if e["phase"] == "admission_blocked"):
            case, begin = blocked["case"], blocked["monotonic_ns"]
            initial = blocked["evidence"]["published_status"]["idle_sandboxes"][0]
            history = initial["reuse_key"].removeprefix("thread:native-guarded-")
            digest = hashlib.sha256((history.encode()*1821)[:65536]).hexdigest()
            cycles = []
            for index in range(2):
                at = begin+20+index*60
                cycles.append({"operation_run_id":str(uuid.uuid4()),"prepare_started_ns":at,
                    "rpc_completed_ns":at+10,"prepared_ns":at+20,"repark_started_ns":at+30,
                    "repark_completed_ns":at+40,"payload_sha256":digest,"private_history_verified":True,
                    "ordinary_home_verified":True,"physical_unpark_completed":True,
                    "physical_repark_completed":True,"original_metadata_preserved":True,"original_full_lease_active":True})
            self.physical.append({"version":1,"case":case,"phase":"original_reparked",
                "monotonic_ns":begin+150,"unix_ns":blocked["unix_ns"]+150,
                "sandbox_id":blocked["sandbox_id"],"backing_generation":blocked["backing_generation"],
                "evidence":{"started_ns":begin+10,"restored_ns":begin+140,"original_history_run_id":history,
                    "original_sandbox_id":initial["sandbox_id"],"original_backing_generation":blocked["backing_generation"],
                    "reuse_key":initial["reuse_key"],"cycles":cycles,"revision":3,"same_insertion":False,
                    "restored_original":True,"image_size_bytes":16384*1024**2,"payload_bytes":65536,
                    "allocated":[2,4096,1],"provider_awaits_outside_pool_status":True}})
            for event in self.witnesses:
                if event["case"] == case and event["phase"] in ("pool_wait_progress", "batch_refused"):
                    event["evidence"]["revision"] = 5

    def write(self):
        super().write()
        with (self.root/"stdout.log").open("a") as stream:
            for event in self.physical:
                stream.write("\n"+repark.PREFIX+json.dumps(event))

    def validate(self):
        self.write()
        return repark.validate(self.root)

    def test_both_cases_preserve_explicit_native_measurement_limits(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), repark.CASES)
        self.assertTrue(value["native_batch_repark_complete"])
        for key in ("memory_envelope_calibrated","production_protection_proven",
                    "bootstrap_provenance_verified","actual_api_claim_loss_proven"):
            self.assertIs(value[key], False)

    def test_real_file_cli_accepts_complete_proof_and_refuses_missing_phase(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("batch_repark_report.py")), str(self.root)]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        self.physical.pop(); self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def physical_refused(self, changes):
        original = copy.deepcopy(self.physical)
        try:
            for index, change in enumerate(changes):
                with self.subTest(change=index):
                    self.physical = copy.deepcopy(original)
                    change()
                    with self.assertRaises(ValueError): self.validate()
        finally:
            self.physical = original
        self.validate()

    def test_both_actual_cycles_and_strict_original_identity_are_required(self):
        self.physical_refused((lambda:self.physical.pop(),lambda:self.physical.append(copy.deepcopy(self.physical[0])),
            lambda:self.physical[0].update(sandbox_id=str(uuid.uuid4())),
            lambda:self.physical[0]["evidence"].update(original_history_run_id=str(uuid.uuid4())),
            lambda:self.physical[0]["evidence"]["cycles"].pop(),
            lambda:self.physical[0]["evidence"]["cycles"].reverse(),
            lambda:self.physical[0]["evidence"]["cycles"][1].update(
                operation_run_id=self.physical[0]["evidence"]["cycles"][0]["operation_run_id"])))

    def test_physical_rpc_park_full_original_data_and_custody_are_required(self):
        for field in ("private_history_verified","ordinary_home_verified","physical_unpark_completed",
                      "physical_repark_completed","original_metadata_preserved","original_full_lease_active"):
            self.physical_refused((lambda field=field:self.physical[0]["evidence"]["cycles"][1].update({field:False}),))
        self.physical_refused((lambda:self.physical[0]["evidence"]["cycles"][1].update(payload_sha256="0"*64),
            lambda:self.physical[0]["evidence"].update(allocated=[0,0,0]),
            lambda:self.physical[0]["evidence"].update(image_size_bytes=0),
            lambda:self.physical[0]["evidence"].update(same_insertion=True),
            lambda:self.physical[0]["evidence"].update(revision=1),
            lambda:self.physical[0]["evidence"].update(revision=5),
            lambda:self.physical[0]["evidence"].update(provider_awaits_outside_pool_status=False)))

    def test_unordered_provider_clocks_and_unknown_typed_fields_are_refused(self):
        self.physical_refused((lambda:self.physical[0].update(monotonic_ns=1),
            lambda:self.physical[0]["evidence"]["cycles"][0].update(rpc_completed_ns=True),
            lambda:self.physical[0]["evidence"]["cycles"][1].update(repark_completed_ns=1),
            lambda:self.physical[0]["evidence"].update(unexpected=True)))

    def test_raw_policy_and_source_mismatch_are_refused(self):
        self.collector["metadata"]["native_batch_repark_policy_json"] += " "
        with self.assertRaises(ValueError): self.validate()
        self.collector["metadata"]["native_batch_repark_policy_json"] = self.collector["metadata"]["native_batch_repark_policy_json"].rstrip()
        self.events[0]["evidence"]["artifacts"]["source_sha"] = "0"*40
        with self.assertRaises(ValueError): self.validate()

    def test_complete_original_home_and_raw_policy_identity_remain_required(self):
        self.events[-1]["evidence"]["original_home_restored"] = False
        with self.assertRaises(ValueError): self.validate()
        self.events[-1]["evidence"]["original_home_restored"] = True
        self.collector["metadata"]["native_batch_repark_policy_json"] += " "
        with self.assertRaises(ValueError): self.validate()


if __name__ == "__main__":
    import unittest
    unittest.main()
