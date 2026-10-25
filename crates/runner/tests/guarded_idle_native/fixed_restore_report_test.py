#!/usr/bin/env python3
"""Original-file and real CLI negatives; synthetic fixtures are not native proof."""
import copy
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import unittest
import uuid

import claim_producer_report_test as fixture
import cleanup_report as cleanup
import fixed_restore_report as fixed
import report


class FixedRestoreReportTests(unittest.TestCase):
    def setUp(self):
        fixture.ClaimProducerReportTests.setUp(self)
        raw=self.collector["metadata"].pop("native_claim_producer_policy_json")
        self.collector["metadata"]["native_fixed_restore_policy_json"]=raw
        self.thread=str(uuid.uuid4())
        self.original=b'{"type":"session_meta","payload":{"id":"'+self.thread.encode()+b'"}}\n'
        self.session_path=f"/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-{self.thread}.jsonl"
        target=self.root/"seed"/self.session_path.removeprefix("/home/user/")
        target.parent.mkdir(parents=True)
        target.write_bytes(self.original)
        self.image=self.root/"retained-home.ext4"
        self.image.unlink()
        with self.image.open("wb") as stream:stream.truncate(report.NATIVE_HOME_BYTES)
        subprocess.run(["/usr/sbin/mke2fs","-q","-F","-t","ext4","-O","^has_journal","-d",str(self.root/"seed"),str(self.image)],check=True,capture_output=True)
        with self.image.open("rb") as stream:stream.seek(1024);block=stream.read(1024)
        home={"path":f"/var/tmp/native-case/workspaces/{self.ident}/home.ext4","bytes":report.NATIVE_HOME_BYTES,
              "filesystem_uuid":block[104:120].hex(),"superblock_sha256":hashlib.sha256(block).hexdigest()}
        at=lambda n:10_000_000_000+int(n*1_000_000)
        self.at=at
        template=copy.deepcopy(self.events[1])
        def event(phase,n,value):
            return template|dict(phase=phase,monotonic_ns=at(n),unix_ns=at(n)+1000,evidence=value)
        def wire(kind,data):
            raw=struct.pack(">IBI",5+len(data),kind,2)+data
            return dict(message_type=kind,sequence=2,raw_hex=raw.hex(),sha256=hashlib.sha256(raw).hexdigest())
        self.request=wire(0x1a,struct.pack(">IQIBH",300000,10,5500000,2,3)+b"UTC"+bytes(range(256)))
        self.response=wire(0x1b,bytes(5)+struct.pack(">I",3)+b"\x01\0"+bytes(4)+b"\x01\0"+bytes(4)+bytes(2))
        physical={"path":self.session_path,"bytes":len(self.original),"sha256":hashlib.sha256(self.original).hexdigest(),"raw_hex":self.original.hex()}
        heartbeat=copy.deepcopy(self.witnesses[2]["evidence"]["heartbeat"])
        heartbeat["receipt"].update(received_ns=at(16))
        heartbeat["completed_ns"]=at(17)
        self.values=[
            {"history_run_id":self.history,"thread_id":self.thread,"history_hex":self.original.hex(),
             "history_sha256":hashlib.sha256(self.original).hexdigest(),"history_bytes":len(self.original),
             "physical_history":physical,"final_identity_verified":True,"executor_completed":True,"exit_code":0},
            {"history_run_id":self.history,"payload_sha256":hashlib.sha256(self.payload).hexdigest(),"payload_bytes":65536,
             "original_private_and_home_verified":True,"guest_sync_completed":True},
            {"history_run_id":self.history,"operation_run_id":self.run,"prepare_started_ns":at(5),
             "request":self.request,"backend_dispatched":False,"canonical_fixed_helper":True}|fixed.LEASE,
            {"boundary":"capture","request":self.request,"response":None,"public_restore_polled_pending":True,"running_helper_observed":False}|fixed.LEASE,
            {"lost_ns":at(8),"observer_unwound":False,"state":"Uncertain","commit_refused":True,"repark_refused":True,
             "incoming_refused":True,"original_metadata_preserved":True,"pool_empty":True,"original_exit_polled_pending":True}|fixed.LEASE,
            {"pool_held_ns":at(10),"status_held_ns":at(11),"heartbeat_pending_ns":at(12),
             "observer":{"started_ns":at(13),"completed_ns":at(14),"available_bytes":32*1024**3,"age_ns":2,"read_duration_ns":1,"joined":True},
             "pool_released_ns":at(15),"heartbeat":heartbeat,"status_released_ns":at(18),"sample_after_ns":at(18)+2,"p1_sample_ns":at(19),
             "status_wait_polled_ns":at(11)+1,"status_waits_before":0,"status_waits_after":1,"status_published_ns":at(18)+1,
             "selected_delivery_withheld":True,"additional_full_profile_refused":True}|fixed.LEASE,
            {"request":self.request,"response":self.response,"delivery_requested_ns":at(21),"joined_ns":at(22),
             "canonical_helper_exited_zero":True,"helper_stdin_stderr_joined":True,"exchange_joined":True,"transport_producer_unwound":False,
             "connection_retained_pending":True,"running_helper_observed":False,"ordinary_reuse_reopened":False}|fixed.LEASE,
            {"error":"sandbox home mount failed: normal operations are not available on this connection",
             "normal_operations_not_parkable":True,"completed_lease_refused":True,"required_saving_complete":False,"cleanup_complete":False,"original_home":home}|fixed.LEASE,
            {"original_home":home,"promotion_lock_busy":True,"promotion_probe_run_id":str(uuid.uuid4()),"promotion_probe_sandbox_id":str(uuid.uuid4()),
             "original_capsule_retained":True,"original_session_history_retained":True,"original_backing_retained":True,
             "original_exit_polled_pending":True,"tracker_joined":True,"heartbeat_provider_peer_joined":True,
             "accounting":dict.fromkeys(cleanup.COUNTS,0)|{"registered_operations":2,"uncertain":2,
                 "cleanup_growth_bytes":self.policy["live_growth_bytes"]+self.policy["tail_growth_bytes"],"closed":True},
             "required_saving_complete":False,"cleanup_complete":False,"physical_relief_proven":False,"memory_credit":False,
             "running_helper_boundary":"blocked","preterminal_acceptance_boundary":"blocked","original_cleanup_io_progress":"blocked_not_parkable"}|fixed.LEASE,
        ]
        self.witnesses=[event(phase,n,value) for phase,n,value in zip(fixed.PHASES,(2,3,6,7,9,20,23,24,25),self.values)]
        self.events=[event("case_started",0,{"artifacts":self.artifacts}),event("terminal_started",4,{})]
        self.events[0].update(sandbox_id=None,backing_generation=None)
        self.continuation=event("original_executor_completed",1,{"original_run_id":self.history,"thread_id":self.thread,
            "original_history_sha256":hashlib.sha256(self.original).hexdigest(),"original_history_bytes":len(self.original),
            "exit_code":0,"final_identity_verified":True,"full_original_prefix_verified":True,
            "preparation_observed_by_native_process":True,"original_full_lease_witness":True})
        sample=copy.deepcopy(self.samples[0]);self.samples=[]
        for n in (6.5,12,19,22,24.5):
            reading=copy.deepcopy(sample);reading["monotonic_ns"]=at(n);reading["processes"][0]["observed_monotonic_ns"]=at(n)
            self.samples.append(reading)
        self.select("FixedRestore-capture-drop-fresh")

    def select(self,case):
        for event in [*self.events,*self.witnesses,self.continuation]:event["case"]=case
        terminal=case.startswith("FixedRestore-terminal-")
        self.values[3].update(boundary="terminal" if terminal else "capture",response=self.response if terminal else None)
        self.values[4]["observer_unwound"]="-observer-unwind-" in case
        unwind="-producer-unwind-" in case
        self.values[6].update(exchange_joined=not unwind,transport_producer_unwound=unwind,connection_retained_pending=not unwind)

    def write(self):
        (self.root/"report.json").write_text(json.dumps(self.collector))
        (self.root/"samples.jsonl").write_text("\n".join(json.dumps(v) for v in self.samples))
        lines=[report.PREFIX+json.dumps(self.events[0]),"NATIVE_CONTINUATION_WITNESS "+json.dumps(self.continuation)]
        lines += [fixed.PREFIX+json.dumps(v) for v in self.witnesses[:2]]
        lines += [report.PREFIX+json.dumps(self.events[1])]
        lines += [fixed.PREFIX+json.dumps(v) for v in self.witnesses[2:]]
        (self.root/"stdout.log").write_text("\n".join(lines)+"\ntest result: FAILED\n")
        (self.root/"stderr.log").write_text("Error: FixedRestoreUncertain\n")

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

    def test_failed_wire_result_and_changed_fixed_input_are_rejected_even_with_new_hash(self):
        for value,offset in ((self.request,9),(self.request,13),(self.response,10)):
            with self.subTest(frame=value["message_type"]):
                original=copy.deepcopy(value);raw=bytearray.fromhex(value["raw_hex"]);raw[offset]^=1
                value.update(raw_hex=raw.hex(),sha256=hashlib.sha256(raw).hexdigest())
                with self.assertRaises(ValueError):self.validate()
                value.clear();value.update(original)


if __name__=="__main__":unittest.main()
