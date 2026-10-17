"""Native external-tool handoff through the real packaged MCP clients."""

import array
import base64
import json
import os
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import threading
from contextlib import contextmanager
from pathlib import Path

import packaged_audit


def tool_arguments(tag):
    command = "exec " + shlex.join(
        ["/usr/bin/python3", "/fixture/packaged_mcp_peer.py", tag]
    )
    envelope = base64.urlsafe_b64encode(command.encode()).decode().rstrip("=")
    return [
        "/fixture/real-guest-tool-exec",
        f"--command-envelope=vm0.command.v1.{len(command.encode())}.{envelope}",
        "--shell",
        "/bin/bash",
    ]


@contextmanager
def workload_broker(fixture, root, env):
    observations, failures = {}, []
    stop = threading.Event()
    workers = []
    seen = {}
    admission = threading.Lock()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind("\0okou-native-mcp")
    listener.listen(2)
    listener.settimeout(0.1)

    def serve(peer):
        descriptors, child = [], None
        try:
            with peer:
                peer.settimeout(35)
                pid, uid, _gid = struct.unpack(
                    "3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
                )
                context = (
                    peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERSEC, 128)
                    .decode()
                    .rstrip("\0")
                )
                if uid != 1000 or context != "system_u:system_r:workload_t":
                    raise ValueError("unexpected MCP launcher identity")
                tag, ancillary, flags, _address = peer.recvmsg(
                    32, socket.CMSG_SPACE(3 * 4), socket.MSG_CMSG_CLOEXEC
                )
                for level, kind, raw in ancillary:
                    if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                        received = array.array("i")
                        received.frombytes(raw)
                        descriptors.extend(received)
                    else:
                        raise ValueError("unexpected MCP ancillary message")
                tag = tag.decode("ascii")
                if (
                    flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC)
                    or len(descriptors) != 3
                    or tag not in {"claude-lowered", "codex-lowered"}
                ):
                    raise ValueError("invalid bounded MCP request")
                with admission:
                    if seen.get(tag, 0) >= 2:
                        raise ValueError(
                            "MCP fixture discovery/restart budget exceeded"
                        )
                    seen[tag] = seen.get(tag, 0) + 1
                status = dict(
                    line.split(":", 1)
                    for line in Path(f"/proc/{pid}/status").read_text().splitlines()
                    if ":" in line
                )
                observed = {
                    "uid": uid,
                    "context": context,
                    "capEff": status["CapEff"].strip(),
                    "capBnd": status["CapBnd"].strip(),
                    "noNewPrivs": int(status["NoNewPrivs"].strip()),
                }
                observations[tag] = observed
                if observed["capEff"] != "0000000000000000" or observed[
                    "noNewPrivs"
                ] not in (0, 1):
                    raise ValueError("MCP launcher retained effective authority")
                # The broker selects the fixed helper and preserves the actual
                # caller's bounding/NNP restrictions before external execution.
                child = subprocess.Popen(
                    [
                        str(fixture / "entry"),
                        "mcp-workload",
                        observed["capBnd"],
                        str(observed["noNewPrivs"]),
                        *tool_arguments(tag),
                    ],
                    cwd=root,
                    env=env,
                    stdin=descriptors[0],
                    stdout=descriptors[1],
                    stderr=descriptors[2],
                    start_new_session=True,
                )
                result = child.wait(timeout=30)
                observed.update(childPid=child.pid, cleanup="joined", exit=result)
                try:
                    peer.sendall(bytes([result if 0 <= result <= 125 else 125]))
                except (BrokenPipeError, ConnectionResetError):
                    # The vendor may close stdio after its turn. Completion and
                    # child ownership were recorded before this notification.
                    pass
        except (OSError, ValueError, subprocess.TimeoutExpired, struct.error) as error:
            failures.append(str(error))
        finally:
            if child is not None:
                if child.poll() is None:
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        # Natural exit can win the poll/kill race; wait below
                        # still collects the exact owned child.
                        pass
                child.wait(timeout=5)
            for fd in descriptors:
                os.close(fd)

    def accept():
        while not stop.is_set():
            try:
                peer, _address = listener.accept()
            except TimeoutError:
                continue
            if len(workers) >= 4:
                peer.close()
                if not failures:
                    failures.append("MCP fixture request budget exceeded")
                continue
            worker = threading.Thread(target=serve, args=(peer,))
            workers.append(worker)
            worker.start()

    owner = threading.Thread(target=accept)
    owner.start()
    try:
        yield observations
    finally:
        stop.set()
        owner.join(timeout=1)
        listener.close()
        for worker in workers:
            worker.join(timeout=35)
        if owner.is_alive() or any(w.is_alive() for w in workers) or failures:
            raise ValueError("MCP workload owner failed: " + repr(failures))


def probe(fixture, root, env, as_role, label, record):
    entry = fixture / "mcp-workload-exec"
    shutil.copyfile(fixture / "entry", entry)
    os.chown(entry, 1000, 1000)
    entry.chmod(0o500)
    label(entry, "workload_shell_exec_t")
    with workload_broker(fixture, root, env) as bootstrap:
        _probe(fixture, root, env, as_role, label, record, bootstrap)


def _probe(fixture, root, env, as_role, label, record, bootstrap):
    codex_config = Path("/home/user/.codex/config.toml").read_text()
    for framework in ("claude", "codex"):
        for mode in ("direct", "lowered"):
            tag = framework + "-" + mode
            args = ["/usr/bin/python3", "/fixture/packaged_mcp_peer.py", tag]
            if mode == "lowered":
                args = ["/fixture/mcp-workload-exec", tag]
            current_env = {**env, "OKOU_NATIVE_FRAMEWORK": framework}
            current_env["RUST_LOG"] = (
                "codex_core::mcp_connection_manager=debug,rmcp=debug"
            )
            if framework == "claude":
                config = fixture / ("mcp-" + tag + ".json")
                config.write_text(
                    json.dumps(
                        {
                            "mcpServers": {
                                "native-probe": {
                                    "type": "stdio",
                                    "command": args[0],
                                    "args": args[1:],
                                }
                            }
                        }
                    )
                )
                current_env.update(
                    {
                        "ANTHROPIC_API_KEY": "synthetic-no-provider-authority",
                        "ANTHROPIC_BASE_URL": "http://127.0.0.1:18080",
                        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                        "DISABLE_AUTOUPDATER": "1",
                    }
                )
                invocation = [
                    "/usr/local/bin/claude",
                    "--print",
                    "CLAUDE_MCP " + tag,
                    "--dangerously-skip-permissions",
                    "--model",
                    "claude-sonnet-4-6",
                    "--strict-mcp-config",
                    "--mcp-config",
                    str(config),
                ]
            else:
                home = fixture / ("mcp-" + tag)
                home.mkdir()
                os.chown(home, 1000, 1000)
                label(home, "runtime_state_t")
                snapshots = home / "shell_snapshots"
                snapshots.mkdir()
                os.chown(snapshots, 1000, 1000)
                label(snapshots, "workload_data_t")
                (home / "config.toml").write_text(
                    codex_config
                    + "\n[mcp_servers.native_probe]\ncommand = "
                    + json.dumps(args[0])
                    + "\nargs = "
                    + json.dumps(args[1:])
                    + "\nstartup_timeout_sec = 5\n"
                )
                current_env["CODEX_HOME"] = str(home)
                invocation = [
                    "/usr/bin/codex",
                    "exec",
                    "--dangerously-bypass-approvals-and-sandbox",
                    "--skip-git-repo-check",
                    "--json",
                    "CODEX_MCP " + tag,
                ]
            with packaged_audit.capture() as audit:
                try:
                    run = as_role("agent", invocation, env=current_env, timeout=30)
                    status, stdout, stderr = run.returncode, run.stdout, run.stderr
                except subprocess.TimeoutExpired as error:
                    status, stdout, stderr = None, str(error.stdout), str(error.stderr)
            path = root / ("mcp-" + tag + ".json")
            observed = json.loads(path.read_text()) if path.exists() else {}
            ingress = (root / ("mcp-" + tag + "-connected")).exists()
            allowed = mode == "direct"
            passed = (
                status == 0
                and observed.get("uid") == 1000
                and observed.get("initialized") is True
                and observed.get("capEff") == "0000000000000000"
                and observed.get("context")
                == "system_u:system_r:" + ("agent_t" if allowed else "workload_t")
                and observed.get("connectErrno") in ((0,) if allowed else (1, 13))
                and ingress is allowed
            )
            record(
                framework + "_mcp_" + mode,
                passed,
                exit=status,
                identity=observed,
                ingressObserved=ingress,
                stdout=stdout[-1500:],
                stderr=stderr[-2500:],
                peerError=(root / ("mcp-" + tag + ".error")).read_text()
                if (root / ("mcp-" + tag + ".error")).exists()
                else None,
                bootstrap=bootstrap.get(tag),
                audit=audit["denials"],
            )
