#!/usr/bin/python3
"""Local pinned TigerVNC acceptance fixture. JSON line commands on stdin/stdout."""

import json
import ctypes
from functools import partial
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time

from Xlib import X, display


PIN = "1.13.1+dfsg-2build2"


def terminate_with_parent(parent_pid):
    # The Rust guard may SIGKILL Python after a failed/cancelled test. Linux
    # must then terminate each owned helper and the fixture X server too.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGTERM) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG failed")
    if os.getppid() != parent_pid:
        os.kill(os.getpid(), signal.SIGTERM)


def run(*args, **kwargs):
    return subprocess.run(
        args,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        preexec_fn=partial(terminate_with_parent, os.getpid()),
        **kwargs,
    )


def main():
    version = run(
        "dpkg-query", "-W", "-f=${Version}", "tigervnc-standalone-server"
    ).stdout.decode()
    if version != PIN:
        raise RuntimeError(f"expected TigerVNC {PIN}, got {version}")
    scratch_root = (
        Path(sys.argv[1]).resolve()
        if len(sys.argv) > 1
        else Path(__file__).resolve().parent
    )
    with tempfile.TemporaryDirectory(prefix="tigervnc-", dir=scratch_root) as tmp:
        tmp = Path(tmp)
        ca, ca_key = tmp / "ca.pem", tmp / "ca.key"
        cert, key, csr = tmp / "server.pem", tmp / "server.key", tmp / "server.csr"
        run(
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(ca_key),
            "-out",
            str(ca),
            "-days",
            "1",
            "-subj",
            "/CN=RFB acceptance CA",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
        )
        run(
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(csr),
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
            "-addext",
            "basicConstraints=critical,CA:FALSE",
            "-addext",
            "extendedKeyUsage=serverAuth",
        )
        run(
            "openssl",
            "x509",
            "-req",
            "-in",
            str(csr),
            "-CA",
            str(ca),
            "-CAkey",
            str(ca_key),
            "-CAcreateserial",
            "-out",
            str(cert),
            "-days",
            "1",
            "-copy_extensions",
            "copy",
        )
        run(
            "openssl",
            "x509",
            "-in",
            str(ca),
            "-outform",
            "DER",
            "-out",
            str(tmp / "ca.der"),
        )
        passwd = tmp / "passwd"
        passwd.write_bytes(run("tigervncpasswd", "-f", input=b"testpass\n").stdout)
        passwd.chmod(0o600)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        number = next(
            n
            for n in range(91, 191)
            if not Path(f"/tmp/.X11-unix/X{n}").exists()
            and not Path(f"/tmp/.X{n}-lock").exists()
        )
        name = f":{number}"
        with (tmp / "server.log").open("w+") as server_log:
            server = subprocess.Popen(
                [
                    "Xtigervnc",
                    name,
                    "-geometry",
                    "320x240",
                    "-depth",
                    "24",
                    "-SecurityTypes",
                    "X509Vnc",
                    "-X509Cert",
                    str(cert),
                    "-X509Key",
                    str(key),
                    "-PasswordFile",
                    str(passwd),
                    "-localhost",
                    "-rfbport",
                    str(port),
                    "-AlwaysShared",
                    "-ac",
                    "-nolisten",
                    "tcp",
                    "-Log",
                    "*:stderr:30",
                ],
                stdout=server_log,
                stderr=subprocess.STDOUT,
                preexec_fn=partial(terminate_with_parent, os.getpid()),
            )
            connection = None
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        server_log.seek(0)
                        raise RuntimeError(server_log.read())
                    try:
                        connection = display.Display(name)
                        break
                    except Exception:
                        time.sleep(0.02)
                if connection is None:
                    raise RuntimeError("TigerVNC X11 readiness timed out")
                fixture(connection, name, port, tmp)
            finally:
                if connection is not None:
                    connection.close()
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


def fixture(connection, name, port, tmp):
    screen = connection.screen()
    root = screen.root
    window = root.create_window(
        0,
        0,
        320,
        240,
        0,
        screen.root_depth,
        X.InputOutput,
        X.CopyFromParent,
        background_pixel=0x112233,
        event_mask=X.ExposureMask
        | X.KeyPressMask
        | X.KeyReleaseMask
        | X.ButtonPressMask
        | X.ButtonReleaseMask
        | X.PointerMotionMask,
    )
    window.map()
    window.set_input_focus(X.RevertToParent, X.CurrentTime)
    gc = window.create_gc(foreground=0x112233)
    window.fill_rectangle(gc, 0, 0, 320, 240)
    connection.sync()
    events = []

    def send(value):
        print(json.dumps(value), flush=True)

    def drain():
        connection.sync()
        while connection.pending_events():
            event = connection.next_event()
            if event.type in (X.KeyPress, X.KeyRelease):
                values = connection.get_keyboard_mapping(event.detail, 1)[0]
                index = 1 if event.state & X.ShiftMask and len(values) > 1 else 0
                keysym = values[index] or values[0]
                events.append(
                    {"kind": "key", "down": event.type == X.KeyPress, "keysym": keysym}
                )
            elif event.type in (X.ButtonPress, X.ButtonRelease, X.MotionNotify):
                events.append(
                    {
                        "kind": "pointer",
                        "type": event.type,
                        "button": event.detail,
                        "x": event.event_x,
                        "y": event.event_y,
                        "state": event.state,
                    }
                )

    send(
        {
            "ready": True,
            "port": port,
            "display": name,
            "ca_der": str(tmp / "ca.der"),
            "version": PIN,
        }
    )
    while True:
        readable, _, _ = select.select([sys.stdin, connection.fileno()], [], [], 10)
        if connection.fileno() in readable:
            drain()
        if sys.stdin not in readable:
            continue
        line = sys.stdin.readline()
        if not line:
            return
        request = json.loads(line)
        command = request["command"]
        if command == "stop":
            send({"stopped": True})
            return
        if command == "paint":
            gc.change(foreground=request["rgb"])
            window.fill_rectangle(gc, *request.get("rect", [0, 0, 320, 240]))
            connection.sync()
            send({"painted": True})
        elif command == "copy":
            window.copy_area(gc, window, *request["rect"], *request["destination"])
            connection.sync()
            send({"copied": True})
        elif command in ("events", "wait_events"):
            drain()
            deadline = time.monotonic() + request.get("timeout", 5)

            def matching_count():
                return sum(
                    1
                    for event in events
                    if ("kind" not in request or event["kind"] == request["kind"])
                    and (
                        "types" not in request or event.get("type") in request["types"]
                    )
                )

            while matching_count() < request.get("count", 0):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError(
                        f"expected {request['count']} events, got {events}"
                    )
                readable, _, _ = select.select([connection.fileno()], [], [], remaining)
                if readable:
                    drain()
            send({"events": events})
            events.clear()
        elif command == "resize":
            env = dict(os.environ, DISPLAY=name)
            run("xrandr", "--fb", request["size"], env=env)
            width, height = map(int, request["size"].split("x"))
            window.configure(width=width, height=height)
            connection.sync()
            send({"resized": True})
        elif command == "cursor":
            source = window.create_pixmap(4, 4, 1)
            mask = window.create_pixmap(4, 4, 1)
            source_gc = source.create_gc(foreground=1)
            mask_gc = mask.create_gc(foreground=1)
            source.fill_rectangle(source_gc, 0, 0, 4, 4)
            mask.fill_rectangle(mask_gc, 0, 0, 4, 4)
            cursor = source.create_cursor(mask, (65535, 0, 0), (0, 0, 0), 1, 1)
            window.change_attributes(cursor=cursor)
            connection.sync()
            send({"cursor": True})
        elif command == "closed":
            deadline = time.monotonic() + 5
            while True:
                log = (tmp / "server.log").read_text()
                if "Connections: closed:" in log:
                    send({"log": log})
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("client did not disconnect")
                time.sleep(0.01)
        else:
            raise ValueError(f"unknown fixture command: {command}")


if __name__ == "__main__":

    def terminate(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    main()
