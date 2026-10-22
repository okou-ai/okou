#!/usr/bin/env python3
"""Validate original live-helper/control/capsule records without saving credit."""
import argparse
import json
import pathlib
import re
import struct

import claim_producer_report as retained
import guest_preparation_report as preparation
import pressure_report as pressure
from startup_report import exact


def terminal(value, sequence=None):
    seq, data = preparation.original_frame(value, 0x1b, sequence)
    if (len(data) < 23 or data[0] != 0 or data[9:15] != b"\x01\0\0\0\0\0"
            or data[15:17] != b"\x01\0"):
        raise ValueError("running helper terminal is not complete captured Exited")
    code = int.from_bytes(data[1:5], "big", signed=True)
    size = int.from_bytes(data[17:21], "big")
    if code not in (0,1) or size > 65536 or len(data) != size+23 or data[-2:] != b"\0\0":
        raise ValueError("running helper terminal capture/diagnostic changed")
    return seq, code, data[21:21+size]


def wire(value, kind, sequence=None, **context):
    if kind == 0x1a:
        return preparation.fixed_wire(value, kind, sequence, **context)
    return terminal(value, sequence)[0]


def packet(raw, nonce, sequence, response):
    data = preparation.blob(raw, 16388)
    if len(data) < 5 or int.from_bytes(data[:4], "big") != len(data)-4 or len(data)-4 > 16384:
        raise ValueError("invalid original control framing")
    value = json.loads(data[4:], object_pairs_hook=pressure.unique_object)
    fields = {"nonce","id","result" if response else "command"}
    if sequence == 0:
        fields = {"nonce","id","ready","uid","original","executable","kernel"}
    if (not isinstance(value,dict) or set(value) != fields or value["nonce"] != nonce
            or type(value["id"]) is not int or value["id"] != sequence):
        raise ValueError("foreign/ambiguous original control identity")
    return value


def control_records(waiting, held, joined, request, response, allow, directory):
    records = (waiting, held, joined)
    nonce = waiting.get("nonce") if isinstance(waiting,dict) else None
    if not isinstance(nonce,str) or not re.fullmatch("[0-9a-f]{32}",nonce):
        raise ValueError("original running invocation nonce missing")
    pid = waiting.get("guest_pid")
    if type(pid) is not int or pid <= 0:
        raise ValueError("original controller process missing")
    previous = {}
    for record, count in zip(records,(1,2,4)):
        keys = {"response-0"} | {f"{kind}-{n}" for kind in ("request","response") for n in range(1,count+1)}
        if (not isinstance(record,dict) or set(record) != {"nonce","frames","guest_pid","process_terminal"}
                or record["nonce"] != nonce or type(record["guest_pid"]) is not int or record["guest_pid"] != pid
                or not isinstance(record["frames"],dict) or set(record["frames"]) != keys
                or any(record["frames"].get(k) != v for k,v in previous.items())):
            raise ValueError("original running frames/owner changed or replayed")
        if count < 4 and record["process_terminal"] is not None:
            raise ValueError("running controller completed before held acknowledgement")
        previous = record["frames"]
    frames = joined["frames"]
    files = pathlib.Path(directory)/"permission-control"
    if files.is_symlink() or not files.is_dir():
        raise ValueError("original control directory missing or substituted")
    for name,raw in frames.items():
        if retained.regular(files/(name+".bin"),16388) != preparation.blob(raw,16388):
            raise ValueError("original control file differs from phase record")
    exact(json.loads(retained.regular(files/"controller-terminal.json",300000),object_pairs_hook=pressure.unique_object),
          joined["process_terminal"],"original process terminal file differs")
    hello = packet(frames["response-0"],nonce,0,True)
    if hello["ready"] is not True or type(hello["uid"]) is not int or hello["uid"] != 0:
        raise ValueError("controller was not root and armed")
    if not isinstance(hello["kernel"],str) or not 0 < len(hello["kernel"]) <= 256:
        raise ValueError("actual Guest kernel identity missing")
    for key in ("original","executable"):
        item=hello[key]
        if (not isinstance(item,dict) or set(item) != {"device","inode","uid","size","links","mtime_ns","ctime_ns"}
                or any(type(v) is not int or v < 0 for v in item.values())
                or not item["inode"] or not item["links"] or item["uid"] != 0):
            raise ValueError("original regular-file/executable identity malformed")
    if hello["original"]["size"] > 4096 or hello["executable"]["size"] == 0:
        raise ValueError("invalid canonical original size")
    commands = ({"op":"observe"},{"op":"status"},{"op":"decide","event_id":1,"allow":allow},{"op":"retire"})
    answers = []
    for n, command in enumerate(commands,1):
        exact(packet(frames[f"request-{n}"],nonce,n,False)["command"],command,"control command changed")
        answers.append(packet(frames[f"response-{n}"],nonce,n,True)["result"])
    observed,status,decision,retired = answers
    if not isinstance(observed,dict) or set(observed) != {"event_id","event","executable","argv"}:
        raise ValueError("original running observation missing")
    exact(observed["event_id"],1,"foreign event token")
    exact(observed["executable"],hello["executable"],"canonical executable changed")
    seq,payload = preparation.original_frame(request,0x1a)
    _,seconds,nanos,_,_ = struct.unpack(">IQIBH",payload[:19])
    exact(observed["argv"],["/sbin/guest-state-restore","--restore-state",str(seconds),str(nanos),"required","UTC"],"canonical argv changed")
    event = observed["event"]
    if (not isinstance(event,dict) or set(event) != {"raw_hex","device","inode","pid","observed_ns"}
            or any(type(event[k]) is not int or event[k] <= 0 for k in ("device","inode","pid","observed_ns"))
            or event["pid"] == pid):
        raise ValueError("original helper event identity malformed")
    raw = preparation.blob(event.get("raw_hex"),32)
    if len(raw) != 32:
        raise ValueError("original kernel PIDFD record missing")
    kernel = struct.unpack("=IBBHQiiBBHi",raw)
    if (kernel[:5] != (32,3,0,24,65536) or kernel[5] < 0 or kernel[6] <= 0
            or kernel[6] != event.get("pid") or kernel[7:10] != (4,0,8) or kernel[10] < 0
            or event.get("device") != hello["original"].get("device")
            or event.get("inode") != hello["original"].get("inode")):
        raise ValueError("original live producer/inode/PIDFD changed")
    exact(status.get("held"),True,"held work disappeared after cancellation")
    if set(status) != {"held","original","payload_hex","observed_ns"}:
        raise ValueError("held-state response changed")
    exact(status.get("original"),hello["original"],"held original changed")
    if len(preparation.blob(status.get("payload_hex"),4096)) != hello["original"].get("size"):
        raise ValueError("original held bytes missing")
    exact(decision.get("event"),event,"decided a foreign event")
    if set(decision) != {"event","decision","event_descriptors_closed","response_started_ns","response_completed_ns"}:
        raise ValueError("decision response changed")
    exact(decision.get("decision"),"allow" if allow else "deny","decision changed")
    exact(decision.get("event_descriptors_closed"),True,"event descriptors retained")
    for key in ("mark_removed","group_closed","original_duplicate_closed"):
        exact(retired.get(key),True,"gate retirement incomplete")
    exact(retired.get("denied"),[],"additional uncontrolled producer")
    exact(retired.get("observation_failed"),False,"kernel observation failed")
    if set(retired) != {"started_ns","completed_ns","denied","mark_removed","group_closed","original_duplicate_closed","observation_failed"}:
        raise ValueError("retirement response changed")
    clocks = [event.get("observed_ns"),status.get("observed_ns"),decision.get("response_started_ns"),
              decision.get("response_completed_ns"),retired.get("started_ns"),retired.get("completed_ns")]
    if (any(type(v) is not int or v <= 0 for v in clocks) or any(a>b for a,b in zip(clocks,clocks[1:]))
            or clocks[0] == clocks[1] or clocks[1] == clocks[2] or clocks[4] == clocks[5]):
        raise ValueError("running Guest phase clocks changed")
    _,code,stderr = terminal(response,seq)
    if code != (0 if allow else 1) or (not stderr if not allow else bool(stderr)):
        raise ValueError("actual helper outcome disagrees with decision")
    if not allow and (b"guest timezone sync failed" not in stderr or b"os error 1" not in stderr):
        raise ValueError("deny is not the original permission failure")
    result = joined["process_terminal"]
    if not isinstance(result,dict):
        raise ValueError("original controller terminal missing")
    exact(result,{"guest_pid":pid,"termination":"Exited { exit_code: 0 }",
        "stdout_hex":result.get("stdout_hex"),"stderr_hex":result.get("stderr_hex"),
        "stdout_truncated":False,"stderr_truncated":False,"stream_overflowed":False,"diagnostic":""},
        "controller process not positively joined with complete capture")
    for key in ("stdout_hex","stderr_hex"):
        preparation.blob(result[key],65536)


CONTRACT = preparation.Contract("RunningRestore",wire)
PREFIX,CASES = CONTRACT.prefix,CONTRACT.cases


def validate(directory):
    return preparation.validate(directory,CONTRACT)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory",type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory),indent=2,sort_keys=True))
