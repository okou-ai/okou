"""Shared original-snapshot input fixture for existing native preparation reports."""

import hashlib
import json

import report_test


def prepare(self):
    report_test.NativeReportTests.setUp(self)
    self.events = self.events[:24]
    self.samples = self.samples[:24]
    self.policy = report_test.pressure_policy_fixture()
    self.inputs = {"snapshot_path": "/synthetic/snapshot/memory.bin",
                   "snapshot_memory_mb": 4096}
    raw_policy = json.dumps(self.policy)
    self.artifacts["policy_sha256"] = hashlib.sha256(raw_policy.encode()).hexdigest()
    self.events, self.samples = self.events[:12], self.samples[:12]
    for item in self.events+self.samples:
        item["monotonic_ns"] *= 100_000_000
    for sample in self.samples:
        for process in sample["processes"]:
            process["observed_monotonic_ns"] = sample["monotonic_ns"]
