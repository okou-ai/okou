#!/usr/bin/env python3
"""Original-file and real CLI negatives; synthetic fixtures are not native proof."""
import copy
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import unittest
import uuid

import fixed_restore_report as fixed
import guest_preparation_report_fixture as fixture


class FixedRestoreReportTests(unittest.TestCase):
    def setUp(self):
        fixture.prepare(self)

    def select(self, case):
        fixture.select_case(self, case, terminal=case.startswith("FixedRestore-terminal-"))

    def write(self):
        fixture.write_report(self, prefix=fixed.PREFIX, uncertainty="FixedRestoreUncertain")

    def validate(self):
        self.write();return fixed.validate(self.root)

    def test_all_supported_boundaries_modes_and_faults_keep_failed_outcome(self):
        for case in sorted(fixed.CASES):
            with self.subTest(case=case):
                self.select(case);value=self.validate()
                self.assertTrue(value["native_fixed_restore_retained_custody_observed"])
                self.assertTrue(value["original_complete_data_verified"])
                self.assertEqual(value["original_driver_exit_code"],101)
                for name in ("original_collector_success","required_saving_complete","cleanup_complete","physical_relief_proven","memory_credit","running_helper_observed"):
                    self.assertIs(value[name],False)

    def test_original_evidence_mutations_are_rejected(self):
        original=copy.deepcopy(self.witnesses)
        changes=[lambda v:v[0]["evidence"].update(final_identity_verified=False),
            lambda v:v[0]["evidence"].update(history_hex="00"),
            lambda v:v[0]["evidence"]["physical_history"].update(path="/home/user/../different"),
            lambda v:v[1]["evidence"].update(guest_sync_completed=False),
            lambda v:v[2]["evidence"]["request"].update(sequence=3),
            lambda v:v[2]["evidence"]["request"].update(message_type=11),
            lambda v:v[3]["evidence"].update(running_helper_observed=True),
            lambda v:v[4]["evidence"].update(commit_refused=False),
            lambda v:v[4]["evidence"].update(allocated=[0,0,0]),
            lambda v:v[5]["evidence"].update(p1_sample_ns=self.at(18)),
            lambda v:v[5]["evidence"].update(status_waits_after=0),
            lambda v:v[5]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
            lambda v:v[6]["evidence"].update(helper_stdin_stderr_joined=False),
            lambda v:v[6]["evidence"]["response"].update(sha256="a"*64),
            lambda v:v[7]["evidence"].update(required_saving_complete=True),
            lambda v:v[8]["evidence"]["accounting"].update(uncertain=0),
            lambda v:v[8]["evidence"].update(promotion_lock_busy=False),
            lambda v:v[8]["evidence"].update(running_helper_boundary="complete"),
            lambda v:v[8]["evidence"].update(memory_credit=True),
            lambda v:v[8]["evidence"].update(original_full_lease_active=1),
            lambda v:v[7].update(backing_generation=str(uuid.uuid4())),
            lambda v:v[6].update(monotonic_ns=self.at(7)),
            lambda v:v[2].update(unix_ns=self.at(1)),
            lambda v:v.append(copy.deepcopy(v[-1])),lambda v:v.pop(3)]
        for index,change in enumerate(changes):
            with self.subTest(change=index):
                self.witnesses=copy.deepcopy(original);change(self.witnesses)
                with self.assertRaises(ValueError):self.validate()

    def test_real_cli_accepts_original_and_rejects_false_success_and_tampering(self):
        self.write()
        command=[sys.executable,str(pathlib.Path(fixed.__file__)),str(self.root)]
        result=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse(json.loads(result.stdout)["required_saving_complete"])
        for changes in ({"success":True},{"driver_exit_code":0},{"driver_exit_code":True},
                        {"headroom_stop":True},{"native_vm_exit_confirmed":True},{"errors":["teardown failed"]}):
            with self.subTest(changes=changes):
                original=copy.deepcopy(self.collector);self.collector.update(changes);self.write()
                self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
                self.collector=original
        self.values[6]["response"]["raw_hex"]="00";self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def test_original_files_images_and_complete_history_cannot_be_substituted(self):
        self.write()
        for name in ("stdout.log","report.json","retained-home.ext4"):
            path=self.root/name;saved=self.root/(name+".original");path.rename(saved);path.symlink_to(saved)
            try:
                with self.assertRaises((ValueError,OSError)):fixed.validate(self.root)
            finally:path.unlink();saved.rename(path)
        source=self.root/"changed-history";source.write_bytes(b"changed complete history")
        image_path=self.session_path.removeprefix("/home/user")
        subprocess.run(["/usr/sbin/debugfs","-w","-R","rm "+image_path,str(self.image)],check=True,capture_output=True)
        subprocess.run(["/usr/sbin/debugfs","-w","-R",f"write {source} {image_path}",str(self.image)],check=True,capture_output=True)
        with self.assertRaises(ValueError):fixed.validate(self.root)

    def test_retained_image_directory_does_not_leak_descriptor(self):
        self.image.unlink()
        self.image.mkdir()
        with open(os.devnull, "rb") as marker:
            available = marker.fileno()

        with self.assertRaises(IsADirectoryError):
            self.validate()

        with open(os.devnull, "rb") as marker:
            self.assertEqual(marker.fileno(), available)

    def test_failed_wire_result_and_changed_fixed_input_are_rejected_even_with_new_hash(self):
        for value,offset in ((self.request,9),(self.request,13),(self.response,10)):
            with self.subTest(frame=value["message_type"]):
                original=copy.deepcopy(value);raw=bytearray.fromhex(value["raw_hex"]);raw[offset]^=1
                value.update(raw_hex=raw.hex(),sha256=hashlib.sha256(raw).hexdigest())
                with self.assertRaises(ValueError):self.validate()
                value.clear();value.update(original)


if __name__=="__main__":unittest.main()
