#!/usr/bin/env python3
"""Nonproduction Caddy route test: real TLS/HTTP Upgrade to disposable Unix sockets.

Usage: CADDY_BIN=/path/to/caddy python3 ansible/tests/test_runner_wss_caddy.py
No production DNS, firewall, service, API ticket or Runner is used. A test double
confirms transport/routing only; Runner admission belongs to #37027/#37030.
"""

import base64
import hashlib
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
ROUTES = ROOT / "ansible/files/runner-wss-routes.caddy"
TEMPLATE = ROOT / "ansible/templates/runner-wss-Caddyfile.j2"
RUNNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
RUNNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2"
RUNNER_MISSING = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3"


def websocket_accept(key):
    # RFC 6455 section 4.2.2 mandates SHA-1 for this public handshake checksum.
    # It is not used as a signature or credential; SHA-256 would break browsers.
    raw = (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
    return base64.b64encode(hashlib.sha1(raw, usedforsecurity=False).digest())  # nosemgrep: python.lang.security.insecure-hash-algorithms.insecure-hash-algorithm-sha1


def recv_exact(sock, size):
    data = b""
    while len(data) < size:
        piece = sock.recv(size - len(data))
        if not piece:
            break
        data += piece
    return data


class SocketRunner:
    def __init__(self, path: Path, label: str):
        self.path = path
        self.label = label
        self.requests = []
        self.stop_event = threading.Event()
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(str(path))
        self.server.listen(8)
        self.server.settimeout(0.2)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while not self.stop_event.is_set():
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with conn:
                conn.settimeout(2)
                data = b""
                try:
                    while b"\r\n\r\n" not in data and len(data) < 8192:
                        part = conn.recv(8192)
                        if not part:
                            break
                        data += part
                    self.requests.append(data.split(b"\r\n", 1)[0])
                    headers = data.decode("iso-8859-1")
                    match = re.search(r"^Sec-WebSocket-Key: ([^\r\n]+)", headers, re.M | re.I)
                    if match is None or not re.search(r"^Upgrade: websocket\r?$", headers, re.M | re.I):
                        conn.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        continue
                    accept = websocket_accept(match.group(1).strip())
                    conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
                    # First application frame is deliberately synthetic; real ticket admission is not tested here.
                    head = recv_exact(conn, 2)
                    if len(head) != 2 or head[0] != 0x81 or head[1] != 0x82:
                        continue
                    mask = recv_exact(conn, 4)
                    masked = recv_exact(conn, 2)
                    if len(mask) != 4 or len(masked) != 2 or bytes(a ^ b for a, b in zip(masked, mask)) != b"hi":
                        continue
                    reply = self.label.encode()
                    conn.sendall(bytes((0x81, len(reply))) + reply)
                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, socket.timeout, UnicodeDecodeError):
                    # A test client may close a rejected handshake; the caller checks the HTTP outcome.
                    continue

    def close(self):
        self.stop_event.set()
        self.server.close()
        self.thread.join(timeout=2)
        self.path.unlink()


def receive_headers(sock):
    data = b""
    while b"\r\n\r\n" not in data and len(data) < 16384:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    return data


def request(ctx, port, path, upgrade=False, host="wss.localhost"):
    with socket.create_connection(("127.0.0.1", port), timeout=3) as raw:
        with ctx.wrap_socket(raw, server_hostname="wss.localhost") as stream:
            stream.settimeout(3)
            key = base64.b64encode(os.urandom(16)).decode()
            headers = (
                f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
                "Connection: Upgrade\r\nUpgrade: websocket\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
                if upgrade else f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
            )
            stream.sendall(headers.encode())
            response = receive_headers(stream)
            if upgrade and response.startswith(b"HTTP/1.1 101 "):
                assert b"Sec-WebSocket-Accept: " + websocket_accept(key) in response
                stream.sendall(b"\x81\x82\x01\x02\x03\x04" + bytes((ord("h") ^ 1, ord("i") ^ 2)))
                # The response might already contain a WebSocket frame after CRLFCRLF.
                payload = response.split(b"\r\n\r\n", 1)[1]
                while len(payload) < 2:
                    payload += stream.recv(128)
                expected_size = payload[1] & 0x7f
                while len(payload) < 2 + expected_size:
                    payload += stream.recv(128)
                return response.split(b"\r\n", 1)[0], payload[2:2 + expected_size]
            return response.split(b"\r\n", 1)[0], None


def start_caddy(binary, config, env):
    process = subprocess.Popen([str(binary), "run", "--config", str(config), "--adapter", "caddyfile"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
    return process


def main():
    binary = Path(os.environ.get("CADDY_BIN") or shutil.which("caddy") or "")
    if not binary.is_file():
        raise SystemExit("CADDY_BIN must point to Caddy v2.11.4")
    version = subprocess.check_output([str(binary), "version"], text=True).split()[0]
    assert version == "v2.11.4", version
    # RFC 6455 section 1.3 example; protects the test double against a bad checksum algorithm.
    assert websocket_accept("dGhlIHNhbXBsZSBub25jZQ==") == b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    with tempfile.TemporaryDirectory(prefix="okou-wss-caddy-") as base:
        root = Path(base)
        sockets = root / "sockets"
        sockets.mkdir(mode=0o700)
        cert, key = root / "cert.pem", root / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=wss.localhost", "-addext", "subjectAltName=DNS:wss.localhost", "-keyout", str(key), "-out", str(cert)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        route_source = ROUTES.read_text()
        assert route_source.count("/run/okou-ws/") == 1
        assert "{re.runner.1}" in route_source
        route = root / "routes.caddy"
        route.write_text(route_source.replace("/run/okou-ws/", f"{sockets}/"))
        # Validate the actual production routing fragment and hostname template without ACME traffic.
        production_route = root / "production-routes.caddy"
        production_route.write_text(route_source)
        production = root / "production.Caddyfile"
        production.write_text(TEMPLATE.read_text().replace("{{ wss_acme_email }}", "ops@example.net").replace("{{ inventory_hostname }}", "runner.example.net").replace("/etc/okou-wss/routes.caddy", str(production_route)))
        subprocess.run([str(binary), "adapt", "--validate", "--config", str(production), "--adapter", "caddyfile"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        local = root / "local.Caddyfile"
        local.write_text("{\n  admin off\n  auto_https disable_redirects\n}\n" + f"https://wss.localhost:{port} {{\n  bind 127.0.0.1\n  tls {cert} {key}\n  import {route}\n}}\n")
        subprocess.run([str(binary), "adapt", "--validate", "--config", str(local), "--adapter", "caddyfile"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        runners = [SocketRunner(sockets / (rid + ".sock"), label) for rid, label in [(RUNNER_A, "old"), (RUNNER_B, "new")]]
        env = dict(os.environ, XDG_DATA_HOME=str(root / "caddy-data"))
        ctx = ssl.create_default_context(cafile=str(cert))
        process = start_caddy(binary, local, env)
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise AssertionError(f"Caddy exited: {process.stderr.read().decode()[-2000:]}")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        break
                except OSError:
                    time.sleep(0.05)
            else:
                raise AssertionError("Caddy did not listen")
            for rid, label in [(RUNNER_A, b"old"), (RUNNER_B, b"new")]:
                status, result = request(ctx, port, "/ws/" + rid, True)
                assert b"101" in status and result == label, (status, result)
            assert runners[0].requests == [f"GET /ws/{RUNNER_A} HTTP/1.1".encode()]
            assert runners[1].requests == [f"GET /ws/{RUNNER_B} HTTP/1.1".encode()]
            for path in ["/ws/" + RUNNER_A + "/extra", "/ws/" + RUNNER_A.upper(), "/ws/../" + RUNNER_A, "/ws/%2e%2e/" + RUNNER_A, "/ws/" + RUNNER_A + "%2fsuffix", "/ws/%61" + RUNNER_A[1:], "/ws/" + RUNNER_A + "?ticket=forbidden", "//ws/" + RUNNER_A, "/ws/not-an-id", "/health"]:
                status, _ = request(ctx, port, path, True)
                assert b"404" in status, (path, status)
            status, _ = request(ctx, port, "/ws/" + RUNNER_A, True, host="other.example.net")
            assert b"101" not in status, status
            status, _ = request(ctx, port, "/ws/" + RUNNER_MISSING, True)
            assert b"502" in status, status
            status, _ = request(ctx, port, "/ws/" + RUNNER_A)
            assert b"400" in status, status  # Ordinary HTTP reaches the Runner test double, which rejects it.
            assert len(runners[1].requests) == 1, "Unmatched requests reached another Runner"
            runners[0].close()
            status, _ = request(ctx, port, "/ws/" + RUNNER_A, True)
            assert b"502" in status, status
            runners[0] = SocketRunner(sockets / (RUNNER_A + ".sock"), "restarted")
            status, result = request(ctx, port, "/ws/" + RUNNER_A, True)
            assert b"101" in status and result == b"restarted", (status, result)
            process.terminate()
            process.wait(timeout=5)
            process = start_caddy(binary, local, env)
            for _ in range(100):
                try:
                    status, result = request(ctx, port, "/ws/" + RUNNER_B, True)
                    if b"101" in status and result == b"new":
                        break
                except (ConnectionRefusedError, ConnectionResetError, ConnectionAbortedError):
                    # Only retry a transient connection failure while the restarted Caddy binds.
                    time.sleep(0.05)
                    continue
                time.sleep(0.05)
            else:
                raise AssertionError("Caddy restart did not restore old-release socket routing")
            print("PASS: Caddy v2.11.4 adapt + local TLS/WSS exact two-socket routing, rejection and reconnect")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
            for runner in runners:
                runner.close()


if __name__ == "__main__":
    main()
