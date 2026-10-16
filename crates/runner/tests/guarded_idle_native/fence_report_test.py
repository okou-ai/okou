#!/usr/bin/env python3
"""Real-file and CLI regressions for native refusal instead of assumed custody."""

import copy
import json
import pathlib
import subprocess
import sys
import unittest

import fence_report as fence
import foreground_report_test


class FenceReportTests(unittest.TestCase):
    def setUp(self):
        foreground_report_test.ForegroundReportTests.setUp(self)
        # Preserve the complete inherited physical/progress fixture and reserve
        # a separate actual-clock interval before its first foreground phase.
        for event in self.events + self.witnesses:
            event["monotonic_ns"] += 20_000_000_000
            event["unix_ns"] += 20_000_000_000
        for event in self.witnesses:
            value = event["evidence"]
            for key in ("pool_held_ns", "status_held_ns", "pool_released_ns", "status_wait_polled_ns"):
                if key in value:
                    value[key] += 20_000_000_000
            for owner in ("observer", "heartbeat"):
                if owner in value:
                    for key in ("started_ns", "completed_ns"):
                        if key in value[owner]:
                            value[owner][key] += 20_000_000_000
                    if owner == "heartbeat":
                        value[owner]["receipt"]["received_ns"] += 20_000_000_000
            for sample in value.get("samples", []):
                sample["started_ns"] += 20_000_000_000
                sample["finished_ns"] += 20_000_000_000
        for sample in self.samples:
            sample["monotonic_ns"] += 20_000_000_000
        self.fences = []
        for offset, case in enumerate(sorted(fence.foreground.CASES)):
            original = self.events[offset * 6 + 1]
            identity = original["sandbox_id"], original["backing_generation"]
            # Move only terminal start earlier; every refusal still follows the
            # bound original Guest and precedes foreground's input phase.
            original["monotonic_ns"] -= 10_000_000_000
            original["unix_ns"] -= 10_000_000_000
            self.events[offset * 6]["monotonic_ns"] -= 10_000_000_000
            self.events[offset * 6]["unix_ns"] -= 10_000_000_000
            base = original["monotonic_ns"] + 1_000_000
            revision = 1
            for index, (phase, error) in enumerate(fence.ERRORS.items()):
                clock = base + index * 2_000_000_000
                ready = revision + (2 if phase == "changed_insertion" else 0)
                evidence = {
                    "policy": self.policy, "expected_error": error, "error": error,
                    "selected_ns": clock, "granted_ns": clock + 10_000_000,
                    "pool_held_ns": clock + 20_000_000, "wait_polled_ns": clock + 30_000_000,
                    "pool_released_ns": clock + 1_100_000_000, "refused_ns": clock + 1_110_000_000,
                    "selected_revision": revision, "ready_revision": ready, "refused_revision": ready,
                    "same_insertion": phase != "changed_insertion", "pool_wait_polled_pending": True,
                    "observer": {"started_ns": clock + 40_000_000, "completed_ns": clock + 50_000_000,
                        "available_bytes": 32 * 1024**3, "age_ns": 2, "read_duration_ns": 1, "joined": True},
                    "samples": [{"started_ns": clock + delta, "finished_ns": clock + delta + 3,
                        "read_start_offset_ns": clock + delta, "available_bytes": 32 * 1024**3,
                        "age_ns": 2, "read_duration_ns": 1} for delta in (1, 10)],
                    "paired_grants": 2, "registered_after": 0, "started_after": 0, "tracked_after": 0,
                    "foreign_closed": True, "foreign_registered": 0, "foreign_started": 0, "foreign_tracked": 0,
                    "original_sandbox_id": identity[0], "original_backing_generation": identity[1],
                    "full_original_lease": [2, 4096, 1], "allocated": [2, 4096, 1],
                    "original_retained": True, "cleanup_accepted": False,
                }
                self.fences.append({"version": 1, "case": case, "phase": phase,
                    "monotonic_ns": clock + 1_120_000_000, "unix_ns": clock + 1_120_001_000,
                    "sandbox_id": identity[0], "backing_generation": identity[1], "evidence": evidence})
                revision = ready

    def write(self):
        foreground_report_test.ForegroundReportTests.write(self)
        with (self.root / "stdout.log").open("a") as stream:
            for event in self.fences:
                stream.write("\n" + fence.PREFIX + json.dumps(event))

    def validate(self):
        self.write()
        return fence.validate(self.root)

    def test_complete_refusals_preserve_inherited_limits(self):
        result = self.validate()
        self.assertTrue(result["native_retirement_fences_complete"])
        self.assertFalse(result["production_protection_proven"])
        self.assertEqual(len(result["cases"]), 4)

    def test_real_cli_accepts_complete_files_and_refuses_missing_fence(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("fence_report.py")), str(self.root)]
        self.assertTrue(json.loads(subprocess.check_output(command))["native_retirement_fences_complete"])
        self.fences.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_missing_duplicate_order_and_wrong_refusal_are_rejected(self):
        for mutation in (lambda: self.fences.pop(1),
                lambda: self.fences.append(copy.deepcopy(self.fences[0])),
                lambda: self.fences[0].update(phase="changed_insertion"),
                lambda: self.fences[0]["evidence"].update(error="ResourceChanged")):
            original = copy.deepcopy(self.fences)
            mutation()
            with self.assertRaises(ValueError):
                self.validate()
            self.fences = original

    def test_each_custody_or_claim_field_is_required_and_typed(self):
        original = copy.deepcopy(self.fences)
        for key in ("paired_grants", "registered_after", "started_after", "tracked_after",
                "foreign_closed", "foreign_registered", "foreign_started", "foreign_tracked",
                "original_sandbox_id", "original_backing_generation", "full_original_lease",
                "allocated", "original_retained", "cleanup_accepted", "same_insertion", "pool_wait_polled_pending"):
            self.fences = copy.deepcopy(original)
            value = self.fences[0]["evidence"]
            value[key] = not value[key] if isinstance(value[key], bool) else None
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate()
        self.fences = original
        self.fences[0]["evidence"]["started_after"] = False
        with self.assertRaises(ValueError):
            self.validate()

    def test_elapsed_expiry_and_observer_inside_wait_are_required(self):
        original = copy.deepcopy(self.fences)
        for key, value in (("granted_ns", self.fences[0]["evidence"]["pool_held_ns"] - 1),
                           ("wait_polled_ns", self.fences[0]["evidence"]["observer"]["started_ns"] + 1)):
            self.fences = copy.deepcopy(original)
            self.fences[0]["evidence"][key] = value
            if key == "granted_ns":
                self.fences[0]["evidence"]["pool_released_ns"] = value + 999_999_999
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate()

    def test_both_original_grant_reads_and_unchanged_refusal_revision_required(self):
        original = copy.deepcopy(self.fences)
        for mutation in (lambda value: value["samples"].pop(),
                lambda value: value["samples"][0].update(started_ns=value["granted_ns"]),
                lambda value: value["samples"][1].update(available_bytes=None),
                lambda value: value.update(refused_revision=value["ready_revision"] + 1),
                lambda value: value.update(ready_revision=value["ready_revision"] + 1)):
            self.fences = copy.deepcopy(original)
            mutation(self.fences[0]["evidence"])
            with self.assertRaises(ValueError):
                self.validate()

    def test_inherited_physical_and_progress_proof_cannot_be_omitted(self):
        self.witnesses.pop()
        with self.assertRaises(ValueError):
            self.validate()
        self.setUp()
        self.events[4]["evidence"]["written_and_verified_bytes"] = 1
        with self.assertRaises(ValueError):
            self.validate()


if __name__ == "__main__":
    unittest.main()
