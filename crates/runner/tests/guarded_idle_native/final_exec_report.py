#!/usr/bin/env python3
"""Validate genuine final-exec retained custody without inventing running or saving."""
import argparse
import json
import pathlib

import guest_preparation_report as preparation
import pressure_report as pressure

PHASES = preparation.PHASES
LEASE = preparation.LEASE
COMMAND = ('set +e\n(\nset -eu\n'
           '/sbin/guest-home-mount\n) </dev/null >/dev/null\nmount_status=$?\nset -e\n'
           'if [ "$mount_status" -ne 0 ]; then\n  exit 6\nfi\n/usr/local/bin/guest-agent prepare-for-reuse')
LABEL = b"idle-reuse-preparation-and-park"


class Payload:
    def __init__(self, data):
        self.data, self.offset = data, 0

    def take(self, size):
        if size < 0 or self.offset + size > len(self.data):
            raise ValueError("original final-exec payload is truncated")
        result = self.data[self.offset:self.offset+size]
        self.offset += size
        return result

    def sized(self, width):
        return self.take(int.from_bytes(self.take(width), "big"))

    def expect(self, expected):
        if self.take(len(expected)) != expected:
            raise ValueError("original canonical final-exec contract changed")

    def finish(self):
        if self.offset != len(self.data):
            raise ValueError("final-exec original frame has trailing bytes")


def wire(value, kind, sequence=None, unix_window=None, history=None):
    seq, data = preparation.original_frame(value, kind, sequence, 2*65536+512)
    payload = Payload(data)
    if kind == 0x0b:
        # OneShot / Workload / Duration(40s) / sudo; no substituted program,
        # environment, streaming/supervised acknowledgement or control channel.
        payload.expect(b"\0\0\0" + (40000).to_bytes(4, "big") + b"\x01")
        if payload.sized(4) != COMMAND.encode():
            raise ValueError("original IdleReusePreparation command changed")
        payload.expect(bytes(4))
        if payload.sized(2) != LABEL:
            raise ValueError("original final-exec label changed")
        payload.expect(b"\x01"+(65536).to_bytes(4,"big"))
        payload.expect(b"\x01"+(65536).to_bytes(4,"big"))
        payload.expect(bytes(3))  # expected-exit count and disabled control
        payload.expect(b"\x01")
        stdin = payload.sized(4)
        if history is None:
            raise ValueError("original final-exec source runtime is missing")
        runtime = f"/home/user/.vm0/guest-agent/runs/{history}"
        expected = json.dumps({"currentRuntimeDir":runtime,"retainedRuntimeDir":runtime}, separators=(",", ":")).encode()
        if stdin != expected:
            raise ValueError("original final-exec runtime/stdin attribution changed")
    elif kind == 0x0e:
        payload.expect(bytes(5))  # Exited(0)
        payload.take(4)  # actual Guest duration, not a synthetic running witness
        payload.expect(b"\x01\0")
        stdout = payload.sized(4)
        payload.expect(b"\x01\0")
        stderr = payload.sized(4)
        payload.expect(bytes(2))
        if len(stdout)>65536 or len(stderr)>65536:
            raise ValueError("final-exec bounded output contract changed")
        result = json.loads(stdout, object_pairs_hook=pressure.unique_object)
        if not isinstance(result,dict) or set(result)!={"before","after","home","removedEntries"}:
            raise ValueError("original final preparation report is missing or malformed")
        for capacity in (result["before"],result["after"],result["home"]):
            if (not isinstance(capacity,dict) or set(capacity)!={"availableBytes","availableInodes"}
                    or any(type(v) is not int or not 0<=v<=2**64-1 for v in capacity.values())):
                raise ValueError("original final preparation capacity report changed")
        if (type(result["removedEntries"]) is not int or not 0<=result["removedEntries"]<=2**64-1
                or result["after"]["availableBytes"]<128*1024**2 or result["after"]["availableInodes"]<1024
                or result["home"]["availableBytes"]<64*1024**2 or result["home"]["availableInodes"]<128):
            raise ValueError("actual final preparation did not pass owner capacity requirements")
    else:
        raise ValueError("unexpected final-exec wire authority")
    payload.finish()
    return seq


CONTRACT = preparation.Contract("FinalExec", wire)
PREFIX = CONTRACT.prefix
CASES = CONTRACT.cases


def validate(directory):
    return preparation.validate(directory, CONTRACT)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory",type=pathlib.Path)
    print(json.dumps(validate(parser.parse_args().directory),indent=2,sort_keys=True))
