"""Exercise generated Caddy routes and the real Unix permission boundary."""

import importlib.util
import hashlib
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
        if self.headers.get("Upgrade", "").lower() != "websocket":
            self.send_error(400)
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

    def log_message(self, *_args):
        pass


class DownloadHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "134217728")
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", 'attachment; filename="binary.bin"')
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Accept-Ranges", "none")
        self.end_headers()
        self.server.started.set()
        try:
            for _ in range(4096):
                self.wfile.write(bytes(32768))
                self.server.bytes_written += 32768
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # The cancellation probe closes TLS before the body completes;
            # receipt here proves Caddy retired that upstream write too.
            self.server.disconnected.set()
        finally:
            self.close_connection = True

    def log_message(self, *_args):
        pass


def rss_kib(pid):
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1])
    raise AssertionError("Caddy RSS observation unavailable")


def download(context, port, path, server, pid):
    before_rss = rss_kib(pid)
    with socket.create_connection(("127.0.0.1", port), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname="runner-wss.example.org") as peer:
            peer.sendall(f"GET {path} HTTP/1.1\r\nHost: runner-wss.example.org\r\nConnection: close\r\n\r\n".encode())
            reader = peer.makefile("rb")
            assert reader.readline().split()[1] == b"200"
            headers = {}
            while (line := reader.readline()) != b"\r\n":
                name, value = line.decode().split(":", 1)
                headers[name.lower()] = value.strip()
            assert headers["content-length"] == "134217728"
            assert headers["cache-control"] == "no-store, no-transform"
            assert headers["x-content-type-options"] == "nosniff"
            assert headers["accept-ranges"] == "none"
            assert server.started.wait(timeout=5)
            # The client deliberately stops reading. The pinned proxy must not
            # absorb a file-sized response before applying socket backpressure.
            time.sleep(0.3)
            assert server.bytes_written < 16 * 1024 * 1024, server.bytes_written
            blocked_bytes, blocked_rss = server.bytes_written, rss_kib(pid)
            digest, expected = hashlib.sha256(), hashlib.sha256()
            count = 0
            while chunk := reader.read(65536):
                digest.update(chunk)
                count += len(chunk)
            for _ in range(2048):
                expected.update(bytes(65536))
            assert count == 134217728 and digest.digest() == expected.digest()
            print(json.dumps({"caddyBlockedUpstreamBytes": blocked_bytes, "fileBytes": count,
                              "caddyBeforeRssKiB": before_rss, "caddyBlockedRssKiB": blocked_rss,
                              "caddyAfterRssKiB": rss_kib(pid)}), flush=True)


def response(context, port, path, websocket=False):
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
                f"GET {path} HTTP/1.1\r\nHost: runner-wss.example.org\r\n{upgrade}\r\n"
            ).encode()
        )
        reader = peer.makefile("rb")
        status = int(reader.readline().split()[1])
        headers = {}
        while (line := reader.readline()) != b"\r\n":
            assert line, "unexpected EOF in response headers"
            name, value = line.decode().split(":", 1)
            headers[name.lower()] = value.strip()
        if status == 101:
            assert headers["sec-websocket-accept"] == WEBSOCKET_ACCEPT
            peer.sendall(
                b"\x81\x84mask"
                + bytes(v ^ b"mask"[i % 4] for i, v in enumerate(b"ping"))
            )
            header = reader.read(2)
            assert header[0] == 0x81 and not header[1] & 0x80
            return status, reader.read(header[1])
        return status, None


def cancel_download(context, port, path, server):
    server.started.clear()
    server.disconnected.clear()
    server.bytes_written = 0
    with socket.create_connection(("127.0.0.1", port), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname="runner-wss.example.org") as peer:
            peer.sendall(f"GET {path} HTTP/1.1\r\nHost: runner-wss.example.org\r\nConnection: close\r\n\r\n".encode())
            with peer.makefile("rb") as reader:
                assert reader.readline().split()[1] == b"200"
                while (line := reader.readline()) != b"\r\n":
                    assert line, "unexpected EOF in response headers"
                assert reader.read(32768) == bytes(32768)
    assert server.disconnected.wait(timeout=5), "client cancellation retained the upstream"
    assert server.bytes_written < 134217728, server.bytes_written


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
        "namespace_validator", repo / "ansible/files/validate-runner-wss-namespace.py"
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
        namespace = root / "wss"
        downloads = root / "file-downloads"
        missing = root / "runner-not-started" / "wss"
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
                json.dumps(config).replace("/var/lib/vm0-runner/wss", str(namespace)).replace("/var/lib/vm0-runner/file-downloads", str(downloads))
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
                    assert response(context, port, f"/ws/{ids[0]}", True)[0] == 502
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
                    for runner_id, label in zip(
                        ids, [b"first", b"second"], strict=True
                    ):
                        assert response(context, port, f"/ws/{runner_id}", True) == (
                            101,
                            label + b":ping",
                        )
                        assert response(context, port, f"/ws/{runner_id}")[0] == 400
                    for path in [
                        "/",
                        "/ws/not-a-uuid",
                        f"/ws/{ids[0].upper()}",
                        f"/ws/../{ids[0]}",
                    ]:
                        assert response(context, port, path, True)[0] == 404
                    assert (
                        response(context, port, f"/ws/{uuid.uuid4()}", True)[0] == 502
                    )
                    secret = "REDACTION_PROBE_" + "A" * 27
                    assert len(secret) == 43
                    run_id = str(uuid.uuid4())
                    download_path = f"/downloads/{ids[0]}/{run_id}/{secret}"
                    assert response(context, port, download_path)[0] == 502
                    downloads.mkdir(mode=0o710)
                    os.chown(downloads, 0, consumer)
                    validator.validate_namespace(downloads, consumer)
                    path = downloads / f"{ids[0]}.sock"
                    server = ThreadingUnixStreamServer(str(path), DownloadHandler)
                    server.daemon_threads = True
                    server.started = threading.Event()
                    server.disconnected = threading.Event()
                    server.bytes_written = 0
                    os.chown(path, 0, consumer)
                    path.chmod(0o660)
                    servers.append(server)
                    thread = threading.Thread(target=server.serve_forever, daemon=True)
                    thread.start()
                    threads.append(thread)
                    download(context, port, download_path, server, process.pid)
                    cancel_download(context, port, download_path, server)
                    assert response(context, port, download_path + "/extra")[0] == 404
                    assert secret not in (root / "caddy.log").read_text()
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
