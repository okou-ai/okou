#!/usr/bin/env python3
"""Synthetic original-file/CLI regressions; native KVM proof remains opt-in."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
from unittest.mock import patch
import uuid

import batch_replacement_report as replacement
import batch_replacement_report_test as replacement_test
import dual_history_report as dual
import report


def session(thread, message):
    return (json.dumps({"type":"session_meta","payload":{"id":thread}})+"\n"
            + json.dumps({"type":"event_msg","payload":{"message":message}})+"\n").encode()


class DualHistoryReportTests(unittest.TestCase):
    def setUp(self):
        with patch.object(replacement, "CASES", dual.CASES):
            replacement_test.ReplacementReportTests.setUp(self)
        metadata = self.collector["metadata"]
        metadata["native_dual_history_policy_json"] = metadata["native_batch_replacement_policy_json"]
        self.duals = []
        for case in sorted(dual.CASES):
            terminal = [e for e in self.events if e["case"] == case]
            core = [e for e in self.witnesses if e["case"] == case]
            at = lambda offset: terminal[0]["monotonic_ns"]+int(offset*1_000_000)
            old, backing = terminal[1]["sandbox_id"], terminal[1]["backing_generation"]
            prep = core[0]["evidence"]["preparation"]
            prep["prepared_ns"] = at(4.75)
            new, new_backing = prep["sandbox_id"], prep["backing_generation"]
            core[7]["evidence"].update(started_ns=at(45),joined_ns=at(45.5))
            reuse = core[0]["evidence"]["same_reuse_key"]
            run = reuse.removeprefix("thread:native-guarded-")
            thread, incoming_run, incoming_thread, continued_run = [str(uuid.uuid4()) for _ in range(4)]
            key = hashlib.sha256((case+reuse).encode()).hexdigest()
            original = session(thread, run)
            incoming = session(incoming_thread, incoming_run)
            continued = incoming+(json.dumps({"type":"event_msg","payload":{"continued":continued_run}})+"\n").encode()
            nonzero = "Nonzero" in case
            values = [
                {"run_id":run,"sandbox_id":old,"backing_generation":backing,"thread_id":thread,
                 "history_hex":original.hex(),"cache_key":key,"reuse_key":reuse,"profile":"vm0/default",
                 "home_bytes":report.NATIVE_HOME_BYTES,"exit_code":1 if nonzero else 0,
                 "final_identity_verified":not nonzero,"allocated":[2,4096,1]},
                {"run_id":incoming_run,"sandbox_id":new,"backing_generation":new_backing,"thread_id":incoming_thread,
                 "history_hex":incoming.hex(),"cache_key":key,"reuse_key":reuse,"initial_checkout":"LockBusy","lock_owner":"finalizing",
                 "final_identity_verified":True,"incoming_full_lease_active":True,"allocated":[4,8192,2]},
                None, None,
                {"run_id":continued_run,"previous_run_id":incoming_run,"sandbox_id":new,"backing_generation":new_backing,
                 "thread_id":incoming_thread,"history_hex":continued.hex(),"original_history_hex":incoming.hex(),
                 "cache_key":key,"same_full_lease_active":True,"active_checkout":"Miss","actual_executor_reuse":True,
                 "final_identity_verified":True,"allocated":[2,4096,1]},
                None, None,
                {"original_api_joined":True,"incoming_api_joined":True,
                 "both_required_histories_restored":True,"permanent_dual_cache_retention_claimed":False},
            ]
            for index,data,generation,origin,source_id,source_thread,private,allocated,released in (
                    (2,original,run,run,old,thread,[run],[4,8192,2],[2,4096,1]),
                    (5,continued,continued_run,incoming_run,new,incoming_thread,[incoming_run,continued_run],[2,4096,1],[0,0,0])):
                restore_run, restore_id, restore_backing = [str(uuid.uuid4()) for _ in range(3)]
                payload = (origin.encode()*2048)[:65536]
                values[index] = {"source_run_id":generation,"original_run_id":origin,"source_sandbox_id":source_id,
                    "restoration_run_id":restore_run,"restoration_sandbox_id":restore_id,
                    "restoration_backing_generation":restore_backing,"thread_id":source_thread,"cache_key":key,
                    "history_hex":data.hex(),"restored_history_hex":data.hex(),"home_hex":payload.hex(),
                    "workspace_hex":payload.hex(),"ordinary_hex":b"native ordinary home bytes".hex(),
                    "private_generations_removed":private,
                    "history_proof_generation":generation,"cache_hit":True,"allocated":allocated}
                values[index+1] = {"restoration_run_id":restore_run,"restoration_sandbox_id":restore_id,
                    "restoration_backing_generation":restore_backing,"backing_exit_confirmed":True,
                    "home_cache_promoted":True,"full_lease_released":True,"tracker_joined":True,
                    "remaining_activation_owners":0,"allocated":released}
            for phase,value,offset in zip(dual.PHASES,values,(.5,4.5,43,43.5,44,47,48,55)):
                self.duals.append({"version":1,"case":case,"phase":phase,"monotonic_ns":at(offset),
                    "unix_ns":at(offset)+1000,"sandbox_id":old,"backing_generation":backing,"evidence":value})

    def event(self, phase):
        return next(e for e in self.duals if e["phase"] == phase)

    def write(self):
        replacement_test.ReplacementReportTests.write(self)
        with (self.root/"stdout.log").open("a") as stream:
            stream.write("\n"+"\n".join(dual.PREFIX+json.dumps(e) for e in self.duals))

    def validate(self):
        self.write()
        return dual.validate(self.root)

    def reject(self, *changes):
        original = copy.deepcopy((self.duals,self.witnesses,self.events,self.collector))
        for index,change in enumerate(changes):
            with self.subTest(change=index):
                self.duals,self.witnesses,self.events,self.collector = copy.deepcopy(original)
                change()
                with self.assertRaises(ValueError): self.validate()

    def test_four_complete_histories_preserve_explicit_limits(self):
        result = self.validate()
        self.assertEqual(set(result["cases"]),dual.CASES)
        self.assertTrue(result["native_dual_history_complete"])
        self.assertTrue(result["incoming_required_history_proven"])
        for key in ("permanent_dual_cache_retention_claimed","memory_envelope_calibrated",
                    "bootstrap_provenance_verified","production_protection_proven","actual_api_claim_loss_proven"):
            self.assertIs(result[key],False)

    def test_complete_raw_oracles_are_required(self):
        self.reject(
            lambda:self.event("original_restored")["evidence"].pop("restored_history_hex"),
            lambda:self.event("original_restored")["evidence"].update(restored_history_hex="00"),
            lambda:self.event("incoming_restored")["evidence"].update(workspace_hex="00"*65536),
            lambda:self.event("incoming_restored")["evidence"].update(home_hex="00"),
            lambda:self.event("incoming_restored")["evidence"].update(ordinary_hex="00"),
            lambda:self.event("incoming_continued")["evidence"].update(history_hex=self.event("incoming_prepared")["evidence"]["history_hex"]),
            lambda:self.event("incoming_prepared")["evidence"].update(history_hex=self.event("original_prepared")["evidence"]["history_hex"]))

    def test_same_cache_entry_and_actual_reuse_are_required(self):
        self.reject(
            lambda:self.event("incoming_prepared")["evidence"].update(initial_checkout="Miss"),
            lambda:self.event("incoming_prepared")["evidence"].update(lock_owner="unavailable"),
            lambda:self.event("incoming_continued")["evidence"].update(cache_key="a"*64),
            lambda:self.event("incoming_continued")["evidence"].update(actual_executor_reuse=False),
            lambda:self.event("incoming_continued")["evidence"].update(sandbox_id=str(uuid.uuid4())),
            lambda:self.event("incoming_continued")["evidence"].update(backing_generation=str(uuid.uuid4())),
            lambda:self.event("incoming_restored")["evidence"].update(cache_hit=False))

    def test_generations_private_cleanup_and_meaningful_nonzero_are_required(self):
        self.reject(
            lambda:self.event("incoming_restored")["evidence"].update(history_proof_generation=self.event("incoming_prepared")["evidence"]["run_id"]),
            lambda:self.event("original_restored")["evidence"].update(private_generations_removed=[]),
            lambda:self.event("incoming_restored")["evidence"]["private_generations_removed"].pop(),
            lambda:self.event("original_prepared")["evidence"].update(final_identity_verified=True),
            lambda:self.event("incoming_continued")["evidence"].update(previous_run_id=str(uuid.uuid4())))

    def test_positive_saving_joins_and_full_original_leases_are_required(self):
        self.reject(
            lambda:self.event("incoming_prepared")["evidence"].update(incoming_full_lease_active=False),
            lambda:self.event("incoming_continued")["evidence"].update(same_full_lease_active=False),
            lambda:self.event("original_restored_joined")["evidence"].update(home_cache_promoted=False),
            lambda:self.event("incoming_restored_joined")["evidence"].update(backing_exit_confirmed=False),
            lambda:self.event("incoming_restored_joined")["evidence"].update(allocated=[2,4096,1]),
            lambda:self.event("histories_joined")["evidence"].update(incoming_api_joined=False))

    def test_phase_sets_clocks_and_cross_case_replays_are_refused(self):
        self.reject(lambda:self.duals.pop(), lambda:self.duals.insert(1,copy.deepcopy(self.duals[0])),
            lambda:self.event("original_restored").update(monotonic_ns=self.event("incoming_continued")["monotonic_ns"]),
            lambda:self.event("incoming_restored").update(unix_ns=1),
            lambda:self.witnesses[0]["evidence"]["preparation"].update(prepared_ns=self.event("incoming_prepared")["monotonic_ns"]),
            lambda:self.event("incoming_continued")["evidence"].update(run_id=self.event("incoming_prepared")["evidence"]["run_id"]),
            lambda:self.event("original_prepared").update(sandbox_id=str(uuid.uuid4())))

    def test_shared_c6_custody_refusal_and_collector_cannot_be_waived(self):
        self.reject(lambda:self.witnesses[0]["evidence"].update(allocated=[2,4096,1]),
            lambda:self.witnesses[6]["evidence"].update(error="ResourceChanged"),
            lambda:self.collector.update(cleanup_intervened=True))

    def test_real_cli_reads_original_files_and_rejects_a_missing_join(self):
        self.write()
        command=[sys.executable,"-B",str(pathlib.Path(__file__).with_name("dual_history_report.py")),str(self.root)]
        result=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.duals.pop();self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def test_duplicate_json_fields_and_noncanonical_bytes_are_refused(self):
        self.reject(lambda:self.event("original_restored")["evidence"].update(home_hex="AA"*65536),
            lambda:self.event("incoming_restored")["evidence"].update(restored_history_hex="ff "),
            lambda:self.event("incoming_prepared")["evidence"].update(incoming_full_lease_active=1))
        self.write()
        path=self.root/"stdout.log"
        path.write_text(path.read_text().replace('"initial_checkout": "LockBusy"','"initial_checkout": "Miss", "initial_checkout": "LockBusy"',1))
        with self.assertRaises(ValueError):dual.validate(self.root)


if __name__ == "__main__":
    unittest.main()
