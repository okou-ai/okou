"""Shared original-snapshot input fixture for existing native preparation reports."""

import hashlib
import json

import report_test


def prepare(self):
    report_test.NativeReportTests.setUp(self)
    self.events = self.events[:24]
    self.samples = self.samples[:24]
    gib = 1024**3
    self.policy = {
        "host_total_bytes": 64*gib, "operating_floor_bytes": gib,
        "cleanup_reserve_bytes": 256*1024**2,
        "critical_available_bytes": 12*gib, "recovery_available_bytes": 20*gib,
        "live_growth_bytes": 4*1024**2, "tail_growth_bytes": 65*1024**2,
        "replacement_preparation_bytes": 32*1024**2, "max_sample_age_millis": 1000,
        "max_operations": 8, "max_cleanup_inflight": 2,
        "pressure_sample_period_millis": 50, "pressure_recovery_sustain_millis": 100,
        "pressure_wave_cooldown_millis": 100,
        "pressure_optional_start_interval_millis": 100, "pressure_max_wave_entries": 1,
    }
    self.inputs = {"snapshot_path": "/synthetic/snapshot/memory.bin",
                   "snapshot_memory_mb": 4096, "prefetch_overhead_bytes": 1024**2}
    raw_policy = json.dumps(self.policy)
    self.artifacts["policy_sha256"] = hashlib.sha256(raw_policy.encode()).hexdigest()
    self.events, self.samples = self.events[:12], self.samples[:12]
    for item in self.events+self.samples:
        item["monotonic_ns"] *= 100_000_000
    for sample in self.samples:
        for process in sample["processes"]:
            process["observed_monotonic_ns"] = sample["monotonic_ns"]
