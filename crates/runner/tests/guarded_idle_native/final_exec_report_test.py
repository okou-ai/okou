#!/usr/bin/env python3
"""Original final-exec bytes/ext4/CLI regressions; synthetic data is not native proof."""
import copy
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import unittest
import uuid

import final_exec_report as final
import fixed_restore_report_test as original
import report


def frame(kind, payload):
    raw = struct.pack(">IBI",5+len(payload),kind,2)+payload
    return dict(message_type=kind,sequence=2,raw_hex=raw.hex(),sha256=hashlib.sha256(raw).hexdigest())


class FinalExecReportTests(unittest.TestCase):
    def setUp(self):
        # Reuse the real complete ext4/session/clock/progress fixture, not an
        # inherited suite whose tests could accidentally call the old reader.
        original.FixedRestoreReportTests.setUp(self)
        raw = self.collector["metadata"].pop("native_fixed_restore_policy_json")
        self.collector["metadata"]["native_final_exec_policy_json"] = raw
        self.request = self.make_request()
        self.result = {"before":{"availableBytes":256*1024**2,"availableInodes":2048},
                       "after":{"availableBytes":256*1024**2,"availableInodes":2048},
                       "home":{"availableBytes":256*1024**2,"availableInodes":2048},"removedEntries":0}
        self.response = self.make_result()
        for value, old, new in (
            (self.values[2],"canonical_fixed_helper","canonical_final_exec"),
            (self.values[3],"public_restore_polled_pending","public_repark_polled_pending"),
            (self.values[3],"running_helper_observed","running_exec_observed"),
            (self.values[6],"canonical_helper_exited_zero","canonical_final_exec_exited_zero"),
            (self.values[6],"helper_stdin_stderr_joined","exec_stdin_stdout_stderr_joined"),
            (self.values[6],"running_helper_observed","running_exec_observed"),
            (self.values[8],"running_helper_boundary","running_exec_boundary"),
        ):
            value[new] = value.pop(old)
        self.values[2]["request"] = self.request
        self.values[3]["request"] = self.request
        self.values[6].update(request=self.request,response=self.response)
        self.select("FinalExec-capture-drop-fresh")

    def make_request(self, command=final.COMMAND, history=None, lifecycle=0, label=final.LABEL, timeout=40000):
        runtime = f"/home/user/.vm0/guest-agent/runs/{history or self.history}"
        stdin = json.dumps({"currentRuntimeDir":runtime,"retainedRuntimeDir":runtime},separators=(",", ":")).encode()
        command = command.encode()
        payload = bytes((lifecycle,0,0))+struct.pack(">I",timeout)+b"\x01"
        payload += struct.pack(">I",len(command))+command+bytes(4)+struct.pack(">H",len(label))+label
        payload += (b"\x01"+struct.pack(">I",65536))*2+bytes(3)+b"\x01"+struct.pack(">I",len(stdin))+stdin
        return frame(0x0b,payload)

    def make_result(self, stdout=None, exit_code=0):
        stdout = json.dumps(self.result,separators=(",", ":")).encode() if stdout is None else stdout
        data = b"\0"+struct.pack(">iI",exit_code,3)+b"\x01\0"+struct.pack(">I",len(stdout))+stdout
        return frame(0x0e,data+b"\x01\0"+bytes(4)+bytes(2))

    def select(self, case):
        if case.startswith("FixedRestore-"):
            return original.FixedRestoreReportTests.select(self,case)
        for event in [*self.events,*self.witnesses,self.continuation]:
            event["case"] = case
        terminal = case.startswith("FinalExec-terminal-")
        self.values[3].update(boundary="terminal" if terminal else "capture",response=self.response if terminal else None)
        self.values[4]["observer_unwound"] = "-observer-unwind-" in case
        unwind = "-producer-unwind-" in case
        self.values[6].update(exchange_joined=not unwind,transport_producer_unwound=unwind,connection_retained_pending=not unwind)

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(v) for v in self.samples))
        lines = [report.PREFIX+json.dumps(self.events[0]),"NATIVE_CONTINUATION_WITNESS "+json.dumps(self.continuation)]
        lines += [final.PREFIX+json.dumps(v) for v in self.witnesses[:2]]
        lines += [report.PREFIX+json.dumps(self.events[1])]
        lines += [final.PREFIX+json.dumps(v) for v in self.witnesses[2:]]
        (self.root/"stdout.log").write_text("\n".join(lines)+"\ntest result: FAILED\n")
        (self.root/"stderr.log").write_text("Error: FinalExecUncertain\n")

    def validate(self):
        self.write()
        return final.validate(self.root)

    def test_all_twelve_supported_cases_keep_original_uncertainty(self):
        for case in sorted(final.CASES):
            with self.subTest(case=case):
                self.select(case)
                result = self.validate()
                self.assertEqual(result["format"],"native-final-exec-custody-v1")
                self.assertTrue(result["native_final_exec_retained_custody_observed"])
                self.assertTrue(result["original_complete_data_verified"])
                self.assertEqual(result["original_driver_exit_code"],101)
                for name in ("original_collector_success","required_saving_complete","cleanup_complete","physical_relief_proven","memory_credit","running_exec_observed"):
                    self.assertIs(result[name],False)

    def test_substituted_canonical_exec_and_runtime_are_rejected_with_valid_new_hashes(self):
        self.validate()
        original_request = self.request
        for change in ({"command":"true"},{"history":str(uuid.uuid4())},{"lifecycle":1},
                       {"label":b"unrelated-run"},{"timeout":50000}):
            with self.subTest(change=change):
                changed = self.make_request(**change)
                for value in (self.values[2],self.values[3],self.values[6]):value["request"] = changed
                with self.assertRaises(ValueError):self.validate()
        for value in (self.values[2],self.values[3],self.values[6]):value["request"] = original_request
        self.validate()

    def test_real_terminal_output_capacity_and_classification_are_required(self):
        self.validate()
        responses = [self.make_result(exit_code=1),self.make_result(stdout=b"{}"),
                     self.make_result(stdout=b'{"before":{},"before":{},"after":{},"removedEntries":0}')]
        for field,value in (("availableBytes",128*1024**2-1),("availableInodes",1023)):
            changed = copy.deepcopy(self.result)
            changed["after"][field] = value
            responses.append(self.make_result(stdout=json.dumps(changed).encode()))
        for response in responses:
            with self.subTest(response=response["sha256"]):
                self.values[6]["response"] = response
                with self.assertRaises(ValueError):self.validate()
        self.values[6]["response"] = self.response
        self.validate()

    def test_custody_progress_identity_and_false_running_claims_are_rejected(self):
        self.validate()
        baseline = copy.deepcopy(self.witnesses)
        mutations = [lambda v:v[3]["evidence"].update(running_exec_observed=True),
                     lambda v:v[4]["evidence"].update(commit_refused=False),
                     lambda v:v[5]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
                     lambda v:v[5]["evidence"].update(status_waits_after=0),
                     lambda v:v[6]["evidence"].update(exec_stdin_stdout_stderr_joined=False),
                     lambda v:v[7]["evidence"].update(required_saving_complete=True),
                     lambda v:v[8]["evidence"].update(original_full_lease_active=False),
                     lambda v:v[8]["evidence"].update(running_exec_boundary="complete"),
                     lambda v:v[8]["evidence"].update(memory_credit=True),
                     lambda v:v[7].update(backing_generation=str(uuid.uuid4())),
                     lambda v:v[6].update(monotonic_ns=self.at(7)),
                     lambda v:v.append(copy.deepcopy(v[-1])),lambda v:v.pop(3)]
        for index,mutation in enumerate(mutations):
            with self.subTest(mutation=index):
                self.witnesses = copy.deepcopy(baseline)
                mutation(self.witnesses)
                with self.assertRaises(ValueError):self.validate()

    def test_actual_cli_preserves_failed_driver_and_rejects_forged_success(self):
        self.write()
        command = [sys.executable,str(pathlib.Path(final.__file__)),str(self.root)]
        actual = subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(actual.returncode,0,actual.stderr)
        self.assertFalse(json.loads(actual.stdout)["cleanup_complete"])
        for changes in ({"success":True},{"driver_exit_code":0},{"driver_exit_code":True},
                        {"native_vm_exit_confirmed":True},{"cleanup_confirmed":False},{"headroom_stop":True}):
            with self.subTest(changes=changes):
                saved = copy.deepcopy(self.collector)
                self.collector.update(changes)
                self.write()
                self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
                self.collector = saved

    def test_original_images_files_and_complete_private_data_are_consumed(self):
        self.validate()
        for name in ("stdout.log","report.json","retained-home.ext4"):
            path = self.root/name
            saved = self.root/(name+".original")
            path.rename(saved)
            path.symlink_to(saved)
            try:
                with self.assertRaises((ValueError,OSError)):final.validate(self.root)
            finally:
                path.unlink()
                saved.rename(path)
        private = f"/.vm0/guest-agent/runs/{self.history}/fixture-private"
        subprocess.run(["/usr/sbin/debugfs","-w","-R","rm "+private,str(self.image)],check=True,capture_output=True)
        with self.assertRaises(ValueError):final.validate(self.root)


if __name__ == "__main__":
    unittest.main()
