"""Disposable Guest prototype: real packaged runtimes, synthetic HTTP peers."""

import array
import base64
import ctypes
import errno
import hashlib
import json
import os
import select
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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
spawned = set()
request_counts = {}
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
    if group != ("runtime" if role == "agent" else "tools"):
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


def pi_session(env):
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
                json.dumps({"id": "native", "type": "prompt", "message": "PI_MAIN"})
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
                        path = tasks[request["handle"]]
                        (path / "cgroup.kill").write_text("1")
                        frame(peer, {"status": "stopped"})
                        continue
                    if request != {"op": "launch"}:
                        raise ValueError("invalid launch")
                    handle = str(uuid.uuid4())
                    parent = CG / "tools" / ("task-" + handle)
                    parent.mkdir()
                    (parent / "runtime").mkdir()
                    (parent / "tools").mkdir()
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


def namespace_broker(keeper_pid, workload_pid):
    handles = {
        b"T": os.open(f"/proc/{workload_pid}/ns/mnt", os.O_RDONLY | os.O_CLOEXEC),
        b"A": os.open(f"/proc/{keeper_pid}/ns/mnt", os.O_RDONLY | os.O_CLOEXEC),
    }
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
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
    return listener


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
    child = "PI_CHILD" in text and "PI_MAIN" not in text
    if "CLAUDE_CHILD" in text and "CLAUDE_MAIN" not in text:
        child = True
    if "CODEX_CHILD" in text and "CODEX_MAIN" not in text:
        child = True
    name = (
        "pi" if dialect == "chat" else ("claude" if dialect == "anthropic" else "codex")
    )
    marker = name + ("-child" if child else "-tool")
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
        requests.append(
            {
                "path": self.path,
                "bytes": length,
                "tools": tools,
                "lastInput": json.dumps(messages[-1])[-1800:] if messages else "",
            }
        )
        print("PACKAGED_HTTP " + json.dumps(requests[-1]), flush=True)
        request_counts[dialect] = request_counts.get(dialect, 0) + 1
        if request_counts[dialect] > 16:
            self.send_error(400, "bounded synthetic fixture request budget")
            return
        if "count_tokens" in self.path:
            raw = b'{"input_tokens":100}'
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        name, arguments = choose(payload, dialect)
        if name and name not in tools:
            errors.append("requested tool missing: " + name + " in " + repr(tools))
        call = "call_" + str(len(requests))
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


def main():
    socket.sethostname("localhost")
    (Path("/sys/fs/selinux/enforce")).write_text("1")
    Path("/proc/sys/kernel/printk_ratelimit").write_text("0")
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
        os.chmod(FIXTURE / name, 0o4755)
    ROOT.mkdir(parents=True, exist_ok=True)
    for path in (Path("/home/user"), ROOT):
        os.chown(path, 1000, 1000)
        label(path, "workload_data_t")
    (CG / "runtime").mkdir(parents=True)
    (CG / "tools").mkdir()
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
    namespace_broker(keeper.pid, workload_pid)
    broker("okou-native-placement")
    broker("okou-native-placement-tasks", task=True)
    server = ThreadingHTTPServer(("127.0.0.1", 18080), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
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
    for path in [extension, *list(extension.parents)[:3]]:
        label(path, "workload_data_t")
        os.chown(path, 1000, 1000)
    settings = extension.parent.parent / "settings.json"
    settings.write_text(
        json.dumps({"extensions": [str(extension)], "projectTrusted": True})
    )
    label(settings, "workload_data_t")
    os.chown(settings, 1000, 1000)

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
        toolResults=compact(tool_results[:4]),
        stderr=(FIXTURE / "pi.stderr").read_text()[-5000:],
    )
    executed = ROOT / "untrusted-extension-executed"
    connected = ROOT / "untrusted-extension-connected"
    record(
        "untrusted_pi_extension_denied",
        False,
        qualified=False,
        executed=executed.read_text() if executed.exists() else None,
        ingressObserved=connected.exists(),
        negativeProbeQualification="execution is conclusive failure; absence alone is unqualified until a separate known-load control succeeds",
    )
    loader_script = """import {createAgentSessionServices} from "/usr/local/lib/okou-cli/9.400.3/chunk-D5UXOEXQ.js";
const services=await createAgentSessionServices({cwd:process.cwd(),agentDir:"/home/user/.pi/agent",modelRuntime:{refresh:async()=>{}}});
const result=services.resourceLoader.getExtensions();
console.log(JSON.stringify({extensions:result.extensions.map(e=>e.path),errors:result.errors}));
await new Promise(resolve=>setTimeout(resolve,50));"""
    run = as_role(
        "agent", ["/usr/bin/node", "--input-type=module", "-e", loader_script], env=env
    )
    record(
        "pi_sdk_extension_loader_diagnostic",
        run.returncode == 0,
        exit=run.returncode,
        stdout=run.stdout[-4000:],
        stderr=run.stderr[-2500:],
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
        "results": results,
        "requests": requests,
        "brokerErrors": errors,
        "gateF": "incomplete",
        "kernel": kernel,
        "installedManifest": json.loads(
            Path("/usr/local/lib/okou-cli/installed.json").read_text()
        ),
    }
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


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        print("PACKAGED_FATAL setup_or_runtime", flush=True)
        raise
    finally:
        os.sync()
        ctypes.CDLL(None).reboot(0x1234567)
