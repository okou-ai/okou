#!/usr/bin/env python3
"""Synthetic original-file/CLI regressions; these are not native execution."""
import copy
import json
import pathlib
import struct
import subprocess
import sys
import unittest

import fixed_restore_report_test as original
import running_restore_report as running


class RunningRestoreReportTests(unittest.TestCase):
    select = original.FixedRestoreReportTests.select

    def setUp(self):
        original.FixedRestoreReportTests.setUp(self)
        raw = self.collector["metadata"].pop("native_fixed_restore_policy_json")
        self.collector["metadata"]["native_running_restore_policy_json"] = raw
        self.choose("RunningRestore-allow-drop-fresh")

    def choose(self, case):
        original.FixedRestoreReportTests.select(self,case)
        allow = "-allow-" in case
        self.values[3].update(boundary="running",running_helper_observed=True)
        self.values[6].update(canonical_helper_exited_zero=allow,running_helper_observed=True)
        self.values[6].pop("running_controller_joined_before_delivery_ns",None)
        if "-producer-unwind-" in case:
            self.values[6]["running_controller_joined_before_delivery_ns"] = self.at(20.5)
        self.values[8]["running_helper_boundary"] = "observed"
        nonce = "1"*32
        identity = dict(device=4,inode=12,uid=0,size=4,links=1,mtime_ns=1,ctime_ns=1)
        executable = identity|dict(inode=99,size=110)
        kernel = struct.pack("=IBBHQiiBBHi",32,3,0,24,65536,7,432,4,0,8,8)
        event = dict(raw_hex=kernel.hex(),device=4,inode=12,pid=432,observed_ns=10)
        observed = dict(event_id=1,event=event,executable=executable,
                        argv=["/sbin/guest-state-restore","--restore-state","10","5500000","required","UTC"])
        answers = [dict(nonce=nonce,id=0,ready=True,uid=0,original=identity,executable=executable,kernel="6.18.44+"),
            dict(nonce=nonce,id=1,result=observed),
            dict(nonce=nonce,id=2,result=dict(held=True,original=identity,payload_hex=b"UTC\n".hex(),observed_ns=20)),
            dict(nonce=nonce,id=3,result=dict(event=event,decision="allow" if allow else "deny",
                event_descriptors_closed=True,response_started_ns=30,response_completed_ns=40)),
            dict(nonce=nonce,id=4,result=dict(mark_removed=True,group_closed=True,original_duplicate_closed=True,
                denied=[],observation_failed=False,started_ns=50,completed_ns=60))]
        def frame(value):
            data=json.dumps(value,separators=(",",":")).encode()
            return (struct.pack("!I",len(data))+data).hex()
        frames={"response-0":frame(answers[0])}
        commands=[dict(op="observe"),dict(op="status"),dict(op="decide",event_id=1,allow=allow),dict(op="retire")]
        for n,command in enumerate(commands,1):
            frames[f"request-{n}"]=frame(dict(nonce=nonce,id=n,command=command))
            frames[f"response-{n}"]=frame(answers[n])
        terminal=dict(guest_pid=431,termination="Exited { exit_code: 0 }",stdout_hex="",stderr_hex="",
                      stdout_truncated=False,stderr_truncated=False,stream_overflowed=False,diagnostic="")
        for value,count in zip((self.values[3],self.values[4],self.values[6]),(1,2,4)):
            value["running_control"]=dict(nonce=nonce,guest_pid=431,process_terminal=terminal if count==4 else None,
                frames={key:raw for key,raw in frames.items() if int(key.split("-")[1])<=count})
        if not allow:
            import hashlib
            stderr=b"guest timezone sync failed: permission denied (os error 1)"
            data=b"\0"+struct.pack(">iI",1,3)+b"\x01\0"+bytes(4)+b"\x01\0"+struct.pack(">I",len(stderr))+stderr+bytes(2)
            raw=struct.pack(">IBI",5+len(data),0x1b,2)+data
            self.values[6]["response"]=dict(message_type=0x1b,sequence=2,raw_hex=raw.hex(),sha256=hashlib.sha256(raw).hexdigest())
        else:
            self.values[6]["response"]=copy.deepcopy(self.response)

    def write(self):
        original.FixedRestoreReportTests.write(self)
        stdout=self.root/"stdout.log"
        stdout.write_text(stdout.read_text().replace("NATIVE_FIXED_RESTORE_WITNESS ",running.PREFIX))
        (self.root/"stderr.log").write_text("Error: RunningRestoreUncertain\n")
        files=self.root/"permission-control";files.mkdir(exist_ok=True)
        record=self.values[6]["running_control"]
        for name,raw in record["frames"].items():(files/(name+".bin")).write_bytes(bytes.fromhex(raw))
        (files/"controller-terminal.json").write_text(json.dumps(record["process_terminal"]))

    def test_all_running_modes_faults_and_decisions_preserve_original_failed_outcome(self):
        for case in sorted(running.CASES):
            with self.subTest(case=case):
                self.choose(case);self.write()
                value=running.validate(self.root)
                self.assertTrue(value["running_helper_observed"])
                self.assertTrue(value["original_complete_data_verified"])
                self.assertEqual(value["original_driver_exit_code"],101)
                self.assertFalse(value["required_saving_complete"])

    def test_foreign_replayed_or_incomplete_control_and_capsule_are_rejected(self):
        baseline=copy.deepcopy(self.witnesses)
        changes=[lambda v:v[3]["evidence"].update(running_helper_observed=False),
            lambda v:v[3]["evidence"].update(boundary="terminal"),
            lambda v:v[4]["evidence"]["running_control"].update(nonce="2"*32),
            lambda v:v[4]["evidence"]["running_control"]["frames"].update({"response-1":"00"}),
            lambda v:v[6]["evidence"]["running_control"]["process_terminal"].update(stdout_truncated=True),
            lambda v:v[6]["evidence"]["running_control"]["frames"].pop("response-4"),
            lambda v:v[4]["evidence"].update(allocated=[0,0,0]),
            lambda v:v[8]["evidence"].update(required_saving_complete=True)]
        for change in changes:
            self.witnesses=copy.deepcopy(baseline);change(self.witnesses);self.write()
            with self.assertRaises((ValueError,KeyError)):running.validate(self.root)

    def test_late_transport_unwind_requires_failed_joins_and_prior_controller_join(self):
        self.choose("RunningRestore-deny-producer-unwind-snapshot")
        baseline=copy.deepcopy(self.witnesses)
        changes=[lambda v:v[6]["evidence"].update(exchange_joined=True),
            lambda v:v[6]["evidence"].update(transport_producer_unwound=False),
            lambda v:v[6]["evidence"].update(connection_retained_pending=True),
            lambda v:v[6]["evidence"].pop("running_controller_joined_before_delivery_ns"),
            lambda v:v[6]["evidence"].update(running_controller_joined_before_delivery_ns=self.at(21)),
            lambda v:v[6]["evidence"].update(running_controller_joined_before_delivery_ns=self.at(19)),
            lambda v:v[6]["evidence"]["running_control"]["process_terminal"].update(termination="Cancelled")]
        for index,change in enumerate(changes):
            with self.subTest(change=index):
                self.witnesses=copy.deepcopy(baseline)
                self.values=[v["evidence"] for v in self.witnesses]
                change(self.witnesses);self.write()
                with self.assertRaises(ValueError):running.validate(self.root)

    def test_real_cli_checks_control_bytes_and_original_image(self):
        self.write()
        command=[sys.executable,"-B",str(pathlib.Path(running.__file__)),str(self.root)]
        result=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(json.loads(result.stdout)["running_helper_observed"])
        # A consistent forgery in every snapshot must still fail the original
        # kernel record, rather than only failing prefix continuity.
        for value in (self.values[3],self.values[4],self.values[6]):
            frames=value["running_control"]["frames"]
            raw=bytes.fromhex(frames["response-1"])
            reply=json.loads(raw[4:]);reply["result"]["event"]["pid"]+=1
            data=json.dumps(reply,separators=(",",":")).encode()
            frames["response-1"]=(struct.pack("!I",len(data))+data).hex()
        self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
        self.choose("RunningRestore-allow-drop-fresh")
        self.values[6]["running_control"]["frames"]["response-3"]="00";self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
        self.choose("RunningRestore-deny-producer-unwind-snapshot");self.write()
        result=subprocess.run(command,capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.values[6].pop("running_controller_joined_before_delivery_ns");self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)
        self.choose("RunningRestore-deny-observer-unwind-snapshot");self.write()
        with (self.root/"retained-home.ext4").open("r+b") as stream:
            stream.seek(1024);stream.write(bytes(1024))
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)


if __name__ == "__main__":
    unittest.main()
