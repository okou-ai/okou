#!/usr/bin/env python3
"""Real-file/CLI acceptance and exhaustive receipt refusals for returned Guests."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import snapshot_report_fixture
import report
import returned_guest_report as returned
import snapshot_report as startup


class ReturnedGuestTests(unittest.TestCase):
    def setUp(self):
        snapshot_report_fixture.prepare(self)
        raw = json.dumps(self.inputs)
        self.collector["metadata"].update(native_returned_guest_policy_json=json.dumps(self.policy),
            native_returned_guest_inputs_json=raw, native_returned_guest_snapshot_bytes=startup.BYTES)
        template, sample_template = copy.deepcopy(self.events[:6]), copy.deepcopy(self.samples[:6])
        self.events, self.samples, self.witnesses = [], [], []
        for index, case in enumerate(sorted(returned.CASES)):
            terminal = copy.deepcopy(template)
            original_id, original_backing = str(uuid.uuid4()), str(uuid.uuid4())
            for item in terminal:
                item.update(case=case, sandbox_id=original_id, backing_generation=original_backing)
                item["monotonic_ns"] += index*10_000_000_000
            self.events.extend(terminal)
            for sample in copy.deepcopy(sample_template):
                sample["monotonic_ns"] += index*10_000_000_000
                for process in sample["processes"]:
                    process["observed_monotonic_ns"] = sample["monotonic_ns"]
                self.samples.append(sample)
            base = terminal[1]["monotonic_ns"]
            def clock(ms): return base+ms*1_000_000
            growth = startup.BYTES+self.policy["replacement_preparation_bytes"]
            held = {"registered_operations": 1, "started": 1, "ordinary_growth_bytes": growth,
                    "cleanup_growth_bytes": 0, "tracked_tasks": 1, "uncertain": 0}
            uncertain = dict(held, started=0, tracked_tasks=0, uncertain=1)
            cleaning = dict(uncertain, registered_operations=2, started=1, tracked_tasks=1,
                            cleanup_growth_bytes=self.policy["tail_growth_bytes"])
            sandbox_id, backing, runner = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
            stage = case.split("-")[1]
            block = bytearray(1024)
            block[56:58], block[104:120] = b"\x53\xef", uuid.uuid4().bytes
            path = f"/owned/workspaces/{sandbox_id}/home.ext4"
            home = {"path": path, "bytes": report.NATIVE_HOME_BYTES, "ext4_magic": "53ef",
                    "filesystem_uuid": block[104:120].hex(), "superblock_hex": block.hex(),
                    "superblock_sha256": hashlib.sha256(block).hexdigest()}
            created = {"sandbox_id": sandbox_id, "returned_ns": clock(450), "home": home}
            stages = [{"stage": label, "completed_ns": clock(460+i), "sandbox_id": sandbox_id,
                       "backing_generation": backing, "actual_success": True, "home": copy.deepcopy(home)}
                      for i, label in enumerate(returned.STAGES[:returned.STAGES.index(stage)+1])]
            actual = {"created": created, "stages": stages, "cleanup": None}
            def observer(ms):
                return {"started_ns": clock(ms), "completed_ns": clock(ms+5), "available_bytes": 32*1024**3,
                        "age_ns": 2, "read_duration_ns": 1, "joined": True}
            def heartbeat(ms, sequence):
                return {"receipt": {"received_ns": clock(ms), "acknowledgement_status": 204, "state": {
                    "runnerId": runner, "snapshotGeneration": 1, "snapshotSequence": sequence,
                    "group": "native-foreground", "mode": "running", "allocatedVcpu": 4, "allocatedMemoryMb": 8192}},
                    "send_joined": True, "completed_ns": clock(ms+5)}
            def result(retained):
                label = "home_mount" if stage == "mount" else stage
                return {"finished": True, "prepared": False, "published": False, "retained_resource": retained,
                        "error": f"{label}: optional work cancelled; resource retained"}
            completion = {"sandbox_id": sandbox_id, "backing_generation": backing, "positive_backing_wait": True,
                          "workspace": str(pathlib.PurePosixPath(path).parent), "workspace_absent": True,
                          "last_home": copy.deepcopy(home), "cleanup_ns": clock(750),
                          "allocated": [4,8192,2], "accounting": cleaning}
            cleanup_actual = dict(copy.deepcopy(actual), cleanup=completion)
            values = [
                {"policy": self.policy, "inputs_sha256": hashlib.sha256(raw.encode()).hexdigest(),
                 "snapshot_sha256": self.artifacts["snapshot_files"]["memory.bin"], "snapshot_bytes": startup.BYTES,
                 "prefetch_overhead_bytes": 1024**2, "stage": stage, "allocated": [2,4096,1], "checkpoint_models_stalled_io": False},
                {"pool_pending_ns": clock(20), "foreground_acquired_ns": clock(30), "joined_ns": clock(40),
                 "pool_released_ns": clock(80), "wait_pending": True, "wait_dropped": True, "no_provider_create": True,
                 "result": {"finished": True, "prepared": False, "published": False, "retained_resource": False,
                            "error": "optional pool wait cancelled"}, "observer": observer(50),
                 "allocated": [2,4096,1], "accounting": returned.ZERO},
                {"actual": actual, "samples": [{"started_ns": clock(ms), "finished_ns": clock(ms)+3,
                    "read_start_offset_ns": ms*1_000_000, "available_bytes": 32*1024**3, "age_ns": 2, "read_duration_ns": 1}
                    for ms in (200,400)], "available_bytes": 32*1024**3,
                 "allocated": [4,8192,2], "accounting": held, "release_byte_withheld": True},
                {"cancelled_ns": clock(510), "first_dropped_ns": clock(520), "second_pending_ns": clock(530),
                 "foreground_acquired_ns": clock(540), "first_pending": True, "first_dropped": True, "second_pending": True,
                 "release_byte_withheld": True, "allocated": [4,8192,2], "accounting": copy.deepcopy(held),
                 "heartbeat": heartbeat(550,1), "observer": observer(570)},
                {"released_ns": clock(610), "joined_ns": clock(690), "result": result(True), "allocated": [4,8192,2], "accounting": uncertain},
                {"actual": cleanup_actual, "pending_ns": clock(760), "invalid_mode": "Draining", "cleanup_pending": True,
                 "release_byte_withheld": True, "result": result(True), "allocated": [4,8192,2],
                 "accounting": copy.deepcopy(cleaning), "heartbeat": heartbeat(770,2), "observer": observer(780)},
                {"release_ns": clock(810), "joined_ns": clock(840), "positive_backing_wait": True, "blank_count": 0,
                 "result": result(False), "allocated": [2,4096,1], "accounting": copy.deepcopy(uncertain)},
                {"optional_joined": True, "pressure_stopped": True, "heartbeat_joined": True, "provider_joined": True,
                 "peer_joined": True, "snapshot_reverified": True, "allocated": [2,4096,1], "accounting": copy.deepcopy(uncertain)},
                dict(uncertain, closed=True, allocated=[0,0,0]),
            ]
            clocks = [clock(ms) for ms in (10,100,500,600,700,800,850,900)]+[terminal[4]["monotonic_ns"]+1]
            for phase, value, ns in zip(returned.PHASES, values, clocks):
                self.witnesses.append({"version": 1, "case": case, "phase": phase, "monotonic_ns": ns, "unix_ns": ns+1000,
                    "sandbox_id": original_id, "backing_generation": original_backing, "evidence": value})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(v) for v in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(v) for v in self.events]
            +[returned.PREFIX+json.dumps(v) for v in self.witnesses]))

    def validate(self):
        self.write()
        return returned.validate(self.root)

    def test_all_six_actual_stages_keep_claim_limits(self):
        value = self.validate()
        self.assertEqual(set(value["cases"]), returned.CASES)
        self.assertTrue(value["native_returned_guest_complete"])
        self.assertFalse(value["production_protection_proven"])
        self.assertFalse(value["checkpoint_models_stalled_io"])

    def test_cli_accepts_complete_and_refuses_missing_physical_join(self):
        self.write()
        command = [sys.executable, str(pathlib.Path(__file__).with_name("returned_guest_report.py")), str(self.root)]
        self.assertEqual(json.loads(subprocess.run(command, capture_output=True, text=True, check=True).stdout)["format"], "native-returned-guest-report-v1")
        self.witnesses.pop()
        self.write()
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_every_original_ownership_clock_byte_and_join_field_is_required(self):
        original = copy.deepcopy(self.witnesses)
        def leaves(value, path=()):
            if isinstance(value, dict):
                for key, item in value.items(): yield from leaves(item, path+(key,))
            elif isinstance(value, list):
                for index, item in enumerate(value): yield from leaves(item, path+(index,))
            else: yield path, value
        for index, event in enumerate(original[:9]):
            for path, value in leaves(event):
                self.witnesses = copy.deepcopy(original)
                node = self.witnesses[index]
                for key in path[:-1]: node = node[key]
                node[path[-1]] = not value if type(value) is bool else (-1 if type(value) is int else "corrupted")
                with self.subTest(index=index, path=path):
                    with self.assertRaises((ValueError, KeyError, TypeError)): self.validate()

    def test_all_missing_duplicate_and_out_of_order_phases_are_refused(self):
        original = copy.deepcopy(self.witnesses)
        for index in range(len(original)):
            self.witnesses = copy.deepcopy(original)
            self.witnesses.pop(index)
            with self.assertRaises(ValueError): self.validate()
        self.witnesses = copy.deepcopy(original)
        self.witnesses.append(copy.deepcopy(original[-1]))
        with self.assertRaises(ValueError): self.validate()

    def test_floating_lease_and_growth_values_are_refused(self):
        for index, path in ((2,("allocated",1)), (3,("accounting","ordinary_growth_bytes")), (5,("accounting","cleanup_growth_bytes"))):
            original = copy.deepcopy(self.witnesses)
            node = self.witnesses[index]["evidence"]
            for key in path[:-1]: node = node[key]
            node[path[-1]] = float(node[path[-1]])
            with self.assertRaises(ValueError): self.validate()
            self.witnesses = original

    def test_self_consistent_replayed_home_generation_is_refused(self):
        replayed = self.witnesses[2]["evidence"]["actual"]["created"]["home"]["filesystem_uuid"]
        for index in (11,14):
            actual = self.witnesses[index]["evidence"]["actual"]
            homes = [actual["created"]["home"], *(s["home"] for s in actual["stages"])]
            if actual["cleanup"] is not None:
                homes.append(actual["cleanup"]["last_home"])
            for value in homes:
                block = bytearray.fromhex(value["superblock_hex"])
                block[104:120] = bytes.fromhex(replayed)
                value.update(filesystem_uuid=replayed, superblock_hex=block.hex(),
                             superblock_sha256=hashlib.sha256(block).hexdigest())
        with self.assertRaisesRegex(ValueError, "generation replayed"):
            self.validate()


if __name__ == "__main__": unittest.main()
