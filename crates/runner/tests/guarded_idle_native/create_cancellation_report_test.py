#!/usr/bin/env python3
"""Real-file/CLI refusals for actual native create cancellation receipts."""

import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import create_cancellation_report as create
import read_cancellation_report_test
import report
import startup_report as startup


class CreateCancellationTests(unittest.TestCase):
    def setUp(self):
        read_cancellation_report_test.ReadCancellationTests.setUp(self)
        raw=json.dumps(self.inputs)
        self.collector["metadata"].update(native_create_cancellation_policy_json=json.dumps(self.policy),
            native_create_cancellation_inputs_json=raw,native_create_cancellation_snapshot_bytes=startup.BYTES)
        self.witnesses=[]
        block=bytearray(1024); block[56:58]=b"\x53\xef"
        for index,case in enumerate(sorted(create.CASES)):
            terminal=self.events[index*6:index*6+6]
            for item in terminal: item["case"]=case
            base=terminal[1]["monotonic_ns"]
            def clock(ms): return base+ms*1_000_000
            growth=startup.BYTES+self.policy["replacement_preparation_bytes"]
            held={"registered_operations":1,"started":1,"ordinary_growth_bytes":growth,
                "cleanup_growth_bytes":0,"tracked_tasks":1,"uncertain":0}
            uncertain=dict(held,started=0,tracked_tasks=0,uncertain=1)
            path=f"/owned/workspaces/{uuid.uuid4()}/home.ext4"
            values=[
                {"policy":self.policy,"inputs_sha256":hashlib.sha256(raw.encode()).hexdigest(),
                 "snapshot_sha256":self.artifacts["snapshot_files"]["memory.bin"],"snapshot_bytes":startup.BYTES,
                 "prefetch_overhead_bytes":1024**2,"preparation_bytes":self.policy["replacement_preparation_bytes"],
                 "allocated":[2,4096,1],"checkpoint_models_stalled_storage":False},
                {"created":{"home_path":path,"home_bytes":report.NATIVE_HOME_BYTES,"ext4_magic":"53ef",
                    "superblock_hex":block.hex(),"superblock_sha256":hashlib.sha256(block).hexdigest(),"held_ns":clock(490)},
                 "state":"Ready","available_bytes":32*1024**3,"samples":[
                    {"started_ns":clock(ms),"finished_ns":clock(ms)+3,"read_start_offset_ns":ms*1_000_000,
                     "available_bytes":32*1024**3,"age_ns":2,"read_duration_ns":1} for ms in (200,400)],
                 "accounting":held,"allocated":[4,8192,2],"release_byte_withheld":True},
                {"cancelled_ns":clock(510),"first_dropped_ns":clock(520),"second_pending_ns":clock(530),
                 "foreground_acquired_ns":clock(540),"first_pending":True,"first_dropped":True,"second_pending":True,
                 "release_byte_withheld":True,"allocated":[4,8192,2],"accounting":copy.deepcopy(held),
                 "heartbeat":{"receipt":{"received_ns":clock(550),"acknowledgement_status":204,"state":{
                    "runnerId":str(uuid.uuid4()),"snapshotGeneration":1,"snapshotSequence":1,"group":"native-foreground",
                    "mode":"running","allocatedVcpu":4,"allocatedMemoryMb":8192}},"send_joined":True,"completed_ns":clock(560)},
                 "observer":{"started_ns":clock(570),"completed_ns":clock(580),"available_bytes":32*1024**3,"age_ns":2,"read_duration_ns":1,"joined":True}},
                {"completion":{"workspace":str(pathlib.PurePosixPath(path).parent),"workspace_absent":True,
                    "cleanup_ns":clock(650),"allocated":[4,8192,2],"accounting":copy.deepcopy(held)},
                 "release_ns":clock(610),"joined_ns":clock(690),"finished":True,"prepared":False,"published":False,
                 "retained_resource":False,"error":create.ERROR,"allocated":[2,4096,1],"accounting":uncertain},
                {"blank_shutdown_joined":True,"pressure_stopped":True,"heartbeat_joined":True,"provider_joined":True,
                 "peer_joined":True,"snapshot_reverified":True,"allocated":[2,4096,1],"accounting":copy.deepcopy(uncertain)},
                dict(uncertain,closed=True,allocated=[0,0,0]),
            ]
            for phase,value,ns in zip(create.PHASES,values,[clock(ms) for ms in (10,500,600,700,800)]+[terminal[4]["monotonic_ns"]+1]):
                self.witnesses.append({"version":1,"case":case,"phase":phase,"monotonic_ns":ns,"unix_ns":ns+1000,
                    "sandbox_id":terminal[1]["sandbox_id"],"backing_generation":terminal[1]["backing_generation"],"evidence":value})

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(v) for v in self.samples))
        (self.root/"stdout.log").write_text("\n".join([report.PREFIX+json.dumps(v) for v in self.events]+[create.PREFIX+json.dumps(v) for v in self.witnesses]))

    def validate(self):
        self.write(); return create.validate(self.root)

    def test_both_modes_preserve_uncertainty_and_claim_limits(self):
        value=self.validate()
        self.assertTrue(value["native_create_cancellation_complete"])
        self.assertFalse(value["production_protection_proven"])
        self.assertFalse(value["checkpoint_models_stalled_storage"])

    def test_cli_accepts_complete_and_rejects_missing_physical_join(self):
        self.write(); command=[sys.executable,str(pathlib.Path(__file__).with_name("create_cancellation_report.py")),str(self.root)]
        self.assertEqual(json.loads(subprocess.run(command,capture_output=True,text=True,check=True).stdout)["format"],"native-create-cancellation-report-v1")
        self.witnesses.pop(); self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def test_floating_available_bytes_cannot_substitute_for_original_integer(self):
        value=self.witnesses[1]["evidence"]
        value["available_bytes"]=float(value["available_bytes"])
        with self.assertRaises(ValueError): self.validate()

    def test_every_ownership_data_clock_and_completion_field_is_required(self):
        original=copy.deepcopy(self.witnesses)
        def leaves(value,path=()):
            if isinstance(value,dict):
                for key,item in value.items(): yield from leaves(item,path+(key,))
            elif isinstance(value,list):
                for index,item in enumerate(value): yield from leaves(item,path+(index,))
            else: yield path,value
        for index,event in enumerate(original[:6]):
            for path,value in leaves(event):
                target=copy.deepcopy(original); node=target[index]
                for key in path[:-1]: node=node[key]
                node[path[-1]]=(not value) if type(value) is bool else (-1 if type(value) is int else "corrupted")
                with self.subTest(index=index,path=path):
                    self.witnesses=target
                    with self.assertRaises((ValueError,KeyError,TypeError)): self.validate()

    def test_missing_duplicate_identity_and_real_file_source_are_refused(self):
        for index in range(len(self.witnesses)):
            original=copy.deepcopy(self.witnesses); self.witnesses.pop(index)
            with self.assertRaises(ValueError): self.validate()
            self.witnesses=original
        self.witnesses.append(copy.deepcopy(self.witnesses[-1]))
        with self.assertRaises(ValueError): self.validate()


if __name__ == "__main__": unittest.main()
