"""Real packaged Agent/tool/child execution against bounded credential-free peers.

Executed only inside an owned native-test Guest. This checks artifact closure,
not mandatory caller isolation or production/provider behavior.
"""

import json
import os
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RUNTIME = Path("/run/okou/runtime")
ROOT = Path(tempfile.mkdtemp(prefix="runtime-payload-", dir="/tmp"))
HOME = ROOT / "home"
WORK = HOME / "workspace"
WORK.mkdir(parents=True)
SPAWNED = set()
REQUESTS = []
LOCK = threading.Lock()
FINISHED = threading.Event()
STARTED = {}
FIRST_REQUEST_US = {}
PEAK_SUM_RSS_KIB = {}


def choose(payload, dialect):
    messages = payload.get("messages", payload.get("input", []))
    users = [
        json.dumps(message) for message in messages if message.get("role") == "user"
    ]
    text = users[-1] if users else json.dumps(messages)
    name = {"chat": "pi", "anthropic": "claude", "responses": "codex"}[dialect]
    child = name.upper() + "_CHILD" in text and name.upper() + "_MAIN" not in text
    marker = WORK / (name + ("-child" if child else "-tool"))
    if name == "pi" and not child and "image" not in SPAWNED:
        SPAWNED.add("image")
        return "read", {"path": str(WORK / "image.png")}
    if not marker.exists():
        command = "printf complete > " + shlex.quote(str(marker))
        return (
            "bash" if name == "pi" else "Bash" if name == "claude" else "exec_command"
        ), {"cmd" if name == "codex" else "command": command}
    if not child and name not in SPAWNED:
        SPAWNED.add(name)
        if name == "claude":
            return "Agent", {
                "description": "Immutable payload child",
                "prompt": "CLAUDE_CHILD",
                "subagent_type": "general-purpose",
            }
        if name == "codex":
            return "spawn_agent", {"message": "CODEX_CHILD", "agent_type": "default"}
        wait = (
            "import pathlib,time; p=pathlib.Path("
            + repr(str(WORK / "pi-child"))
            + "); end=time.monotonic()+15;\nwhile not p.exists() and time.monotonic()<end: time.sleep(.05)\nassert p.exists(), 'child tool did not execute'"
        )
        return "bash", {
            "command": "okou subagent start 'PI_CHILD'; python3 -c " + shlex.quote(wait)
        }
    if (
        name == "codex"
        and not child
        and not (WORK / "codex-child").exists()
        and "codex-wait" not in SPAWNED
    ):
        SPAWNED.add("codex-wait")
        wait = (
            "import pathlib,time; p=pathlib.Path("
            + repr(str(WORK / "codex-child"))
            + "); end=time.monotonic()+15;\nwhile not p.exists() and time.monotonic()<end: time.sleep(.05)\nassert p.exists(), 'child tool did not execute'"
        )
        return "exec_command", {"cmd": "python3 -c " + shlex.quote(wait)}
    return None, {"text": "qualified " + name + (" child" if child else " main")}


class Peer(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_error(404)

    def do_POST(self):
        if self.path.startswith("/begin/"):
            name = self.path.removeprefix("/begin/")
            assert name in ("claude", "codex", "pi")
            with LOCK:
                STARTED[name] = time.monotonic_ns()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")
            return
        if self.path == "/finish":
            for name in ("claude", "codex", "pi"):
                for role in ("tool", "child"):
                    assert (WORK / (name + "-" + role)).read_text() == "complete", (
                        name,
                        role,
                        REQUESTS,
                    )
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"requests": REQUESTS}).encode())
            FINISHED.set()
            return
        length = int(self.headers.get("content-length", "0"))
        if not 0 < length <= 16 * 1024 * 1024:
            self.send_error(413)
            return
        payload = json.loads(self.rfile.read(length))
        dialect = (
            "chat"
            if "chat/completions" in self.path
            else "responses"
            if "responses" in self.path
            else "anthropic"
        )
        if "count_tokens" in self.path:
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"input_tokens":100}')
            return
        with LOCK:
            framework = {"chat": "pi", "anthropic": "claude", "responses": "codex"}[
                dialect
            ]
            FIRST_REQUEST_US.setdefault(
                framework, (time.monotonic_ns() - STARTED[framework]) // 1000
            )
            if len(REQUESTS) >= 64:
                self.send_error(400, "native request bound")
                return
            name, arguments = choose(payload, dialect)
            REQUESTS.append({"dialect": dialect, "tool": name})
            call = "call_" + str(len(REQUESTS))
        namespaces = {
            sub["name"]: tool["name"]
            for tool in payload.get("tools", [])
            for sub in tool.get("tools", [])
            if tool.get("type") == "namespace"
        }
        if dialect == "chat":
            delta = (
                {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": json.dumps(arguments),
                            },
                        }
                    ]
                }
                if name
                else {"content": arguments["text"]}
            )
            events = [
                "data: "
                + json.dumps(
                    {
                        "id": call,
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": payload.get("model"),
                        "choices": [
                            {
                                "index": 0,
                                "delta": part,
                                "finish_reason": ("tool_calls" if name else "stop")
                                if part == {}
                                else None,
                            }
                        ],
                    }
                )
                for part in ({"role": "assistant"}, delta, {})
            ]
            events.append("data: [DONE]")
        elif dialect == "anthropic":
            message = {
                "id": call,
                "type": "message",
                "role": "assistant",
                "model": payload.get("model"),
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 100, "output_tokens": 1},
            }
            block = (
                {"type": "tool_use", "id": call, "name": name, "input": {}}
                if name
                else {"type": "text", "text": ""}
            )
            values = [
                ("message_start", {"type": "message_start", "message": message}),
                (
                    "content_block_start",
                    {"type": "content_block_start", "index": 0, "content_block": block},
                ),
                (
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": 0,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": json.dumps(arguments),
                        }
                        if name
                        else {"type": "text_delta", "text": arguments["text"]},
                    },
                ),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                (
                    "message_delta",
                    {
                        "type": "message_delta",
                        "delta": {
                            "stop_reason": "tool_use" if name else "end_turn",
                            "stop_sequence": None,
                        },
                        "usage": {"output_tokens": 10},
                    },
                ),
                ("message_stop", {"type": "message_stop"}),
            ]
            events = [
                "event: " + event + "\ndata: " + json.dumps(value)
                for event, value in values
            ]
        else:
            item = (
                {
                    "type": "function_call",
                    "id": "fc_" + call,
                    "call_id": call,
                    "name": name,
                    "arguments": json.dumps(arguments),
                }
                if name
                else {
                    "type": "message",
                    "role": "assistant",
                    "id": "msg_" + call,
                    "content": [{"type": "output_text", "text": arguments["text"]}],
                }
            )
            if name in namespaces:
                item["namespace"] = namespaces[name]
            values = [
                {"type": "response.created", "response": {"id": "resp_" + call}},
                {"type": "response.output_item.done", "item": item},
                {
                    "type": "response.completed",
                    "response": {
                        "id": "resp_" + call,
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 10,
                            "total_tokens": 110,
                        },
                    },
                },
            ]
            events = [
                "event: " + value["type"] + "\ndata: " + json.dumps(value)
                for value in values
            ]
        body = ("\n\n".join(events) + "\n\n").encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def execute(command, env):
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        env=env,
        cwd=WORK,
        user=1000,
        group=1000,
        extra_groups=[],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=20)
        if process.returncode:
            raise ValueError(
                f"real packaged {command[0]} failed {process.returncode}: {stderr[-6000:]!r} {stdout[-4000:]!r}"
            )
        return {
            "version_seconds": time.monotonic() - started,
            "exit": process.returncode,
            "stdout": stdout.decode()[:4096],
        }
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream:
                stream.close()


def main():
    # Match the prepared cwd used by direct CLI integration fixtures. Mounted
    # home boot already supplies it; explicit no-home test Guests need setup.
    workspace = Path("/home/user/workspace")
    workspace.mkdir(parents=True, exist_ok=True)
    os.chown(workspace, 1000, 1000)

    # A real image read exercises the packaged worker/WASM path through Pi's
    # ordinary read tool, rather than importing a test-only runtime export.
    def chunk(kind, data):
        return (
            struct.pack("!I", len(data))
            + kind
            + data
            + struct.pack("!I", zlib.crc32(kind + data))
        )

    pixels = (b"\0" + b"\x20\x80\xe0" * 4000) * 3000
    (WORK / "image.png").write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack("!IIBBBBB", 4000, 3000, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(pixels))
        + chunk(b"IEND", b"")
    )
    del pixels
    (HOME / ".claude.json").write_text(
        json.dumps(
            {
                "hasCompletedOnboarding": True,
                "projects": {str(WORK): {"hasTrustDialogAccepted": True}},
            }
        )
    )
    (ROOT / "launch.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "appendSystemPrompt": None,
                "launchConfig": {"schemaVersion": 2},
            }
        )
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), Peer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(HOME),
        "USER": "user",
        "LANG": "C.UTF-8",
        "NO_PROXY": "*",
        "no_proxy": "*",
        "ANTHROPIC_API_KEY": "synthetic-no-provider-authority",
        "ANTHROPIC_BASE_URL": base,
        "OPENAI_API_KEY": "synthetic-no-provider-authority",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "CODEX_MANAGED_BY_NPM": "1",
        "CODEX_MANAGED_PACKAGE_ROOT": str(RUNTIME / "usr/local/lib/okou-codex"),
        "OKOU_RUN_ID": str(uuid.uuid4()),
        "OKOU_PI_SESSION_ROLE": "parent",
        "OKOU_PI_SESSION_ID": str(uuid.uuid4()),
        "OKOU_PI_RUNTIME_ROOT": str(ROOT / "pi-state"),
        "OKOU_PI_LAUNCH_PAYLOAD_FILE": str(ROOT / "launch.json"),
    }
    env["OKOU_PI_MODEL_CONFIG"] = json.dumps(
        {
            "schemaVersion": 5,
            "dialect": "openai-completions",
            "transport": "sse",
            "provider": "openrouter",
            "baseUrl": base + "/v1",
            "model": "auto",
            "thinkingLevel": "off",
            "credentialBindings": [
                {
                    "kind": "api-key",
                    "environment": "OPENAI_API_KEY",
                    "secretName": "OPENROUTER_API_KEY",
                }
            ],
        }
    )
    codex = Path("/home/user/.codex")
    codex.mkdir(exist_ok=True)
    os.chown(codex, 1000, 1000)
    (codex / "config.toml").write_text(
        'model = "gpt-5.1-codex-mini"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\nmulti_agent = true\n[model_providers.mock]\nname = "mock"\nbase_url = '
        + json.dumps(base + "/v1")
        + '\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n'
    )
    os.chown(codex / "config.toml", 1000, 1000)
    env["CODEX_HOME"] = str(codex)
    fake = WORK / "fake-bin"
    fake.mkdir()
    for name in ("claude", "codex", "node"):
        path = fake / name
        path.write_text("#!/bin/sh\nexit 97\n")
        path.chmod(0o755)
    env["PATH"] = str(fake) + ":" + env["PATH"]
    # The Host invokes the real fixed Guest Agent owner for every framework.
    # Its bootstrap owns runtime/tool placement; a generic exec cannot select
    # that topology by running one of the same program paths.
    bootstrap = []
    run_id = sys.argv[1]
    for name, selector in (("claude", "claude-code"), ("codex", "codex"), ("pi", "pi")):
        private = ROOT / ("guest-agent-" + name)
        payload = {
            "prompt": name.upper() + "_MAIN",
            "piLaunchConfig": '{"schemaVersion":2}',
            "piModelConfig": env["OKOU_PI_MODEL_CONFIG"],
            "piSessionId": str(uuid.uuid4()),
        }
        for folder, filename, value in (
            ("run-payload", "payload.json", payload),
            (
                "user-env",
                "env.json",
                {
                    key: value
                    for key, value in env.items()
                    if not key.startswith("OKOU_")
                }
                | {
                    "OPENAI_MODEL": "gpt-5.1-codex-mini",
                    "ANTHROPIC_MODEL": "claude-sonnet-4-6",
                    "SENTRY_DSN": "",
                },
            ),
        ):
            directory = private / folder
            directory.mkdir(parents=True, mode=0o700)
            directory.chmod(0o700)
            path = directory / filename
            path.write_text(json.dumps(value))
            path.chmod(0o600)
        private.chmod(0o700)
        bootstrap.append(
            {
                "name": name,
                "env": {
                    "OKOU_RUN_ID": run_id,
                    "CLI_AGENT_TYPE": selector,
                    "OKOU_GUEST_RUNTIME_DIR": str(private),
                    "OKOU_RUN_PAYLOAD_FILE": str(private / "run-payload/payload.json"),
                    "OKOU_USER_ENV_FILE": str(private / "user-env/env.json"),
                    "OKOU_AGENT_EXECUTION_TIMEOUT_SECS": "45",
                },
            }
        )
    for path in [ROOT, *ROOT.rglob("*")]:
        os.chown(path, 1000, 1000)
    ROOT.chmod(0o755)
    sampling_done = threading.Event()

    def observe_runtime_rss():
        while not sampling_done.is_set():
            totals = {}
            for process in Path("/proc").iterdir():
                if not process.name.isdigit():
                    continue
                try:
                    exe = os.readlink(process / "exe")
                    if not exe.startswith(str(RUNTIME) + "/"):
                        continue
                    name = (
                        "codex" if "/node_modules/@openai/" in exe else Path(exe).name
                    )
                    name = "pi" if name == "node" else name
                    for line in (process / "status").read_text().splitlines():
                        if line.startswith("VmRSS:"):
                            totals[name] = totals.get(name, 0) + int(line.split()[1])
                except (FileNotFoundError, ProcessLookupError, PermissionError):
                    continue
            for name, value in totals.items():
                PEAK_SUM_RSS_KIB[name] = max(value, PEAK_SUM_RSS_KIB.get(name, 0))
            sampling_done.wait(0.05)

    sampler = threading.Thread(target=observe_runtime_rss)
    sampler.start()
    try:
        print(json.dumps({"bootstrap": bootstrap, "url": base}), flush=True)
        if not FINISHED.wait(240):
            raise TimeoutError("native Agent peer was not completed by its Host owner")
        # The public CLI and independent mutable Node remain usable as tools.
        results = {
            "tool_cli": execute(["/usr/local/bin/okou", "--version"], env),
            "tool_codex": execute(["/usr/bin/codex", "--version"], env),
            "tool_node": execute(
                ["/usr/bin/node", "-e", "console.log(process.version)"], env
            ),
        }
        print(
            json.dumps(
                {
                    "scope": "native packaged payload, local synthetic model peers; no caller isolation/provider claim",
                    "results": results,
                    "requests": REQUESTS,
                    "control_start_to_first_model_request_us": FIRST_REQUEST_US,
                    "peak_sum_sampled_runtime_rss_kib": PEAK_SUM_RSS_KIB,
                    "measurement_scope": "owned Guest, synthetic peers; RSS sum counts shared pages repeatedly; 50ms sampling, not cgroup peak or a performance comparison",
                    "meminfo": Path("/proc/meminfo").read_text().splitlines()[:5],
                }
            )
        )
    finally:
        sampling_done.set()
        sampler.join(timeout=5)
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


try:
    main()
finally:
    shutil.rmtree(ROOT)
