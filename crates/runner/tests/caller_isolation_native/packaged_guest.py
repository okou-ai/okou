"""Disposable Guest prototype: real packaged runtimes, synthetic HTTP peers."""

import array
import base64
import ctypes
import errno
import hashlib
import json
import os
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import threading
import time
import traceback
import uuid
import zlib
from contextlib import ExitStack, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import packaged_accounting
import packaged_audit
import packaged_browser
import packaged_history
import packaged_lifecycle
import packaged_mcp
import packaged_resources
import packaged_storage

ROOT = Path("/home/user/workspace")
FIXTURE = Path("/fixture")
RUN = "88888888-8888-4888-8888-888888888888"
CLI = "/usr/local/lib/okou-cli/9.400.3/okou.js"
ENTRY = "/fixture/entry"
CG = Path("/sys/fs/cgroup/vm0-exec/exec-native/workload")
results = []
requests = []
errors = []
counter = 0
tasks = {}
stop_peers = []
spawned = set()
request_counts = {}
resource_ready = threading.Event()
resource_release = threading.Event()
lock = threading.Lock()


def record(name, passed, **extra):
    result = {"name": name, "passed": passed, **extra}
    results.append(result)
    print(
        "PACKAGED_CASE "
        + json.dumps(
            {k: v for k, v in result.items() if k in ("name", "passed", "exit")},
            separators=(",", ":"),
        ),
        flush=True,
    )
    if not passed:
        failure = {
            k: extra[k]
            for k in ("identity", "bootstrap", "stderr", "audit", "peerError")
            if k in extra
        }
        print(
            "PACKAGED_CASE_FAILURE " + json.dumps({"name": name, **failure})[-12000:],
            flush=True,
        )


def label(path, kind, follow=True):
    os.setxattr(
        path,
        "security.selinux",
        f"system_u:object_r:{kind}".encode(),
        follow_symlinks=follow,
    )


def compact(value):
    if isinstance(value, list):
        return [compact(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {
        k: compact(v)
        for k, v in value.items()
        if not (value.get("type") == "image" and k == "data")
    }
    if value.get("type") == "image" and isinstance(value.get("data"), str):
        data = base64.b64decode(value["data"], validate=True)
        result["imageBytes"] = len(data)
        result["imageSha256"] = hashlib.sha256(data).hexdigest()
    return result


def as_role(role, args, *, env=None, stdin=None, timeout=45, group="runtime"):
    if group != ("runtime" if role in ("agent", "agent-resource-control") else "tools"):
        raise ValueError("role/cgroup mismatch")
    return subprocess.run(
        [ENTRY, role, *args],
        cwd=ROOT,
        env=env,
        input=stdin,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def pi_session(env, message="PI_MAIN"):
    records = []
    buffered = b""
    settled = False
    with (FIXTURE / "pi.stderr").open("w") as stderr:
        label(FIXTURE / "pi.stderr", "runtime_log_t")
        pi = subprocess.Popen(
            [ENTRY, "agent", "/usr/bin/node", CLI, "__agent-loop"],
            env=env,
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            text=True,
        )
        try:
            pi.stdin.write(
                json.dumps({"id": "native", "type": "prompt", "message": message})
                + "\n"
            )
            pi.stdin.flush()
            deadline = time.monotonic() + 60
            while not settled and time.monotonic() < deadline:
                if not select.select(
                    [pi.stdout], [], [], max(0, deadline - time.monotonic())
                )[0]:
                    break
                chunk = os.read(pi.stdout.fileno(), 16384)
                if not chunk:
                    break
                buffered += chunk
                if len(buffered) > 2 * 1024 * 1024:
                    raise ValueError("Pi event byte bound")
                while b"\n" in buffered:
                    line, buffered = buffered.split(b"\n", 1)
                    value = json.loads(line)
                    records.append(value)
                    if len(records) > 512:
                        raise ValueError("Pi event count bound")
                    if value.get("type") == "agent_settled":
                        settled = True
            try:
                pi.stdin.close()
            except BrokenPipeError:
                # The settled CLI may close stdin first; exit/tool results still decide success.
                pass
            pi.wait(timeout=5)
        finally:
            if pi.poll() is None:
                pi.kill()
            pi.wait()
            pi.stdin.close()
            pi.stdout.close()
    return pi.returncode, records


def frame(stream, value):
    raw = b"\1" + json.dumps(value, separators=(",", ":")).encode()
    stream.sendall(struct.pack("!I", len(raw)) + raw)


def exact(stream, size):
    data = b""
    while len(data) < size:
        chunk = stream.recv(size - len(data))
        if not chunk:
            raise EOFError("broker peer closed")
        data += chunk
    return data


def broker(endpoint, task=False):
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind("\0" + endpoint)
    listener.listen(16)

    def serve():
        global counter
        while True:
            peer, _ = listener.accept()
            try:
                peer.settimeout(5)
                pid, uid, _ = struct.unpack(
                    "3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                )
                context = (
                    peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERSEC, 256)
                    .decode()
                    .rstrip("\0")
                )
                membership = (
                    Path(f"/proc/{pid}/cgroup").read_text().strip().split("::", 1)[1]
                )
                if not membership.startswith("/vm0-exec/exec-native/workload/"):
                    raise ValueError("peer outside owned operation")
                if task:
                    length = struct.unpack("!I", exact(peer, 4))[0]
                    if not 2 <= length <= 4096:
                        raise ValueError("invalid task request size")
                    raw = exact(peer, length)
                    if raw[0] != 1:
                        raise ValueError("invalid task request version")
                    request = json.loads(raw[1:])
                    if request["op"] == "stop":
                        status = Path(f"/proc/{pid}/status").read_text()
                        stop_peers.append(
                            {
                                "uid": uid,
                                "context": context,
                                "capEff": next(
                                    line.split()[1]
                                    for line in status.splitlines()
                                    if line.startswith("CapEff:")
                                ),
                            }
                        )
                        path = tasks[request["handle"]]
                        (path / "cgroup.kill").write_text("1")
                        frame(peer, {"status": "stopped"})
                        continue
                    if request != {"op": "launch"}:
                        raise ValueError("invalid launch")
                    handle = str(uuid.uuid4())
                    parent = CG / "tools" / ("task-" + handle)
                    parent.mkdir()
                    (parent / "memory.oom.group").write_text("0")
                    (parent / "cgroup.subtree_control").write_text("+memory")
                    (parent / "runtime").mkdir()
                    (parent / "runtime/memory.oom.group").write_text("1")
                    (parent / "tools").mkdir()
                    (parent / "tools/memory.oom.group").write_text("0")
                    (parent / "tools/cgroup.subtree_control").write_text("+memory")
                    tasks[handle] = parent
                    target = parent / "runtime"
                    frame(
                        peer,
                        {"status": "ready", "task": {"handle": handle, "pid": pid}},
                    )
                else:
                    if not membership.endswith("/runtime"):
                        raise ValueError("tool launcher outside runtime")
                    counter += 1
                    parent = Path("/sys/fs/cgroup" + membership).parent / "tools"
                    target = parent / f"tool-{counter}"
                    target.mkdir()
                    (target / "memory.oom.group").write_text("1")
                fd = os.open(target / "cgroup.procs", os.O_WRONLY | os.O_CLOEXEC)
                try:
                    peer.sendmsg(
                        [b"T"],
                        [
                            (
                                socket.SOL_SOCKET,
                                socket.SCM_RIGHTS,
                                array.array("i", [fd]),
                            )
                        ],
                    )
                    if exact(peer, 1) != b"C":
                        raise ValueError("placement confirmation")
                    actual = (
                        Path(f"/proc/{pid}/cgroup")
                        .read_text()
                        .strip()
                        .split("::", 1)[1]
                    )
                    if actual != str(target).removeprefix("/sys/fs/cgroup"):
                        raise ValueError("wrong final placement")
                    peer.sendall(b"A")
                    print(
                        "PACKAGED_PLACEMENT "
                        + json.dumps(
                            {
                                "task": task,
                                "pid": pid,
                                "uid": uid,
                                "context": context,
                                "cgroup": actual,
                            }
                        ),
                        flush=True,
                    )
                finally:
                    os.close(fd)
            except (OSError, EOFError, ValueError, KeyError) as error:
                errors.append(str(error))
                print("PACKAGED_BROKER_ERROR " + repr(error), flush=True)
            finally:
                peer.close()

    threading.Thread(target=serve, daemon=True).start()
    return listener


@contextmanager
def namespace_broker(keeper_pid, workload_pid):
    with (
        open(f"/proc/{workload_pid}/ns/mnt", "rb") as workload,
        open(f"/proc/{keeper_pid}/ns/mnt", "rb") as agent,
    ):
        handles = {b"T": workload.fileno(), b"A": agent.fileno()}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind("\0okou-native-namespace")
            listener.listen(16)

            def serve():
                while True:
                    peer, _ = listener.accept()
                    try:
                        peer.settimeout(5)
                        context = (
                            peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERSEC, 256)
                            .decode()
                            .rstrip("\0")
                        )
                        target = exact(peer, 1)
                        expected = {
                            b"T": {
                                "system_u:system_r:toolbridge_t",
                                "system_u:system_r:control_t",
                            },
                            b"A": {
                                "system_u:system_r:control_t",
                                "system_u:system_r:taskbridge_t",
                            },
                        }
                        if context not in expected.get(target, set()):
                            raise ValueError("namespace role/entry mismatch")
                        peer.sendmsg(
                            [b"N"],
                            [
                                (
                                    socket.SOL_SOCKET,
                                    socket.SCM_RIGHTS,
                                    array.array("i", [handles[target]]),
                                )
                            ],
                        )
                    except (OSError, EOFError, ValueError) as error:
                        errors.append(str(error))
                        print("PACKAGED_NAMESPACE_ERROR " + repr(error), flush=True)
                    finally:
                        peer.close()

            threading.Thread(target=serve, daemon=True).start()
            yield


PROBE = r"""import errno,json,os,socket
from pathlib import Path
s=socket.socket(); result=s.connect_ex(("127.0.0.1",18080)); s.close()
context=Path("/proc/self/attr/current").read_text().strip().strip("\0")
assert context=="system_u:system_r:workload_t",context
assert result in (errno.EACCES,errno.EPERM),result
p=Path("/home/user/workspace/tool-data")
p.write_text("ordinary tool write")
caps=next(line.split()[1] for line in Path("/proc/self/status").read_text().splitlines() if line.startswith("CapEff:"))
print(json.dumps({"uid":os.getuid(),"context":context,"capEff":caps,"connectErrno":result,"cgroup":Path("/proc/self/cgroup").read_text().strip(),"oom":Path("/proc/self/oom_score_adj").read_text().strip()}))
"""


def tool_command(marker):
    import shlex

    return (
        "python3 -c "
        + shlex.quote(PROBE)
        + " && printf complete > "
        + shlex.quote(str(ROOT / marker))
    )


def choose(payload, dialect):
    messages = payload.get("messages", payload.get("input", []))
    users = [json.dumps(m) for m in messages if m.get("role") == "user"]
    text = users[-1] if users else json.dumps(messages)
    if "_RETAINED_HISTORY" in text:
        return None, {"text": "retained session history reopened"}
    if "PI_RESOURCE_WAIT" in text:
        return None, {"text": "resource pressure completed; real Pi loop continued"}
    child = "PI_CHILD" in text and "PI_MAIN" not in text
    if "CLAUDE_CHILD" in text and "CLAUDE_MAIN" not in text:
        child = True
    if "CODEX_CHILD" in text and "CODEX_MAIN" not in text:
        child = True
    name = (
        "pi" if dialect == "chat" else ("claude" if dialect == "anthropic" else "codex")
    )
    marker = name + ("-child" if child else "-tool")
    for phase in ("MAIN", "CHILD"):
        if "PI_LIFECYCLE_" + phase in text:
            key = "lifecycle-" + phase
            if key not in spawned:
                spawned.add(key)
                return "bash", {
                    "command": "python3 /fixture/packaged_lifecycle.py "
                    + ("parent" if phase == "MAIN" else "child")
                }
            return None, {"text": "lifecycle main continued"}
    for tag in ("claude-direct", "claude-lowered", "codex-direct", "codex-lowered"):
        if tag in text and tag not in spawned:
            spawned.add(tag)
            wait = (
                "import json,pathlib,time; p=pathlib.Path('/home/user/workspace/mcp-"
                + tag
                + ".json'); end=time.monotonic()+5\nwhile time.monotonic()<end:\n if p.exists() and json.loads(p.read_text()).get('initialized'): break\n time.sleep(.01)\nelse: raise AssertionError('MCP handshake did not complete')"
            )
            return ("Bash" if name == "claude" else "exec_command"), {
                "command" if name == "claude" else "cmd": "python3 -c "
                + shlex.quote(wait)
            }
    if name == "pi" and not child and "pi-image-read" not in spawned:
        spawned.add("pi-image-read")
        return "read", {"path": str(ROOT / "native-image.png")}
    if not (ROOT / marker).exists():
        key = name + ("-child-bash" if child else "-main-bash")
        if key in spawned:
            return None, {
                "text": "fixture observed unsuccessful tool; inspect captured tool result"
            }
        spawned.add(key)
        return (
            "bash" if name == "pi" else "Bash" if name == "claude" else "exec_command"
        ), {"command" if name != "codex" else "cmd": tool_command(marker)}
    if name == "pi" and not child and not (ROOT / "pi-child").exists():
        if name in spawned:
            return None, {"text": "fixture observed unsuccessful child launch"}
        spawned.add(name)
        return "bash", {
            "command": "okou subagent start 'PI_CHILD'; python3 -c \"import pathlib,time; p=pathlib.Path('/home/user/workspace/pi-child'); end=time.monotonic()+15;\nwhile not p.exists() and time.monotonic()<end: time.sleep(.05)\nassert p.exists(), 'child did not execute its tool'\""
        }
    if name in ("claude", "codex") and not child and name not in spawned:
        spawned.add(name)
        if name == "claude":
            return "Agent", {
                "description": "Native child isolation probe",
                "prompt": "CLAUDE_CHILD",
                "subagent_type": "general-purpose",
            }
        return "spawn_agent", {"message": "CODEX_CHILD", "agent_type": "default"}
    if name == "codex" and not child and not (ROOT / "codex-child").exists():
        if "codex-wait" in spawned:
            return None, {"text": "fixture observed unsuccessful child tool"}
        spawned.add("codex-wait")
        return "exec_command", {
            "cmd": "python3 -c \"import pathlib,time; p=pathlib.Path('/home/user/workspace/codex-child'); end=time.monotonic()+15;\nwhile not p.exists() and time.monotonic()<end: time.sleep(.05)\nassert p.exists(), 'child tool did not execute'\""
        }
    return None, {"text": "qualified " + name + (" child" if child else " main")}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/native-storage.tar.gz":
            body = (FIXTURE / "native-storage.tar.gz").read_bytes()
            (ROOT / "storage-http-observed").write_text("observed owned archive GET")
            self.send_response(200)
            self.send_header("content-type", "application/gzip")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path in {
            "/mcp-claude-direct",
            "/mcp-claude-lowered",
            "/mcp-codex-direct",
            "/mcp-codex-lowered",
        }:
            (ROOT / (self.path[1:] + "-connected")).write_text(
                "observed synthetic MCP ingress GET"
            )
        if self.path == "/untrusted-extension-ingress":
            (ROOT / "untrusted-extension-connected").write_text(
                "observed synthetic ingress GET"
            )
            print("PACKAGED_UNTRUSTED_EXTENSION_INGRESS", flush=True)
        if self.path == "/untrusted-shell-ingress":
            (ROOT / "untrusted-shell-connected").write_text(
                "observed synthetic ingress GET"
            )
        body = b'{"data":[]}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        if length > 2 * 1024 * 1024:
            self.send_error(413)
            return
        payload = json.loads(self.rfile.read(length))
        if "PI_RESOURCE_WAIT" in json.dumps(payload):
            resource_ready.set()
            if not resource_release.wait(60):
                self.send_error(504, "resource probe continuation timeout")
                return
        dialect = (
            "chat"
            if "chat/completions" in self.path
            else "responses"
            if "responses" in self.path
            else "anthropic"
        )
        tools = [
            t.get("name", t.get("function", {}).get("name"))
            for t in payload.get("tools", [])
        ]
        namespaces = {
            s["name"]: t["name"]
            for t in payload.get("tools", [])
            for s in t.get("tools", [])
            if t.get("type") == "namespace"
        }
        for t in payload.get("tools", []):
            tools.extend(s.get("name") for s in t.get("tools", []))
        messages = payload.get("messages", payload.get("input", []))
        with lock:
            request = {
                "path": self.path,
                "bytes": length,
                "tools": tools,
                "lastInput": json.dumps(messages[-1])[-1800:] if messages else "",
            }
            for framework in ("pi", "claude", "codex"):
                marker = framework.upper() + "_RETAINED_HISTORY"
                if messages and marker in json.dumps(messages[-1]):
                    request.update(
                        historyMarker=marker,
                        retainedMainObserved=framework.upper() + "_MAIN"
                        in json.dumps(
                            [m for m in messages[:-1] if m.get("role") == "user"]
                        ),
                    )
            requests.append(request)
            request_counts[dialect] = request_counts.get(dialect, 0) + 1
            over_budget = request_counts[dialect] > 16
            count_tokens = "count_tokens" in self.path
            if not over_budget and not count_tokens:
                name, arguments = choose(payload, dialect)
            call = "call_" + str(len(requests))
        print(
            "PACKAGED_HTTP "
            + json.dumps({"path": self.path, "bytes": length, "tools": len(tools)}),
            flush=True,
        )
        if over_budget:
            self.send_error(400, "bounded synthetic fixture request budget")
            return
        if count_tokens:
            raw = b'{"input_tokens":100}'
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if name and name not in tools:
            errors.append("requested tool missing: " + name + " in " + repr(tools))
        events = []
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
            for value in [{"role": "assistant"}, delta, {}]:
                events.append(
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
                                    "delta": value,
                                    "finish_reason": ("tool_calls" if name else "stop")
                                    if value == {}
                                    else None,
                                }
                            ],
                        }
                    )
                )
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
            values = [("message_start", {"type": "message_start", "message": message})]
            block = (
                {"type": "tool_use", "id": call, "name": name, "input": {}}
                if name
                else {"type": "text", "text": ""}
            )
            values += [
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
            events = ["event: " + k + "\ndata: " + json.dumps(v) for k, v in values]
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
                "event: " + v["type"] + "\ndata: " + json.dumps(v) for v in values
            ]
        body = ("\n\n".join(events) + "\n\n").encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_guest(resources):
    socket.sethostname("localhost")
    (Path("/sys/fs/selinux/enforce")).write_text("1")
    Path("/proc/sys/kernel/printk_ratelimit").write_text("0")
    # Preserve fallback denials in the kernel buffer without duplicating each
    # syscall/proctitle across the bounded serial transport.
    Path("/proc/sys/kernel/printk").write_text("3\n")
    workload_pid = int(os.environ["OKOU_NATIVE_WORKLOAD_KEEPER_PID"])
    if workload_pid <= 1:
        raise ValueError("invalid workload namespace owner")
    writable_root = Path(f"/proc/{workload_pid}/root")
    # Only this newly owned writable drive is relabelled. The separate immutable
    # drive supplies the protected process's complete OS/runtime dependency view.
    for top in ("usr", "etc", "opt", "home", "root", "tmp", "var", "run"):
        path = writable_root / top
        if path.exists():
            for parent, dirs, files in os.walk(path, followlinks=False):
                label(parent, "workload_data_t")
                for name in dirs + files:
                    p = Path(parent) / name
                    label(p, "workload_data_t", follow=not p.is_symlink())
    for name, kind in [
        ("guest-tool-exec", "toolbridge_exec_t"),
        ("guest-task-exec", "taskbridge_exec_t"),
    ]:
        shutil.copyfile(FIXTURE / "entry", FIXTURE / name)
        label(FIXTURE / name, kind)
        os.chown(FIXTURE / name, 1000, 1000)
        os.chmod(FIXTURE / name, 0o500)
        # Only the fixed entry receives namespace/identity capabilities. MAC
        # protects its bytes and metadata even from its owner and sudo-root.
        capabilities = (1 << 21) | (1 << 18) | (1 << 7) | (1 << 6)
        os.setxattr(
            FIXTURE / name,
            "security.capability",
            struct.pack("<IIIII", 0x02000001, capabilities, 0, 0, 0),
        )
    ROOT.mkdir(parents=True, exist_ok=True)
    for path in (Path("/home/user"), ROOT):
        os.chown(path, 1000, 1000)
        label(path, "workload_data_t")
    for path in (CG / "runtime", CG / "tools"):
        if not path.is_dir():
            raise ValueError("resource policy did not create managed domains")
    packaged_resources.prepare(FIXTURE, label)
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": "/home/user",
        "USER": "user",
        "SHELL": "/bin/bash",
        "LANG": "C.UTF-8",
        "OKOU_RUN_ID": RUN,
        "OKOU_PI_SESSION_ROLE": "parent",
        "OKOU_PI_SESSION_ID": "99999999-9999-4999-8999-999999999999",
        "OKOU_PI_LAUNCH_PAYLOAD_FILE": "/fixture/launch.json",
        "OKOU_TOOL_CGROUP_PROCS_ENDPOINT": "okou-native-placement",
        "OPENAI_API_KEY": "synthetic-no-provider-authority",
        "NO_PROXY": "*",
        "no_proxy": "*",
        "OKOU_NATIVE_FRAMEWORK": "pi",
        # Exercise the real CLI with a working packaged extension loader in both
        # views. The negative cannot depend on its default typebox packaging error.
        "NODE_OPTIONS": "--import=/fixture/bundled-loader-control.mjs",
    }
    model = {
        "schemaVersion": 5,
        "dialect": "openai-completions",
        "transport": "sse",
        "provider": "openrouter",
        "baseUrl": "http://127.0.0.1:18080/v1",
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
    env["OKOU_PI_MODEL_CONFIG"] = json.dumps(model, separators=(",", ":"))
    (FIXTURE / "launch.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "appendSystemPrompt": None,
                "launchConfig": {"schemaVersion": 2},
            }
        )
    )
    (FIXTURE / "environment").write_text(
        "\n".join(k + "=" + v for k, v in env.items()) + "\n"
    )
    for name in ("bash", "dash"):
        path = FIXTURE / ("workload-shell-" + name)
        shutil.copyfile("/sealed/usr/bin/" + name, path)
        path.chmod(0o555)
        label(path, "workload_shell_exec_t")
    keeper = subprocess.Popen(
        [ENTRY, "keeper", "unused"], stdout=subprocess.PIPE, text=True
    )
    if keeper.stdout.readline().strip() != "ready":
        raise ValueError("sealed namespace keeper failed")
    resources.enter_context(namespace_broker(keeper.pid, workload_pid))
    broker("okou-native-placement")
    broker("okou-native-placement-tasks", task=True)
    server = ThreadingHTTPServer(("127.0.0.1", 18080), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    restoration = {}
    if "caller_restore=1" in Path("/proc/cmdline").read_text().split():

        def checkpoint():
            return {
                "enforcing": Path("/sys/fs/selinux/enforce").read_text().strip(),
                "controllerContext": Path("/proc/self/attr/current")
                .read_text()
                .rstrip("\0"),
                "agentNamespace": os.readlink(f"/proc/{keeper.pid}/ns/mnt"),
                "workloadNamespace": os.readlink(f"/proc/{workload_pid}/ns/mnt"),
            }

        restoration["before"] = checkpoint()
        os.sync()
        print("PACKAGED_SNAPSHOT_READY", flush=True)
        with open("/dev/ttyS0", "rb", buffering=0) as console:
            if console.readline(32) != b"restored\n":
                raise ValueError("invalid owned snapshot continuation")
        restoration["after"] = checkpoint()
        if (
            restoration["before"] != restoration["after"]
            or restoration["after"]["enforcing"] != "1"
        ):
            raise ValueError("restore lost enforcing state or namespace identity")
    control_device = Path("/usr/bin/python3").stat().st_dev
    sealed_device = Path("/sealed/usr/bin/python3").stat().st_dev
    workload_device = (writable_root / "usr/bin/python3").stat().st_dev
    record(
        "control_runtime_on_sealed_drive",
        control_device == sealed_device and control_device != workload_device,
        controlDevice=control_device,
        sealedDevice=sealed_device,
        workloadDevice=workload_device,
    )
    for role in ("workload", "root"):
        run = as_role(role, ["/usr/bin/python3", "-c", PROBE], env=env, group="tools")
        record(
            role + "_direct_ingress",
            run.returncode == 0,
            exit=run.returncode,
            stdout=run.stdout[-2000:],
            stderr=run.stderr[-2000:],
        )
    with packaged_audit.capture() as namespace_audit:
        nested = as_role(
            "workload",
            [
                "/usr/bin/unshare",
                "--user",
                "--map-root-user",
                "/usr/bin/python3",
                "-c",
                PROBE,
            ],
            env=env,
            group="tools",
        )
    nested_identity = json.loads(nested.stdout) if nested.returncode == 0 else {}
    namespace_control = subprocess.run(
        ["/usr/bin/unshare", "--user", "--map-root-user", "/usr/bin/id", "-u"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    record(
        "user_namespace_stays_workload",
        nested.returncode == 0
        and nested_identity.get("uid") == 0
        and nested_identity.get("context") == "system_u:system_r:workload_t"
        and nested_identity.get("capEff") == "000001ffffffffff"
        and nested_identity.get("connectErrno") in (1, 13),
        identity=nested_identity,
        stderr=nested.stderr[-2000:],
        control={
            "exit": namespace_control.returncode,
            "stdout": namespace_control.stdout,
            "stderr": namespace_control.stderr,
        },
        audit=namespace_audit["denials"],
    )
    metadata_probe = """import errno,os,stat
for name in ("guest-tool-exec","guest-task-exec"):
 path="/fixture/"+name; info=os.stat(path)
 assert info.st_uid==1000 and stat.S_IMODE(info.st_mode)==0o500
 try: os.chmod(path,0o700)
 except OSError as error: assert error.errno in (errno.EACCES,errno.EPERM),error
 else: raise AssertionError("protected entry metadata changed")
print("protected entry metadata denied to uid",os.getuid())"""
    for role in ("workload", "root"):
        run = as_role(
            role, ["/usr/bin/python3", "-c", metadata_probe], env=env, group="tools"
        )
        record(
            ("user" if role == "workload" else "root") + "_bridge_metadata_denied",
            run.returncode == 0,
            exit=run.returncode,
            stdout=run.stdout[-1500:],
            stderr=run.stderr[-1500:],
        )
    raw_probe = """import errno,os
for name in ("/dev/vda","/dev/vdb"):
 try: fd=os.open(name,os.O_RDONLY)
 except OSError as error: assert error.errno in (errno.EACCES,errno.EPERM),(name,error)
 else: os.close(fd); raise AssertionError("raw device opened: "+name)
print("root raw device opens denied")"""
    run = as_role("root", ["/usr/bin/python3", "-c", raw_probe], env=env, group="tools")
    record(
        "root_raw_device_open_denied",
        run.returncode == 0,
        exit=run.returncode,
        stdout=run.stdout[-1500:],
        stderr=run.stderr[-1500:],
    )
    (FIXTURE / "ioctl-protected-marker").write_text("owned synthetic marker")
    (FIXTURE / "ioctl-protected-marker").chmod(0o400)
    ioctl_probe = """import errno,fcntl,os,struct
fd=os.open("/fixture/ioctl-protected-marker",os.O_RDONLY)
try: fcntl.ioctl(fd,0x40086602,struct.pack("L",0))
except OSError as error: assert error.errno in (errno.EACCES,errno.EPERM),error
else: raise AssertionError("protected file flags ioctl allowed")
finally: os.close(fd)
print("protected file flags ioctl denied")"""
    run = as_role(
        "root", ["/usr/bin/python3", "-c", ioctl_probe], env=env, group="tools"
    )
    record(
        "root_protected_file_ioctl_denied",
        run.returncode == 0,
        exit=run.returncode,
        stdout=run.stdout[-1500:],
        stderr=run.stderr[-1500:],
    )
    ordinary = ThreadingHTTPServer(("127.0.0.1", 18081), Handler)
    threading.Thread(target=ordinary.serve_forever, daemon=True).start()
    run = as_role(
        "workload",
        ["/usr/bin/curl", "--fail", "--silent", "http://127.0.0.1:18081/ordinary"],
        env=env,
        group="tools",
    )
    record(
        "ordinary_network",
        run.returncode == 0 and run.stdout == '{"data":[]}',
        exit=run.returncode,
        stdout=run.stdout[-2000:],
        stderr=run.stderr[-2000:],
    )
    package = FIXTURE / "package"
    (package / "DEBIAN").mkdir(parents=True)
    (package / "usr/local/bin").mkdir(parents=True)
    (package / "DEBIAN/control").write_text(
        "Package: okou-native-owned-probe\nVersion: 1.0\nArchitecture: all\nMaintainer: Native Fixture <fixture@invalid>\nDescription: Offline disposable native compatibility probe\n"
    )
    helper = package / "usr/local/bin/okou-native-owned-probe"
    import shlex

    helper.write_text(
        "#!/bin/sh\nexec /usr/bin/python3 -c " + shlex.quote(PROBE) + "\n"
    )
    helper.chmod(0o755)
    subprocess.run(
        [
            "/usr/bin/dpkg-deb",
            "--root-owner-group",
            "--build",
            str(package),
            str(FIXTURE / "package.deb"),
        ],
        check=True,
        capture_output=True,
    )
    run = as_role(
        "workload",
        ["/usr/bin/sudo", "-n", "/usr/bin/dpkg", "-i", str(FIXTURE / "package.deb")],
        env=env,
        group="tools",
    )
    record(
        "sudo_offline_package_install",
        run.returncode == 0,
        exit=run.returncode,
        stdout=run.stdout[-2000:],
        stderr=run.stderr[-2500:],
    )
    run = as_role(
        "workload",
        ["/usr/bin/sudo", "-n", "/usr/local/bin/okou-native-owned-probe"],
        env=env,
        group="tools",
    )
    record(
        "installed_tool_root_stays_workload",
        run.returncode == 0 and '"uid": 0' in run.stdout,
        exit=run.returncode,
        stdout=run.stdout[-2000:],
        stderr=run.stderr[-2500:],
    )
    run = as_role(
        "agent",
        ["/usr/bin/test", "!", "-e", "/usr/local/bin/okou-native-owned-probe"],
        env=env,
    )
    record(
        "agent_dependency_view_separate",
        run.returncode == 0,
        exit=run.returncode,
        stderr=run.stderr[-1500:],
    )
    terminal_script = 'import os,pty; master,slave=pty.openpty(); os.write(slave,b"native-terminal\\n"); value=os.read(master,128); assert b"native-terminal" in value; os.close(master); os.close(slave); print("terminal read/write completed")'
    run = as_role(
        "workload", ["/usr/bin/python3", "-c", terminal_script], env=env, group="tools"
    )
    record(
        "workload_terminal",
        run.returncode == 0,
        exit=run.returncode,
        stdout=run.stdout[-2000:],
        stderr=run.stderr[-2000:],
    )
    for binary in ("/usr/bin/node", "/usr/local/bin/claude", "/usr/bin/codex"):
        run = as_role("agent", [binary, "--version"], env=env)
        record(
            Path(binary).name + "_packaged_version",
            run.returncode == 0,
            exit=run.returncode,
            stdout=run.stdout[-1000:],
            stderr=run.stderr[-3000:],
        )

    def png_chunk(kind, data):
        return (
            struct.pack("!I", len(data))
            + kind
            + data
            + struct.pack("!I", zlib.crc32(kind + data))
        )

    image = ROOT / "native-image.png"
    pixels = (b"\0" + b"\x20\x80\xe0" * 4000) * 3000
    image.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack("!IIBBBBB", 4000, 3000, 8, 2, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(pixels))
        + png_chunk(b"IEND", b"")
    )
    del pixels
    os.chown(image, 1000, 1000)
    label(image, "workload_data_t")
    worker_script = """import {Worker} from 'node:worker_threads'; import fs from 'node:fs';
const worker=new Worker(new URL('file:///usr/local/lib/okou-cli/9.400.3/image-resize-worker.js'),{execArgv:[]});
try { await new Promise((resolve,reject)=>{
 const deadline=setTimeout(()=>reject(new Error('worker deadline')),10000);
 worker.on('error',reject); worker.on('exit',code=>{if(code)reject(new Error('worker exit '+code));});
 worker.on('message',message=>{if(message.type!=='pi:image-resize-response')return; clearTimeout(deadline);
  const r=message.result; if(message.error||!r||r.originalWidth!==4000||r.originalHeight!==3000||r.width!==1024||r.height!==768||!r.wasResized){reject(new Error(JSON.stringify(message)));return;}
  console.log(JSON.stringify({width:r.width,height:r.height,originalWidth:r.originalWidth,originalHeight:r.originalHeight,wasResized:r.wasResized,mimeType:r.mimeType}));resolve();});
 worker.postMessage({inputBytes:new Uint8Array(fs.readFileSync('/home/user/workspace/native-image.png')),mimeType:'image/png',options:{maxWidth:1024,maxHeight:1024}});
}); } finally {await worker.terminate();}"""
    run = as_role(
        "agent",
        ["/usr/bin/node", "--input-type=module", "-e", worker_script],
        env=env,
        timeout=20,
    )
    record(
        "packaged_image_worker_round_trip",
        run.returncode == 0,
        exit=run.returncode,
        stdout=run.stdout[-1500:],
        stderr=run.stderr[-2000:],
    )
    startup_probe = """import json,os,socket
from pathlib import Path
s=socket.socket(); s.settimeout(1); result=s.connect_ex(("127.0.0.1",18080))
context=Path("/proc/self/attr/current").read_text().strip().strip("\\0")
with open("/home/user/workspace/untrusted-shell-observations.jsonl","a") as f: f.write(json.dumps({"framework":os.environ.get("OKOU_NATIVE_FRAMEWORK"),"uid":os.getuid(),"context":context,"connectErrno":result})+"\\n")
if result==0:
 s.sendall(b"GET /untrusted-shell-ingress HTTP/1.0\\r\\nHost: fixture\\r\\n\\r\\n"); s.recv(1024)
s.close()
"""
    profile = Path("/home/user/.bash_profile")
    profile.write_text(
        "# Owned benign native startup probe\n/usr/bin/python3 -c "
        + shlex.quote(startup_probe)
        + "\n"
    )
    os.chown(profile, 1000, 1000)
    label(profile, "workload_data_t")
    extension = Path("/home/user/.pi/agent/extensions/native-probe.js")
    extension.parent.mkdir(parents=True, exist_ok=True)
    extension.write_text(
        'import fs from "node:fs";\nexport default function () { fs.writeFileSync("/home/user/workspace/untrusted-extension-executed", JSON.stringify({uid:process.getuid(),context:fs.readFileSync("/proc/self/attr/current","utf8")})); void fetch("http://127.0.0.1:18080/untrusted-extension-ingress"); }\n'
    )
    for path in (extension, extension.parent):
        label(path, "workload_data_t")
        os.chown(path, 1000, 1000)
    settings = extension.parent.parent / "settings.json"
    settings.write_text(
        json.dumps({"extensions": [str(extension)], "projectTrusted": True})
    )
    label(settings, "workload_data_t")
    os.chown(settings, 1000, 1000)

    loader_script = packaged_resources.loader_script()
    control = as_role(
        "agent-resource-control",
        ["/usr/bin/node", "--input-type=module", "-e", loader_script],
        env=env,
    )
    executed = ROOT / "untrusted-extension-executed"
    connected = ROOT / "untrusted-extension-connected"
    control_identity = json.loads(executed.read_text()) if executed.exists() else {}
    control_loaded = (
        control.returncode == 0
        and control_identity.get("uid") == 1000
        and control_identity.get("context", "").rstrip("\0")
        == "system_u:system_r:agent_t"
        and connected.exists()
    )
    record(
        "pi_extension_known_load_control",
        control_loaded,
        qualified=control_loaded,
        identity=control_identity,
        ingressObserved=connected.exists(),
        stdout=control.stdout[-3000:],
        stderr=control.stderr[-1500:],
    )
    executed.unlink(missing_ok=True)
    connected.unlink(missing_ok=True)

    pi_exit, records = pi_session(env)
    (FIXTURE / "pi.records.json").write_text(json.dumps(records))
    tool_results = [r for r in records if r.get("type") == "tool_execution_end"]
    read_result = next((r for r in tool_results if r.get("toolName") == "read"), {})
    image_contents = read_result.get("result", {}).get("content", [])
    image_read = (
        read_result.get("isError") is False
        and any(c.get("type") == "image" for c in image_contents)
        and any("original 4000x3000" in c.get("text", "") for c in image_contents)
    )
    record("pi_real_image_read", image_read, result=compact(read_result))
    record(
        "pi_real_tool_subagent",
        pi_exit == 0 and (ROOT / "pi-tool").exists() and (ROOT / "pi-child").exists(),
        exit=pi_exit,
        records=len(records),
        failureRecords=[
            {"type": r.get("type"), "message": compact(r.get("message"))}
            for r in records
            if isinstance(r.get("message"), dict)
            and r["message"].get("stopReason") == "error"
        ],
        toolResults=compact(tool_results[:4]),
        stderr=(FIXTURE / "pi.stderr").read_text()[-5000:],
    )
    run = as_role(
        "agent", ["/usr/bin/node", "--input-type=module", "-e", loader_script], env=env
    )
    record(
        "pi_sdk_extension_loader_diagnostic",
        run.returncode == 0
        and json.loads(run.stdout) == {"extensions": [], "errors": []},
        exit=run.returncode,
        stdout=run.stdout[-4000:],
        stderr=run.stderr[-2500:],
    )
    record(
        "untrusted_pi_extension_denied",
        control_loaded
        and pi_exit == 0
        and not executed.exists()
        and not connected.exists()
        and run.returncode == 0
        and json.loads(run.stdout) == {"extensions": [], "errors": []},
        qualified=control_loaded,
        executed=executed.read_text() if executed.exists() else None,
        ingressObserved=connected.exists(),
        negativeProbeQualification="same packaged SDK/CLI loader, with successful agent-role load control and frozen discovery roots",
    )
    mutation = as_role(
        "agent",
        [
            "/usr/bin/python3",
            "-c",
            """import errno,pathlib
for path in ('/home/user/.pi/agent/settings.json','/home/user/workspace/.pi/settings.json','/home/user/.pi/agent/models.json','/home/user/.pi/agent/extensions/new.js'):
 try: pathlib.Path(path).write_text('{}')
 except OSError as e: assert e.errno in (errno.EACCES,errno.EPERM,errno.EROFS),e
 else: raise AssertionError('agent changed executable resource configuration')
print('frozen configuration rejects in-process writes')""",
        ],
        env=env,
    )
    record(
        "pi_frozen_resource_mutation_denied",
        mutation.returncode == 0,
        stdout=mutation.stdout,
        stderr=mutation.stderr[-1500:],
    )
    anchors = []
    for role in ("workload", "root"):
        anchor_probe = as_role(
            role,
            [
                "/usr/bin/python3",
                "-c",
                """import errno,os,pathlib
for path in ('/home/user/.pi','/home/user/workspace/.pi'):
 p=pathlib.Path(path); (p/'ordinary-tool-data').write_text('retained tool access')
for path in ('/home','/home/user','/home/user/workspace','/home/user/.pi','/home/user/workspace/.pi','/home/.pi','/.pi'):
 try: os.rename(path,path+'.moved')
 except OSError as e: assert e.errno in (errno.EACCES,errno.EPERM,errno.EBUSY),e
 else: raise AssertionError('resource mount anchor moved')
print('tool data remains writable; discovery anchors cannot move')""",
            ],
            env=env,
            group="tools",
        )
        anchors.append(
            {
                "role": role,
                "exit": anchor_probe.returncode,
                "stdout": anchor_probe.stdout,
                "stderr": anchor_probe.stderr[-1500:],
            }
        )
    record(
        "pi_resource_anchors_stable",
        all(a["exit"] == 0 for a in anchors),
        observations=anchors,
    )
    retained = as_role(
        "agent",
        [
            "/usr/bin/python3",
            "-c",
            "from pathlib import Path; p=Path('/home/user/.pi/agent/sessions/native-retained.txt'); p.write_text('retained session data'); assert p.read_text()=='retained session data'",
        ],
        env=env,
    )
    record(
        "pi_retained_sessions",
        retained.returncode == 0
        and Path("/home/user/.pi/agent/sessions/native-retained.txt").read_text()
        == "retained session data",
        stderr=retained.stderr[-1500:],
    )
    private_state = []
    for role in ("workload", "root"):
        run = as_role(
            role,
            [
                "/usr/bin/python3",
                "-c",
                """import errno,pathlib
p=pathlib.Path('/fixture/pi-resources/agent/auth.json')
for operation in (p.read_text,lambda:p.write_text('{}')):
 try: operation()
 except OSError as e: assert e.errno in (errno.EACCES,errno.EPERM),e
 else: raise AssertionError('workload accessed private agent state')
print('private credential state inaccessible')""",
            ],
            env=env,
            group="tools",
        )
        private_state.append(
            {"role": role, "exit": run.returncode, "stderr": run.stderr[-1500:]}
        )
    record(
        "pi_private_state_denied",
        all(p["exit"] == 0 for p in private_state),
        observations=private_state,
    )
    claude_env = {
        **env,
        "OKOU_NATIVE_FRAMEWORK": "claude",
        "ANTHROPIC_API_KEY": "synthetic-no-provider-authority",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:18080",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
    }
    try:
        run = as_role(
            "agent",
            [
                "/usr/local/bin/claude",
                "--print",
                "CLAUDE_MAIN",
                "--dangerously-skip-permissions",
                "--output-format",
                "stream-json",
                "--verbose",
                "--model",
                "claude-sonnet-4-6",
            ],
            env=claude_env,
            timeout=60,
        )
        (FIXTURE / "claude.stdout").write_text(run.stdout)
        record(
            "claude_real_tool_subagent",
            run.returncode == 0
            and (ROOT / "claude-tool").exists()
            and (ROOT / "claude-child").exists(),
            exit=run.returncode,
            stdout=run.stdout[-2500:],
            stderr=run.stderr[-3000:],
        )
    except subprocess.TimeoutExpired as error:
        record(
            "claude_real_tool_subagent",
            False,
            error="runtime timeout",
            stdout=str(error.stdout)[-2500:],
            stderr=str(error.stderr)[-3000:],
        )
    codex_home = Path("/home/user/.codex")
    codex_home.mkdir(exist_ok=True)
    (codex_home / "config.toml").write_text(
        'model = "gpt-5.1-codex-mini"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\nmulti_agent = true\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:18080/v1"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n'
    )
    os.chown(codex_home, 1000, 1000)
    os.chown(codex_home / "config.toml", 1000, 1000)
    label(codex_home, "workload_data_t")
    label(codex_home / "config.toml", "workload_data_t")
    try:
        run = as_role(
            "agent",
            [
                "/usr/bin/codex",
                "exec",
                "--dangerously-bypass-approvals-and-sandbox",
                "--skip-git-repo-check",
                "--json",
                "CODEX_MAIN",
            ],
            env={
                **env,
                "CODEX_HOME": str(codex_home),
                "OKOU_NATIVE_FRAMEWORK": "codex",
            },
            timeout=60,
        )
        (FIXTURE / "codex.stdout").write_text(run.stdout)
        record(
            "codex_real_tool_subagent",
            run.returncode == 0
            and (ROOT / "codex-tool").exists()
            and (ROOT / "codex-child").exists(),
            exit=run.returncode,
            stdout=run.stdout[-2500:],
            stderr=run.stderr[-3000:],
        )
    except subprocess.TimeoutExpired as error:
        record(
            "codex_real_tool_subagent",
            False,
            error="runtime timeout",
            stdout=str(error.stdout)[-2500:],
            stderr=str(error.stderr)[-3000:],
        )
    packaged_history.probe(FIXTURE, env, as_role, pi_session, requests, record)
    for role in ("workload", "root"):
        name = ("user" if role == "workload" else "root") + "_task_stop_workload"
        handle = next(iter(tasks), None)
        if handle is None:
            record(name, False, error="no managed task was created")
            continue
        before = len(stop_peers)
        run = as_role(
            role, ["/fixture/guest-task-exec", "stop", handle], env=env, group="tools"
        )
        observed = stop_peers[before:]
        record(
            name,
            run.returncode == 0
            and observed
            == [
                {
                    "uid": 1000,
                    "context": "system_u:system_r:workload_t",
                    "capEff": "0000000000000000",
                }
            ],
            exit=run.returncode,
            peers=observed,
            stderr=run.stderr[-1500:],
        )
    packaged_storage.probe(FIXTURE, ROOT, env, as_role, record)
    packaged_resources.cgroup_probes(env, as_role, record)
    packaged_browser.probe(env, as_role, record)
    packaged_accounting.probe(
        CG, env, as_role, record, pi_session, resource_ready, resource_release
    )
    packaged_lifecycle.probe(ROOT, env, pi_session, tasks, record)
    packaged_mcp.probe(FIXTURE, ROOT, env, as_role, label, record)
    observations_path = ROOT / "untrusted-shell-observations.jsonl"
    observations = (
        [json.loads(line) for line in observations_path.read_text().splitlines()]
        if observations_path.exists()
        else []
    )
    coverage = {"claude", "codex"}.issubset({o["framework"] for o in observations})
    record(
        "untrusted_shell_startup_denied",
        coverage
        and all(
            o["context"] == "system_u:system_r:workload_t"
            and o["connectErrno"] in (errno.EACCES, errno.EPERM)
            for o in observations
        ),
        observations=observations,
        loginShellFrameworksObserved=coverage,
        ingressObserved=(ROOT / "untrusted-shell-connected").exists(),
    )
    record(
        "enforcing_after_runtimes",
        Path("/sys/fs/selinux/enforce").read_text().strip() == "1",
    )
    kernel = {
        "architecture": os.uname().machine,
        "release": os.uname().release,
        "lsm": Path("/sys/kernel/security/lsm").read_text().strip()
        if Path("/sys/kernel/security/lsm").exists()
        else "not-mounted",
        "enforcing": Path("/sys/fs/selinux/enforce").read_text().strip() == "1",
    }
    summary = {
        "bootMode": "restored" if restoration else "fresh",
        "restoration": restoration,
        "results": results,
        "requests": requests,
        "brokerErrors": errors,
        "gateF": "incomplete",
        "kernel": kernel,
        "installedManifest": json.loads(
            Path("/usr/local/lib/okou-cli/installed.json").read_text()
        ),
    }
    audit = b""
    fd = os.open("/dev/kmsg", os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        while len(audit) < 1024 * 1024:
            try:
                audit += os.read(fd, 16384)
            except BlockingIOError:
                break
    finally:
        os.close(fd)
    summary["kernelAuditTail"] = audit.decode(errors="replace")[-8192:]
    summary["kernelAuditDeniedEvents"] = sum(
        b"avc:" in line and b"denied" in line for line in audit.splitlines()
    )
    Path("/native-result.json").write_text(json.dumps(summary))
    print(
        "PACKAGED_DONE "
        + json.dumps(
            {
                "cases": len(results),
                "requests": len(requests),
                "brokerErrors": len(errors),
            }
        ),
        flush=True,
    )
    keeper.kill()
    keeper.wait()
    os.kill(workload_pid, signal.SIGKILL)
    os.waitpid(workload_pid, 0)


def main():
    with ExitStack() as resources:
        run_guest(resources)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        Path("/native-result.json").write_text(
            json.dumps(
                {
                    "gateF": "incomplete",
                    "fixtureError": str(error),
                    "results": results,
                    "brokerErrors": errors,
                }
            )
        )
        traceback.print_exc()
        print("PACKAGED_FATAL setup_or_runtime", flush=True)
        raise
    finally:
        os.sync()
        ctypes.CDLL(None).reboot(0x1234567)
