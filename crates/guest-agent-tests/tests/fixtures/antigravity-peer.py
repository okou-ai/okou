#!/usr/bin/python3
"""Deterministic peer for the official Antigravity CLI protocol."""

import json
import os
import signal
import sys
from pathlib import Path

args = sys.argv[1:]


def arg(key):
    return args[args.index(key) + 1]


def send(kind, data, **extra):
    print(json.dumps({"event": kind, kind: data, **extra}), flush=True)


model = "gemini-4-carbon-high"
session = "ec30d0a7-1690-4e41-9da9-34dbca47bb8a"
mode = os.environ["AGY_TEST_CASE"]
directory = Path(os.environ["AGY_TEST_DIR"])
rules = Path(arg("--add-dir"))
(directory / "rules-dir").write_text(str(rules))
assert Path.cwd() == Path("/home/user/workspace")
assert arg("--model") == model
assert arg("--input-format") == arg("--output-format") == "stream-json"
assert arg("--mode") == "accept-edits"
assert "/home/user/workspace" in args and "--dangerously-skip-permissions" in args
settings = json.loads(arg("--settings"))
assert settings["modelProvider"] == "" and settings["useG1Credits"] is False
assert settings["enableTerminalSandbox"] is False
assert settings["toolPermission"] == "always-proceed"
assert "GEMINI_API_KEY" not in os.environ
assert "AGY_ADC_AUTH" not in os.environ
assert os.environ["AGY_CLI_DISABLE_AUTO_UPDATE"] == "true"
rule_text = (rules / "AGENTS.md").read_text()
assert rule_text.startswith("Use the run-specific system rule.")
if mode == "recovery":
    assert "--conversation" not in args and "--continue" not in args
    assert "Previous chat messages go here." in rule_text
    mode = "success"
assert json.load(sys.stdin) == {
    "event": "user",
    "message": {"content": 'First line\n"Second" line.'},
}
print("OAuth challenge provider-private-marker", file=sys.stderr, flush=True)
if mode == "cancel":
    (directory / "ready").write_text(str(os.getpid()))
    signal.pause()
if mode == "auth":
    send(
        "result",
        {"status": "ERROR", "error": "authentication failed provider-private-marker"},
    )
    sys.exit(0)
send("init", {"model": model}, conversation_id=session)
if mode == "missing":
    sys.exit(0)
if mode == "malformed":
    print("provider-private-marker", flush=True)
    sys.exit(0)
if mode == "nonzero":
    sys.exit(23)
send("unknown", {"private_data": "provider-private-marker"})
send(
    "step_update",
    {
        "conversation_id": session,
        "step_index": 1,
        "step_type": "tool",
        "state": "DONE",
        "tool_info": {
            "name": "run_command",
            "parameters": {"CommandLine": "pwd"},
            "output": "workspace",
        },
    },
)
for state, text in [("ACTIVE", "Answer: configured-"), ("DONE", "secret")]:
    send(
        "step_update",
        {
            "conversation_id": session,
            "step_index": 2,
            "step_type": "agent_response",
            "state": state,
            "text_delta": text,
        },
    )
send(
    "result",
    {
        "conversation_id": session,
        "status": "SUCCESS",
        "response": "Answer: configured-secret",
        "num_turns": 1,
        "usage": {"input_tokens": 12, "output_tokens": 4, "total_tokens": 16},
    },
)
