#!/usr/bin/env python3
"""Original-file/CLI quiesce regressions; synthetic fixtures are not native proof."""
import copy
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import unittest
import uuid

import fixed_restore_report_test as original
import quiesce_report as quiesce
import report


def frame(kind, payload=b"", sequence=2):
    raw = struct.pack(">IBI", 5+len(payload), kind, sequence)+payload
    return dict(message_type=kind, sequence=sequence, raw_hex=raw.hex(),
                sha256=hashlib.sha256(raw).hexdigest())


class QuiesceReportTests(unittest.TestCase):
    def setUp(self):
        original.FixedRestoreReportTests.setUp(self)
        raw = self.collector["metadata"].pop("native_fixed_restore_policy_json")
        self.collector["metadata"]["native_quiesce_policy_json"] = raw
        for value, old, new in (
            (self.values[2], "canonical_fixed_helper", "canonical_quiesce"),
            (self.values[3], "public_restore_polled_pending", "public_repark_polled_pending"),
            (self.values[3], "running_helper_observed", "preterminal_quiesce_observed"),
            (self.values[6], "canonical_helper_exited_zero", "canonical_quiesce_acknowledged"),
            (self.values[6], "helper_stdin_stderr_joined", "guest_dispatcher_completed"),
            (self.values[6], "running_helper_observed", "preterminal_quiesce_observed"),
            (self.values[7], "normal_operations_not_parkable", "park_policy_dirty"),
            (self.values[8], "running_helper_boundary", "native_busy_resume_boundary"),
        ):
            value[new] = value.pop(old)
        self.request, self.response = frame(0x05), frame(0x06)
        self.values[2]["request"] = self.request
        self.values[3]["request"] = self.request
        self.values[6].update(request=self.request, response=self.response)
        self.values[7]["error"] = "sandbox unpark failed: park policy dirty while unpark is a no-op: park attempt dropped after guest quiesce started"
        self.values[8]["original_cleanup_io_progress"] = "blocked_dirty"
        self.select("Quiesce-capture-drop-fresh")

    def select(self, case):
        if case.startswith("FixedRestore-"):
            original.FixedRestoreReportTests.select(self, case)
        else:
            for event in [*self.events, *self.witnesses, self.continuation]:
                event["case"] = case
            terminal = case.startswith("Quiesce-terminal-")
            self.values[3].update(boundary="terminal" if terminal else "capture",
                                  response=self.response if terminal else None)
            self.values[4]["observer_unwound"] = "-observer-unwind-" in case
            unwind = "-producer-unwind-" in case
            self.values[6].update(exchange_joined=not unwind, transport_producer_unwound=unwind,
                                  connection_retained_pending=not unwind)

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(value) for value in self.samples))
        lines = [report.PREFIX+json.dumps(self.events[0]),
                 "NATIVE_CONTINUATION_WITNESS "+json.dumps(self.continuation)]
        lines += [quiesce.PREFIX+json.dumps(value) for value in self.witnesses[:2]]
        lines += [report.PREFIX+json.dumps(self.events[1])]
        lines += [quiesce.PREFIX+json.dumps(value) for value in self.witnesses[2:]]
        (self.root/"stdout.log").write_text("\n".join(lines)+"\ntest result: FAILED\n")
        (self.root/"stderr.log").write_text("Error: QuiesceUncertain\n")

    def validate(self):
        self.write()
        return quiesce.validate(self.root)

    def test_all_twelve_supported_cases_retain_dirty_uncertainty(self):
        for case in sorted(quiesce.CASES):
            with self.subTest(case=case):
                self.select(case)
                result = self.validate()
                self.assertEqual(result["format"], "native-quiesce-custody-v1")
                self.assertTrue(result["native_quiesce_retained_custody_observed"])
                self.assertTrue(result["original_complete_data_verified"])
                self.assertEqual(result["original_driver_exit_code"], 101)
                for key in ("original_collector_success", "required_saving_complete", "cleanup_complete",
                            "physical_relief_proven", "memory_credit", "preterminal_quiesce_observed"):
                    self.assertIs(result[key], False)
                self.assertEqual(result["blocked_boundaries"],
                                 ["preterminal_acceptance", "native_busy_or_resume", "original_cleanup_io_progress"])

    def test_busy_wrong_ack_payload_and_sequence_are_not_quiescence(self):
        self.validate()
        for changed in (frame(0xff, b"guest operations still pending: 1"), frame(0x08),
                        frame(0x06, b"x"), frame(0x06, sequence=3)):
            with self.subTest(response=changed):
                self.values[6]["response"] = changed
                with self.assertRaises(ValueError):
                    self.validate()
        self.values[6]["response"] = self.response
        for changed in (frame(0x07), frame(0x05, b"x"), frame(0x05, sequence=0)):
            with self.subTest(request=changed):
                for value in (self.values[2], self.values[3], self.values[6]):
                    value["request"] = changed
                with self.assertRaises(ValueError):
                    self.validate()
        for value in (self.values[2], self.values[3], self.values[6]):
            value["request"] = self.request
        self.validate()

    def test_owner_clocks_progress_and_false_recovery_claims_are_rejected(self):
        self.validate()
        baseline = copy.deepcopy(self.witnesses)
        changes = [lambda values: values[3]["evidence"].update(preterminal_quiesce_observed=True),
                   lambda values: values[4]["evidence"].update(commit_refused=False),
                   lambda values: values[4]["evidence"].update(state="Prepared"),
                   lambda values: values[5]["evidence"].update(status_waits_after=0),
                   lambda values: values[5]["evidence"]["heartbeat"]["receipt"].update(acknowledgement_status=500),
                   lambda values: values[6]["evidence"].update(guest_dispatcher_completed=False),
                   lambda values: values[6]["evidence"].update(ordinary_reuse_reopened=True),
                   lambda values: values[7]["evidence"].update(error="normal operations are not available on this connection"),
                   lambda values: values[7]["evidence"].update(required_saving_complete=True),
                   lambda values: values[8]["evidence"].update(native_busy_resume_boundary="complete"),
                   lambda values: values[8]["evidence"].update(original_cleanup_io_progress="complete"),
                   lambda values: values[8]["evidence"].update(original_full_lease_active=False),
                   lambda values: values[8]["evidence"].update(memory_credit=True),
                   lambda values: values[7].update(backing_generation=str(uuid.uuid4())),
                   lambda values: values[6].update(monotonic_ns=self.at(7)),
                   lambda values: values.append(copy.deepcopy(values[-1])),
                   lambda values: values.pop(3)]
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                self.witnesses = copy.deepcopy(baseline)
                change(self.witnesses)
                with self.assertRaises(ValueError):
                    self.validate()

    def test_real_cli_keeps_failed_driver_and_rejects_forged_success(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(quiesce.__file__)), str(self.root)]
        actual = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(actual.returncode, 0, actual.stderr)
        self.assertFalse(json.loads(actual.stdout)["cleanup_complete"])
        for changes in ({"success": True}, {"driver_exit_code": 0}, {"driver_exit_code": True},
                        {"native_vm_exit_confirmed": True}, {"cleanup_confirmed": False}, {"headroom_stop": True}):
            with self.subTest(changes=changes):
                saved = copy.deepcopy(self.collector)
                self.collector.update(changes)
                self.write()
                self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
                self.collector = saved

    def test_complete_original_images_files_and_private_history_are_consumed(self):
        self.validate()
        for name in ("stdout.log", "report.json", "retained-home.ext4"):
            path = self.root/name
            saved = self.root/(name+".original")
            path.rename(saved)
            path.symlink_to(saved)
            try:
                with self.assertRaises((ValueError, OSError)):
                    quiesce.validate(self.root)
            finally:
                path.unlink()
                saved.rename(path)
        private = f"/.vm0/guest-agent/runs/{self.history}/fixture-private"
        subprocess.run(["/usr/sbin/debugfs", "-w", "-R", "rm "+private, str(self.image)],
                       check=True, capture_output=True)
        with self.assertRaises(ValueError):
            quiesce.validate(self.root)


if __name__ == "__main__":
    unittest.main()
