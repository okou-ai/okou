"""Exercise Ansible-generated Caddy routes and the real Unix permission boundary."""

import importlib.util
import json
import os
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from socketserver import ThreadingUnixStreamServer

# RFC 6455 section 1.3 challenge/response for the synthetic WebSocket peer.
WEBSOCKET_KEY = "dGhlIHNhbXBsZSBub25jZQ=="
WEBSOCKET_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="


class EchoHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        if self.path.endswith("/stream-response"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self.write_chunk(self.server.label + b":first")
            assert self.server.continue_response.wait(5), "first response chunk was buffered"
            self.write_chunk(b"second")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            return
        if self.headers.get("Upgrade", "").lower() != "websocket":
            self.reply_http(self.server.label + b":" + self.path.encode())
            return
        assert self.headers["Sec-WebSocket-Key"] == WEBSOCKET_KEY
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", WEBSOCKET_ACCEPT)
        self.end_headers()
        header = self.rfile.read(2)
        assert header[0] == 0x81 and header[1] & 0x80
        size = header[1] & 0x7F
        assert size < 126
        mask = self.rfile.read(4)
        payload = self.rfile.read(size)
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        response = self.server.label + b":" + payload
        self.wfile.write(b"\x81" + bytes([len(response)]) + response)
        self.wfile.flush()
        self.close_connection = True

    def reply_http(self, body):
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_POST(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = []
            while chunk := read_chunk(self.rfile):
                chunks.append(chunk)
                self.server.received_chunk.set()
            body = b"".join(chunks)
        else:
            body = self.rfile.read(int(self.headers["Content-Length"]))
        self.reply_http(self.server.label + b":" + self.path.encode() + b":" + body)

    def write_chunk(self, body):
        self.wfile.write(f"{len(body):x}\r\n".encode() + body + b"\r\n")
        self.wfile.flush()

    def log_message(self, *_args):
        pass


def response_headers(reader):
    status = int(reader.readline().split()[1])
    headers = {}
    while (line := reader.readline()) != b"\r\n":
        assert line, "unexpected EOF in response headers"
        name, value = line.decode().split(":", 1)
        headers[name.lower()] = value.strip()
    return status, headers


def read_chunk(reader):
    size = int(reader.readline().split(b";", 1)[0], 16)
    body = reader.read(size)
    assert len(body) == size and reader.read(2) == b"\r\n"
    return body


def streamed_http(context, port, path, server):
    with (
        socket.create_connection(("127.0.0.1", port), timeout=5) as raw,
        context.wrap_socket(raw, server_hostname="runner-wss.example.org") as peer,
    ):
        peer.sendall(
            f"GET {path}/stream-response HTTP/1.1\r\nHost: runner-wss.example.org\r\n"
            "Connection: close\r\n\r\n".encode()
        )
        reader = peer.makefile("rb")
        status, headers = response_headers(reader)
        assert status == 200 and headers["transfer-encoding"].lower() == "chunked"
        assert read_chunk(reader) == server.label + b":first"
        # The backend cannot finish until this caller has received its first chunk.
        server.continue_response.set()
        assert read_chunk(reader) == b"second"
        assert read_chunk(reader) == b""
    with (
        socket.create_connection(("127.0.0.1", port), timeout=5) as raw,
        context.wrap_socket(raw, server_hostname="runner-wss.example.org") as peer,
    ):
        peer.sendall(
            f"POST {path}/stream-request HTTP/1.1\r\nHost: runner-wss.example.org\r\n"
            "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\none\r\n".encode()
        )
        # Real upstream receipt must precede publishing the remaining request body.
        assert server.received_chunk.wait(5), "first request chunk was buffered"
        peer.sendall(b"3\r\ntwo\r\n0\r\n\r\n")
        reader = peer.makefile("rb")
        status, headers = response_headers(reader)
        assert status == 200
        assert reader.read(int(headers["content-length"])) == (
            server.label + b":" + path.encode() + b"/stream-request:onetwo"
        )


def response(context, port, path, websocket=False, method="GET", body=b""):
    with (
        socket.create_connection(("127.0.0.1", port), timeout=5) as raw,
        context.wrap_socket(raw, server_hostname="runner-wss.example.org") as peer,
    ):
        upgrade = (
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {WEBSOCKET_KEY}\r\n"
            if websocket
            else "Connection: close\r\n"
        )
        peer.sendall(
            (
                f"{method} {path} HTTP/1.1\r\nHost: runner-wss.example.org\r\n"
                f"Content-Length: {len(body)}\r\n{upgrade}\r\n"
            ).encode() + body
        )
        reader = peer.makefile("rb")
        status, headers = response_headers(reader)
        if status == 101:
            assert headers["sec-websocket-accept"] == WEBSOCKET_ACCEPT
            peer.sendall(
                b"\x81\x84mask"
                + bytes(v ^ b"mask"[i % 4] for i, v in enumerate(b"ping"))
            )
            header = reader.read(2)
            assert header[0] == 0x81 and not header[1] & 0x80
            return status, reader.read(header[1])
        return status, reader.read(int(headers.get("content-length", 0)))


def wait_ready(notify):
    deadline = time.monotonic() + 10
    while (remaining := deadline - time.monotonic()) > 0:
        notify.settimeout(remaining)
        if b"READY=1" in notify.recv(1024).splitlines():
            return
    raise TimeoutError("Caddy readiness notification timed out")


def main():
    repo, rendered, caddy = map(Path, sys.argv[1:])
    spec = importlib.util.spec_from_file_location(
        "namespace_validator", repo / "ansible/files/validate-runner-ingress-namespace.py"
    )
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    consumer = 65534
    with tempfile.TemporaryDirectory(prefix="okou-runner-caddy-", dir="/run") as name:
        root = Path(name)
        # Hardened, non-writable ancestors remain traversable to the consumer.
        root.chmod(0o751)
        shutil.copy2(caddy, root / "caddy")
        caddy = root / "caddy"
        namespace = root / "ingress"
        missing = root / "runner-not-started" / "ingress"
        validator.validate_namespace(missing, consumer)
        assert not missing.parent.exists()
        # An absent descendant must not hide an unsafe existing ancestor.
        root.chmod(0o771)
        try:
            validator.validate_namespace(missing, consumer)
        except ValueError:
            assert not missing.parent.exists()
        else:
            raise AssertionError("unsafe ancestor of missing namespace was accepted")
        root.chmod(0o751)
        namespace.symlink_to(root / "missing-target")
        try:
            validator.validate_namespace(namespace, consumer)
        except ValueError:
            assert namespace.is_symlink()
        else:
            raise AssertionError("dangling namespace symlink was accepted")
        namespace.unlink()
        validator.validate_namespace(namespace, consumer)
        assert not namespace.exists()
        namespace.mkdir()
        os.chown(namespace, 0, consumer)
        namespace.chmod(0o710)
        validator.validate_namespace(namespace, consumer)
        namespace.chmod(0o770)
        try:
            validator.validate_namespace(namespace, consumer)
        except ValueError:
            assert namespace.stat().st_mode & 0o7777 == 0o770
        else:
            raise AssertionError("unsafe namespace was accepted")
        namespace.chmod(0o710)
        acl = struct.pack("<I", 2) + b"".join(
            struct.pack("<HHI", tag, permissions, identity)
            for tag, permissions, identity in [
                (1, 7, 0xFFFFFFFF),
                (2, 1, 1000),
                (4, 1, 0xFFFFFFFF),
                (16, 1, 0xFFFFFFFF),
                (32, 0, 0xFFFFFFFF),
            ]
        )
        os.setxattr(namespace, "system.posix_acl_access", acl)
        try:
            validator.validate_namespace(namespace, consumer)
        except ValueError:
            assert os.getxattr(namespace, "system.posix_acl_access") == acl
        else:
            raise AssertionError("namespace ACL was accepted")
        os.removexattr(namespace, "system.posix_acl_access")
        validator.validate_namespace(namespace, consumer)
        private = namespace / "record.owner"
        private.write_bytes(b"private owner record")
        private.chmod(0o600)
        for option, path in [("-r", namespace), ("-w", namespace), ("-r", private)]:
            assert (
                subprocess.run(
                    ["test", option, str(path)],
                    check=False,
                    user=consumer,
                    group=consumer,
                    extra_groups=[],
                ).returncode
                == 1
            )
        private.unlink()
        namespace.rmdir()
        servers = []
        threads = []
        process = None
        try:
            ids = [str(uuid.uuid4()), str(uuid.uuid4())]
            cert, key = root / "cert.pem", root / "key.pem"
            subprocess.run(
                [
                    "openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-keyout",
                    str(key),
                    "-out",
                    str(cert),
                    "-days",
                    "1",
                    "-subj",
                    "/CN=runner-wss.example.org",
                    "-addext",
                    "subjectAltName=DNS:runner-wss.example.org",
                ],
                check=True,
                capture_output=True,
            )
            os.chown(key, 0, consumer)
            key.chmod(0o640)
            config = json.loads(
                subprocess.check_output(
                    [
                        str(caddy),
                        "adapt",
                        "--config",
                        str(rendered),
                        "--adapter",
                        "caddyfile",
                    ]
                )
            )
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                port = reservation.getsockname()[1]
            # Retain generated matchers/routes; isolate only network, sockets and PKI.
            server_config = config["apps"]["http"]["servers"]["srv0"]
            server_config["listen"] = [f"127.0.0.1:{port}"]
            server_config["automatic_https"] = {"disable": True}
            server_config["tls_connection_policies"] = [{}]
            config["apps"]["tls"] = {
                "certificates": {
                    "load_files": [{"certificate": str(cert), "key": str(key)}]
                }
            }
            config_path = root / "Caddy.json"
            config_path.write_text(
                json.dumps(config).replace("/var/lib/vm0-runner/ingress", str(namespace))
            )
            state = root / "state"
            state.mkdir(mode=0o700)
            os.chown(state, consumer, consumer)
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:
                notify_path = root / "notify.sock"
                notify.bind(str(notify_path))
                os.chown(notify_path, 0, consumer)
                notify_path.chmod(0o660)
                notify.settimeout(10)
                with (root / "caddy.log").open("wb") as log:
                    process = subprocess.Popen(
                        [str(caddy), "run", "--config", str(config_path)],
                        stdout=log,
                        stderr=log,
                        user=consumer,
                        group=consumer,
                        extra_groups=[],
                        env={
                            "XDG_DATA_HOME": str(state),
                            "XDG_CONFIG_HOME": str(state),
                            "NOTIFY_SOCKET": str(notify_path),
                        },
                    )
                    wait_ready(notify)
                    context = ssl.create_default_context(cafile=str(cert))
                    context.set_alpn_protocols(["http/1.1"])
                    # First provisioning starts Caddy before Runner-owned state.
                    assert not namespace.exists()
                    assert response(context, port, f"/runners/{ids[0]}", True)[0] == 502
                    namespace.mkdir()
                    os.chown(namespace, 0, consumer)
                    namespace.chmod(0o710)
                    validator.validate_namespace(namespace, consumer)
                    private.write_bytes(b"private owner record")
                    private.chmod(0o600)
                    for runner_id, label in zip(
                        ids, [b"first", b"second"], strict=True
                    ):
                        path = namespace / f"{runner_id}.sock"
                        server = ThreadingUnixStreamServer(str(path), EchoHandler)
                        server.label = label
                        server.continue_response = threading.Event()
                        server.received_chunk = threading.Event()
                        server.daemon_threads = True
                        os.chown(path, 0, consumer)
                        path.chmod(0o660)
                        servers.append(server)
                        thread = threading.Thread(
                            target=server.serve_forever, daemon=True
                        )
                        thread.start()
                        threads.append(thread)
                    before = {
                        p.name: (p.stat().st_ino, p.stat().st_mode)
                        for p in namespace.iterdir()
                    }
                    # Late socket creation becomes usable in the same process.
                    assert process.poll() is None
                    for runner_id, label, backend in zip(
                        ids, [b"first", b"second"], servers, strict=True
                    ):
                        assert response(context, port, f"/runners/{runner_id}", True) == (
                            101,
                            label + b":ping",
                        )
                        path = f"/runners/{runner_id}/control/health?probe=1"
                        assert response(context, port, path) == (200, label + b":" + path.encode())
                        path = f"/runners/{runner_id}/sandbox/runs/{uuid.uuid4()}/services/events"
                        assert response(context, port, path, True) == (101, label + b":ping")
                        payload = b"stream-" * 16384
                        assert response(context, port, path, method="POST", body=payload) == (
                            200, label + b":" + path.encode() + b":" + payload
                        )
                        streamed_http(context, port, path, backend)
                    for path in [
                        "/",
                        "/runners/not-a-uuid",
                        f"/runners/{ids[0]}not-a-boundary",
                        f"/runners/%2f{ids[0]}",
                        f"/runners/{ids[0].upper()}",
                        f"/runners/../{ids[0]}",
                    ]:
                        assert response(context, port, path, True)[0] == 404, path
                    assert (
                        response(context, port, f"/runners/{uuid.uuid4()}", True)[0] == 502
                    )
                    assert before == {
                        p.name: (p.stat().st_ino, p.stat().st_mode)
                        for p in namespace.iterdir()
                    }
        except BaseException:
            log_path = root / "caddy.log"
            if log_path.exists():
                sys.stderr.write(log_path.read_text())
            raise
        finally:
            if process is not None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            for server in servers:
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join(timeout=5)


if __name__ == "__main__":
    main()
