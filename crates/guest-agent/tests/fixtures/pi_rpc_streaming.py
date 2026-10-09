#!/usr/bin/python3
"""Synthetic official RPC peer gated by observed preview/durable HTTP bodies."""
import json
import os
import socket
import sys


def emit(record):
    print(json.dumps(record, ensure_ascii=False, separators=(",", ":")), flush=True)


def command(expected):
    record = json.loads(sys.stdin.readline())
    assert record["type"] == expected
    return record


state = command("get_state")
emit({"id": state["id"], "type": "response", "command": "get_state", "success": True,
      "data": {"sessionId": os.environ["PI_SESSION_ID"], "sessionFile": os.environ["PI_SESSION_PATH"]}})
prompt = command("prompt")
emit({"id": prompt["id"], "type": "response", "command": "prompt", "success": True})
with open(os.environ["PI_STAGES_PATH"], encoding="utf-8") as source:
    stages = json.load(source)
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as gate:
    gate.connect(os.environ["PI_STREAM_GATE"])
    for stage in stages:
        emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
        for index, delta in stage["updates"]:
            emit({"type": "message_update", "assistantMessageEvent": {
                "type": "text_delta", "contentIndex": index, "delta": delta}})
        # The test must observe safe live text before completion is possible.
        assert gate.recv(1) == b"x"
        emit({"type": "message_end", "message": stage["message"]})
        # Finish all preview tails and durable reconciliation before progressing.
        assert gate.recv(1) == b"x"
emit({"type": "agent_settled"})
assert sys.stdin.readline() == ""
