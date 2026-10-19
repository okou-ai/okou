#!/usr/bin/env python3
"""Exercise the real observer/renderer CLI against isolated Linux TCP processes."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

OWNER = Path(__file__).resolve().parents[1] / "runner"
PAYLOAD = b"payload-must-stay-private" * 256
CLIENT = """
import os,socket,sys
connection=socket.create_connection(('127.0.0.1', int(os.environ.get('TCP_TEST_PORT',sys.argv[1]))))
print('ready',flush=True)
for line in sys.stdin:
    if line.strip()=='send':
        connection.sendall(b'payload-must-stay-private'*256)
        print('sent',flush=True)
connection.close()
"""


def wait_for(read, accept):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        try:
            result = read()
            if accept(result):
                return result
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(0.02)
    raise AssertionError("observable client diagnostic did not arrive")


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def receive(connection, size):
    result = b""
    connection.settimeout(2)
    while len(result) < size:
        chunk = connection.recv(size - len(result))
        assert chunk, "fixture connection closed before its expected payload"
        result += chunk
    return result


def main(directory):
    children = []
    sockets = []
    try:
        for _ in range(2):
            listener = socket.socket()
            sockets.append(listener)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            child = subprocess.Popen(
                [sys.executable, "-c", CLIENT, str(listener.getsockname()[1])],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
            )
            children.append(child)
            accepted, _ = listener.accept()
            sockets.append(accepted)
            assert child.stdout.readline().strip() == "ready"

        child, unrelated = children
        path = directory / "tcp.log"
        sampler = subprocess.Popen(
            [
                sys.executable,
                str(OWNER / "cloudflare-ssh-tcp.py"),
                str(child.pid),
                str(path),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        children.append(sampler)
        initial = wait_for(
            lambda: records(path),
            lambda rows: any(r.get("event") == "tcp-sample" for r in rows),
        )
        target_port = sockets[0].getsockname()[1]
        other_port = sockets[2].getsockname()[1]
        for row in initial:
            if row.get("event") == "tcp-sample":
                assert row["pid"] == child.pid and row["peer_port"] == target_port
                assert row["peer_port"] != other_port
                assert row["start_ticks"] > 0 and row["monotonic_ns"] > 0
                assert row["rtt_us"] >= 0 and row["total_retrans"] >= 0
        child.stdin.write("send\n")
        child.stdin.flush()
        assert child.stdout.readline().strip() == "sent"
        assert receive(sockets[1], len(PAYLOAD)) == PAYLOAD
        observed = wait_for(
            lambda: records(path),
            lambda rows: any(r.get("bytes_acked", 0) >= len(PAYLOAD) for r in rows),
        )
        assert "payload-must-stay-private" not in path.read_text()
        assert path.stat().st_mode & 0o777 == 0o600
        assert len(observed) <= 16
        child.stdin.close()
        assert child.wait(timeout=2) == 0
        assert sampler.wait(timeout=2) == 0
        assert sampler.communicate() == (b"", b"")

        # Killing the passive observer leaves the observed TCP stream usable.
        second_path = directory / "second.log"
        second = subprocess.Popen(
            [
                sys.executable,
                str(OWNER / "cloudflare-ssh-tcp.py"),
                str(unrelated.pid),
                str(second_path),
            ],
        )
        children.append(second)
        wait_for(
            lambda: records(second_path),
            lambda rows: any(r.get("event") == "tcp-sample" for r in rows),
        )
        second.terminate()
        assert second.wait(timeout=2) == -15
        unrelated.stdin.write("send\n")
        unrelated.stdin.flush()
        assert unrelated.stdout.readline().strip() == "sent"
        assert receive(sockets[3], len(PAYLOAD)) == PAYLOAD

        # Exercise the production proxy owner, including a live sampler, for
        # both ordinary completion and cancellation. The fake is only the
        # external cloudflared process; the proxy and observer remain real.
        fake = directory / "cloudflared"
        fake.write_text("#!" + sys.executable + "\n" + CLIENT)
        fake.chmod(0o755)
        access = directory / "access.env"
        access.write_text(
            "CF_ACCESS_CLIENT_ID=fixture-id\nCF_ACCESS_CLIENT_SECRET=fixture-secret\n"
        )
        for cancel in (False, True):
            managed = directory / f"managed-{cancel}"
            proxy = subprocess.Popen(
                [str(OWNER / "cloudflare-ssh-proxy.sh"), "fixture.vm3.ai"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env={
                    **os.environ,
                    "CF_ACCESS_ENV_FILE": str(access),
                    "CLOUDFLARED_BIN": str(fake),
                    "TCP_TEST_PORT": str(target_port),
                    "OKOU_CLOUDFLARE_SSH_PROXY_DIAGNOSTICS_DIR": str(managed),
                },
            )
            children.append(proxy)
            accepted, _ = sockets[0].accept()
            sockets.append(accepted)
            assert proxy.stdout.readline().strip() == "ready"
            log = wait_for(
                lambda managed=managed: list(managed.glob("proxy.*/tcp.log")), bool
            )[0]
            wait_for(
                lambda log=log: records(log),
                lambda rows: any(r.get("event") == "tcp-sample" for r in rows),
            )
            if cancel:
                proxy.terminate()
            else:
                proxy.stdin.close()
            assert proxy.wait(timeout=3) == (143 if cancel else 0)
            events = (log.parent / "events.log").read_text().splitlines()
            started = next(
                line for line in events if line.startswith("event=tcp-sampler-start ")
            )
            sampler_pid = int(
                dict(item.split("=", 1) for item in started.split())["sampler_pid"]
            )
            try:
                os.kill(sampler_pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError("proxy left its TCP observer alive")
            output = proxy.stdout.read()
            errors = proxy.stderr.read()
            assert not output and "fixture-secret" not in errors
            if not cancel:
                assert not errors

        # Actual renderer publication must reserve every evidence category even
        # when multiple proxy histories are noisy, and redact native metadata.
        master = directory / "master.stderr"
        master.write_text("SSH_MASTER_FAILURE\n")
        for index in range(4):
            proxy = directory / "master.stderr.proxies" / f"proxy.{index}"
            (proxy / "application").mkdir(parents=True)
            (proxy / "events.log").write_text(
                ("lifecycle-" + "x" * 200 + "\n") * 12 + "event=proxy-exit status=0\n"
            )
            native = {
                "message": f"reset-evidence-{index}",
                "originURL": "https://user:fixture-secret@example.test/path?token=fixture-secret",
                "headers": {"Authorization": "fixture-secret"},
                "event": {},
            }
            (proxy / "application" / "cloudflared.log").write_text(
                (json.dumps({"message": "noise-" + "x" * 400}) + "\n") * 11
                + json.dumps(native)
                + "\n"
            )
            (proxy / "stderr.log").write_text(("stderr-" + "x" * 1000 + "\n") * 8)
            (proxy / "tcp.log").write_text(path.read_text())
        result = subprocess.run(
            [
                sys.executable,
                str(OWNER / "cloudflare-ssh-log.py"),
                "master",
                str(master),
            ],
            capture_output=True,
            check=True,
        )
        text = result.stdout.decode()
        assert "SSH_MASTER_FAILURE" in text and "tcp-sample" in text
        assert '"origin_host":"example.test"' in text
        assert "fixture-secret" not in text and "Authorization" not in text
        for index in range(4):
            assert f"reset-evidence-{index}" in text
        assert len(result.stdout) <= 65536 and len(text.splitlines()) <= 384

        # A live non-network process is an honest empty observation, not a
        # fabricated zero-byte TCP connection or a claim that the peer closed it.
        idle = subprocess.Popen(
            [sys.executable, "-c", "input()"], stdin=subprocess.PIPE
        )
        children.append(idle)
        empty_path = directory / "empty.log"
        empty = subprocess.Popen(
            [
                sys.executable,
                str(OWNER / "cloudflare-ssh-tcp.py"),
                str(idle.pid),
                str(empty_path),
            ],
        )
        children.append(empty)
        wait_for(
            lambda: records(empty_path),
            lambda rows: any(r.get("event") == "tcp-no-socket-observed" for r in rows),
        )
        assert not any("bytes_acked" in r for r in records(empty_path))

        # A genuine procfs permission denial stays visible without fabricating
        # TCP statistics. PR_SET_DUMPABLE affects only this owned fixture child.
        denied = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import ctypes,sys; assert ctypes.CDLL(None).prctl(4,0)==0; print('ready',flush=True); sys.stdin.read()",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        children.append(denied)
        assert denied.stdout.readline().strip() == "ready"
        denied_path = directory / "denied.log"
        denied_observer = subprocess.Popen(
            [
                sys.executable,
                str(OWNER / "cloudflare-ssh-tcp.py"),
                str(denied.pid),
                str(denied_path),
            ],
        )
        children.append(denied_observer)
        unavailable = wait_for(
            lambda: records(denied_path),
            lambda rows: any(r.get("event") == "tcp-unavailable" for r in rows),
        )
        assert any(r.get("reason") == "EACCES" for r in unavailable)
        assert not any("bytes_acked" in r for r in unavailable)
        print(
            "cloudflare-ssh-tcp-test: ok (real Linux TCP; controlled fixtures, not production attribution)"
        )
    finally:
        for process in reversed(children):
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=2)
        for connection in sockets:
            connection.close()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as temporary:
        main(Path(temporary))
