"""Bounded synthetic model gateway, isolated from agents and ordinary tools."""

import hashlib
import http.client
import json
import os
import socketserver
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MAX_BODY = 32 * 1024 * 1024
MAX_ACTIVE = 16
MAX_ADMITTED_BODY = 128 * 1024 * 1024
CHUNK = 16384
UPSTREAM = 18082


class Admission:
    def __init__(self):
        self.slots = threading.BoundedSemaphore(MAX_ACTIVE)
        self.lock = threading.Lock()
        self.body_bytes = 0

    def reserve(self, length):
        with self.lock:
            if self.body_bytes + length > MAX_ADMITTED_BODY:
                return False
            self.body_bytes += length
            return True

    def release(self, length):
        with self.lock:
            self.body_bytes -= length
            if self.body_bytes < 0:
                raise RuntimeError("gateway admission owner released twice")


class Gateway(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, credential, upstream=("127.0.0.1", UPSTREAM)):
        self.admission = Admission()
        self.credential = credential
        self.upstream = upstream
        self.audit = None
        self.tls_context = None
        super().__init__(address, handler)

    def process_request(self, request, address):
        # Bound threads and socket state before creating a request owner.
        if not self.admission.slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.0 503 Busy\r\nContent-Length: 0\r\n\r\n")
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.admission.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            request.settimeout(10)
            if self.tls_context is not None:
                request = self.tls_context.wrap_socket(request, server_side=True)
            self.finish_request(request, address)
        except (OSError, ValueError, http.client.HTTPException):
            self.handle_error(request, address)
        finally:
            # Release before shutdown so an observed socket EOF proves that
            # the next invocation can reuse both the byte and thread budgets.
            self.admission.slots.release()
            self.shutdown_request(request)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def setup(self):
        self.request.settimeout(10)
        super().setup()

    def handle_expect_100(self):
        # A 100 response acknowledges actual admission below, not just parsed
        # headers. This makes slow-body resource limits observable to clients.
        return True

    def forward(self):
        if self.server.audit is not None:
            self.server.audit(self.command, self.path)
        self.close_connection = True
        if self.command == "GET" and self.path.startswith("/v1/"):
            self.send_error(405)
            return
        lengths = self.headers.get_all("content-length", [])
        if self.headers.get("transfer-encoding") or len(lengths) > 1:
            self.send_error(400)
            return
        raw = lengths[0] if lengths else "0"
        if not raw.isascii() or not raw.isdecimal():
            self.send_error(400)
            return
        length = int(raw)
        if length > MAX_BODY:
            self.send_error(413)
            return
        if not self.path.startswith("/") or self.path.startswith("//"):
            self.send_error(400)
            return
        if not self.server.admission.reserve(length):
            self.send_response(503)
            self.send_header("content-length", "0")
            self.send_header("x-fixture-denial", "body-budget")
            self.end_headers()
            return
        try:
            if self.headers.get("expect", "").lower() == "100-continue":
                self.send_response_only(100)
                self.end_headers()
            self.transfer(length)
        finally:
            self.server.admission.release(length)

    def transfer(self, length):
        body = self.rfile.read(length)
        if len(body) != length:
            self.send_error(400)
            return
        # One fixed peer and one synthetic credential; caller auth and proxy
        # headers never choose an upstream, owner or key.
        upstream = http.client.HTTPConnection(*self.server.upstream, timeout=65)
        try:
            upstream.request(
                self.command,
                self.path,
                body=body,
                headers={
                    "content-type": self.headers.get(
                        "content-type", "application/json"
                    ),
                    "authorization": "Bearer " + self.server.credential,
                },
            )
            response = upstream.getresponse()
            self.send_response(response.status)
            self.send_header("connection", "close")
            for name in ("content-type", "content-length"):
                if response.getheader(name) is not None:
                    self.send_header(name, response.getheader(name))
            self.end_headers()
            while chunk := response.read1(CHUNK):
                self.wfile.write(chunk)
                self.wfile.flush()
        finally:
            upstream.close()

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()


def benchmark(handler):
    """Identical synthetic peer bytes for direct and proxied observations."""
    if handler.path == "/gateway-bench/body":
        length = int(handler.headers.get("content-length", "0"))
        if length > MAX_BODY:
            handler.send_error(413)
            return True
        body = handler.rfile.read(length)
        result = json.dumps(
            {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        ).encode()
    elif handler.path == "/gateway-bench/stream":
        result = (b"data: " + b"s" * 1016 + b"\n\n") * 4096
    else:
        return False
    handler.send_response(200)
    handler.send_header("content-type", "text/event-stream")
    handler.send_header("content-length", str(len(result)))
    handler.end_headers()
    for offset in range(0, len(result), CHUNK):
        handler.wfile.write(result[offset : offset + CHUNK])
        handler.wfile.flush()
    return True


class BenchmarkHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if not benchmark(self):
            self.send_error(404)

    def do_POST(self):
        if not benchmark(self):
            self.send_error(405)


def main():
    credential = Path("/fixture/gateway-key").read_text().strip()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain("/fixture/gateway-cert.pem", "/fixture/gateway-tls-key.pem")
    audit_lock = threading.Lock()

    def audit(method, path):
        with audit_lock, Path("/fixture/gateway-requests.jsonl").open("a") as log:
            log.write(json.dumps({"method": method, "path": path}) + "\n")

    with (
        Gateway(("127.0.0.1", 18080), Handler, credential) as server,
        Gateway(("127.0.0.1", 18086), Handler, credential) as tls,
    ):
        tls.admission = server.admission
        tls.tls_context = context
        server.audit = tls.audit = audit
        worker = threading.Thread(target=tls.serve_forever, daemon=True)
        worker.start()
        print(
            json.dumps(
                {
                    "ready": True,
                    "pid": os.getpid(),
                    "context": Path("/proc/self/attr/current").read_text().rstrip("\0"),
                    "cgroup": Path("/proc/self/cgroup").read_text().strip(),
                    "startupSeconds": time.monotonic() - float(sys.argv[1]),
                }
            ),
            flush=True,
        )
        try:
            server.serve_forever()
        finally:
            tls.shutdown()
            worker.join(timeout=2)
            if worker.is_alive():
                raise TimeoutError("owned TLS listener did not join")


if __name__ == "__main__":
    main()
