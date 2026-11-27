#!/usr/bin/python3
"""Deterministic peer for the Antigravity ACP JSON-RPC 2.0 protocol."""

import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]


def read_msg():
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)


def send_msg(obj):
    print(json.dumps(obj), flush=True)


def send_result(req_id, result):
    send_msg({"jsonrpc": "2.0", "id": req_id, "result": result})


def send_error(req_id, code, message):
    send_msg(
        {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}
    )


def send_update(session_id, update):
    send_msg(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": session_id, "update": update},
        }
    )


session = "ec30d0a7-1690-4e41-9da9-34dbca47bb8a"
mode = os.environ["AGY_TEST_CASE"]
directory = Path(os.environ["AGY_TEST_DIR"])

assert args[0] == "acp"
assert "--dangerously-skip-permissions" in args
assert "--disable-telemetry" in args
add_dirs = [args[i + 1] for i, a in enumerate(args) if a == "--add-dir"]
assert "/home/user/workspace" in add_dirs
rules = Path(add_dirs[0])
(directory / "rules-dir").write_text(str(rules))
assert Path.cwd() == Path("/home/user/workspace")

settings_path = Path(os.environ["HOME"]) / ".gemini" / "antigravity-cli" / "settings.json"
settings = json.loads(settings_path.read_text())
assert settings["modelProvider"] == "" and settings["useG1Credits"] is False
assert settings["enableTerminalSandbox"] is False
assert settings["toolPermission"] == "always-proceed"
assert "GEMINI_API_KEY" not in os.environ
assert "AGY_ADC_AUTH" not in os.environ
assert os.environ["AGY_CLI_DISABLE_AUTO_UPDATE"] == "true"

print("OAuth challenge provider-private-marker", file=sys.stderr, flush=True)

# 1. initialize
init_req = read_msg()
assert init_req["method"] == "initialize"
send_result(
    init_req["id"],
    {
        "protocolVersion": 1,
        "agentCapabilities": {},
        "agentInfo": {"name": "agy-peer", "version": "1.5.18"},
    },
)

# 2. session/new or session/resume
session_req = read_msg()
if mode == "resume":
    assert session_req["method"] == "session/resume"
    assert session_req["params"]["sessionId"] == session
    append_prompt = (
        session_req["params"]
        .get("_meta", {})
        .get("antigravity", {})
        .get("systemPrompt", {})
        .get("append", "")
    )
    assert append_prompt == "Use the run-specific system rule."
    assert "Previous chat messages go here." not in append_prompt
    send_result(session_req["id"], {"sessionId": session})
    mode = "success"
elif mode == "resume-missing":
    assert session_req["method"] == "session/resume"
    assert session_req["params"]["sessionId"] == session
    send_error(
        session_req["id"],
        -32603,
        f"Failed to read session {session}; retry, or load it with session/load",
    )
    fallback_req = read_msg()
    assert fallback_req["method"] == "session/new"
    append_prompt = (
        fallback_req["params"]
        .get("_meta", {})
        .get("antigravity", {})
        .get("systemPrompt", {})
        .get("append", "")
    )
    assert append_prompt.startswith("Use the run-specific system rule.")
    assert "Previous chat messages go here." in append_prompt
    send_result(fallback_req["id"], {"sessionId": session})
    mode = "success"
else:
    assert session_req["method"] == "session/new"
    append_prompt = (
        session_req["params"]
        .get("_meta", {})
        .get("antigravity", {})
        .get("systemPrompt", {})
        .get("append", "")
    )
    assert append_prompt.startswith("Use the run-specific system rule.")
    if mode == "recovery":
        assert "Previous chat messages go here." in append_prompt
        mode = "success"

    if mode == "auth":
        send_error(session_req["id"], -32000, "Authentication required")
        sys.exit(0)

    send_result(session_req["id"], {"sessionId": session})

# 3. session/set_mode & session/set_config_option
mode_req = read_msg()
assert mode_req["method"] == "session/set_mode"
assert mode_req["params"] == {"sessionId": session, "modeId": "accept-edits"}
send_result(mode_req["id"], {})

model_req = read_msg()
assert model_req["method"] == "session/set_config_option"
assert model_req["params"] == {
    "sessionId": session,
    "configId": "model",
    "value": "gemini-4-carbon",
}
send_result(model_req["id"], {})

effort_req = read_msg()
assert effort_req["method"] == "session/set_config_option"
assert effort_req["params"] == {
    "sessionId": session,
    "configId": "thought_level",
    "value": "high",
}
send_result(effort_req["id"], {})

# 4. initial session/prompt
prompt_req = read_msg()
assert prompt_req["method"] == "session/prompt"
assert prompt_req["params"] == {
    "sessionId": session,
    "prompt": [{"type": "text", "text": 'First line\n"Second" line.'}],
}

if mode == "missing":
    sys.exit(0)
if mode == "malformed":
    print("provider-private-marker", flush=True)
    sys.exit(0)
if mode == "nonzero":
    sys.exit(23)

if mode == "cancel":
    (directory / "ready").write_text(str(os.getpid()))
    cancel_msg = read_msg()
    assert cancel_msg["method"] == "session/cancel"
    assert cancel_msg["params"] == {"sessionId": session}
    send_result(prompt_req["id"], {"stopReason": "cancelled"})
    read_msg()
    sys.exit(0)

if mode == "steer":
    send_update(
        session,
        {
            "sessionUpdate": "tool_call",
            "toolCallId": "tc-steer-1",
            "name": "run_command",
            "rawInput": {"CommandLine": "sleep 1"},
            "status": "in_progress",
        },
    )
    (directory / "ready").write_text(str(os.getpid()))
    steer_req = read_msg()
    assert steer_req["method"] == "session/prompt"
    assert steer_req["params"] == {
        "sessionId": session,
        "prompt": [{"type": "text", "text": "Steer to the new answer."}],
    }
    # Hand off turn ownership: settle prompt #1 immediately with incremental usage.
    send_result(
        prompt_req["id"],
        {
            "stopReason": "end_turn",
            "usage": {"inputTokens": 12, "outputTokens": 4, "totalTokens": 16},
        },
    )
    send_update(
        session,
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc-steer-1",
            "name": "run_command",
            "status": "completed",
            "rawOutput": {"output": "done", "exit_code": 0},
        },
    )
    send_update(
        session,
        {
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "Steered answer"},
        },
    )
    send_result(
        steer_req["id"],
        {
            "stopReason": "end_turn",
            "usage": {"inputTokens": 20, "outputTokens": 6, "totalTokens": 26},
        },
    )
    read_msg()
    sys.exit(0)

# Default "success" scenario
send_update(
    session,
    {
        "sessionUpdate": "usage_update",
        "used": 16,
        "size": 1048576,
    },
)
send_update(
    session,
    {
        "sessionUpdate": "tool_call",
        "toolCallId": "tc-1",
        "name": "run_command",
        "rawInput": {"CommandLine": "pwd"},
        "status": "in_progress",
    },
)
send_update(
    session,
    {
        "sessionUpdate": "tool_call_update",
        "toolCallId": "tc-1",
        "name": "run_command",
        "status": "completed",
        "rawOutput": {"output": "workspace", "exit_code": 0},
    },
)
for chunk in ["Answer: configured-", "secret"]:
    send_update(
        session,
        {
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": chunk},
        },
    )
send_result(
    prompt_req["id"],
    {
        "stopReason": "end_turn",
        "usage": {"inputTokens": 12, "outputTokens": 4, "totalTokens": 16},
    },
)
read_msg()
