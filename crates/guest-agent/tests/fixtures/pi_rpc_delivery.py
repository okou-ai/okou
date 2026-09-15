#!/usr/bin/python3
"""Official RPC peer paced by captured webhook responses, not elapsed time."""
import json
import os
import socket
import sys


def emit(record):
    print(json.dumps(record, ensure_ascii=False, separators=(",", ":")), flush=True)


def command(expected):
    line = sys.stdin.readline()
    with open(os.environ["PI_COMMANDS_PATH"], "a", encoding="utf-8") as output:
        output.write(line)
    record = json.loads(line)
    assert record["type"] == expected
    return record


emit({"type": "vm0_pi_api_first_turn_boundary", "schemaVersion": 2,
      "sandboxEventSequenceStart": 1, "ownershipTransferMode": "pending-tool-continuation"})
state = command("get_state")
emit({"id": state["id"], "type": "response", "command": "get_state", "success": True,
      "data": {"sessionId": os.environ["PI_SESSION_ID"], "sessionFile": os.environ["PI_SESSION_PATH"]}})
prompt = command("prompt")
emit({"id": prompt["id"], "type": "response", "command": "prompt", "success": True})
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as gate:
    gate.connect(os.environ["PI_DELIVERY_GATE"])
    with open(os.environ["PI_EVENTS_PATH"], encoding="utf-8") as source:
        for line in source:
            print(line, end="", flush=True)
            assert gate.recv(1) == b"x"
emit({"type": "agent_settled"})
assert sys.stdin.readline() == ""
