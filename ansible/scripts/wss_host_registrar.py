#!/usr/bin/env python3
"""Opt-in host-owned local WSS probe and readiness registrar.

Not installed or started by this PR. Host provisioning must supply a distinct
root-only credential per host and one singleton invocation for each local Runner
socket. The API record asserts only *local* listener readiness, never public TLS.
"""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import stat
import sys
import time
from datetime import datetime, timezone
from urllib.request import HTTPRedirectHandler, Request, build_opener

RUNNER_ID = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$")
SOCKET_DIR = Path("/run/okou-ws")
PROBE_TIMEOUT_SECONDS = 2
RENEW_EVERY_SECONDS = 5


def probe_socket(runner_id: str, expected_uid: int, socket_dir: Path = SOCKET_DIR) -> str:
    """Return the nonce echoed by the actual local listener or fail closed."""
    if not RUNNER_ID.fullmatch(runner_id):
        raise ValueError("noncanonical runner ID")
    directory = socket_dir.lstat()
    if (
        socket_dir.resolve() != socket_dir
        or not stat.S_ISDIR(directory.st_mode)
        or directory.st_mode & stat.S_IWOTH
    ):
        raise ValueError("unsafe WSS socket directory")
    path = socket_dir / f"{runner_id}.sock"
    target = path.lstat()  # Never follow a symlink.
    if (
        not stat.S_ISSOCK(target.st_mode)
        or target.st_uid != expected_uid
        or target.st_mode & stat.S_IWOTH
    ):
        raise ValueError("unsafe WSS socket")
    nonce = secrets.token_hex(16)
    request = (
        f"GET /internal/wss-ready/{runner_id}?nonce={nonce} HTTP/1.1\r\n"
        "Host: localhost\r\nConnection: close\r\n\r\n"
    ).encode("ascii")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(PROBE_TIMEOUT_SECONDS)
        client.connect(str(path))
        if hasattr(socket, "SO_PEERCRED"):
            # Linux SO_PEERCRED: PID, UID, GID. Avoid trusting a foreign listener.
            import struct
            _, peer_uid, _ = struct.unpack(
                "3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            )
            if peer_uid != expected_uid:
                raise ValueError("wrong WSS listener owner")
        client.sendall(request)
        response = bytearray()
        while len(response) <= 4096:
            fragment = client.recv(4097 - len(response))
            if not fragment:
                break
            response.extend(fragment)
        if len(response) > 4096:
            raise ValueError("oversized WSS readiness response")
    headers, separator, body = bytes(response).partition(b"\r\n\r\n")
    status_line = headers.split(b"\r\n", 1)[0]
    if not separator or status_line not in (b"HTTP/1.1 200", b"HTTP/1.1 200 OK"):
        raise ValueError("WSS listener is not ready")
    parsed = json.loads(body)
    if parsed != {"runnerId": runner_id, "nonce": nonce}:
        raise ValueError("WSS listener identity mismatch")
    return nonce


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        # Never forward a host credential to a redirected origin.
        return None


def api_request(origin: str, token: str, runner_id: str, method: str, proof: dict | None = None) -> None:
    data = json.dumps({"proof": proof}).encode("utf-8") if proof else None
    request = Request(
        f"{origin}/api/runners/wss-readiness/{runner_id}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    with build_opener(NoRedirect()).open(request, timeout=PROBE_TIMEOUT_SECONDS + 1) as response:
        if response.status != 200:
            raise ValueError("WSS readiness API unavailable")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner-id", required=True)
    parser.add_argument("--runner-uid", type=int, required=True)
    parser.add_argument("--api-origin", required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    args = parser.parse_args()
    if not RUNNER_ID.fullmatch(args.runner_id):
        parser.error("runner-id must be a canonical lowercase UUID")
    if args.runner_uid < 0 or not args.api_origin.startswith("https://"):
        parser.error("runner UID and HTTPS API origin are required")
    with os.fdopen(
        os.open(args.token_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC),
        encoding="utf-8",
    ) as credential_file:
        credentials = os.fstat(credential_file.fileno())
        if (
            not stat.S_ISREG(credentials.st_mode)
            or credentials.st_uid != 0
            or credentials.st_mode & 0o077
        ):
            parser.error("token file must be a root-owned private regular file")
        token = credential_file.read(128).strip()
    if not re.fullmatch(r"okou_wss_host_[A-Za-z0-9_-]{43}", token):
        parser.error("invalid host credential")
    stop = False

    def shutdown(_signum: int, _frame: object) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    while not stop:
        try:
            nonce = probe_socket(args.runner_id, args.runner_uid)
            api_request(
                args.api_origin,
                token,
                args.runner_id,
                "PUT",
                {"nonce": nonce, "observedAt": datetime.now(timezone.utc).isoformat()},
            )
        except (OSError, ValueError, json.JSONDecodeError) as error:
            # Never print URL credentials, request body, token or listener payload.
            print(f"WSS local readiness unavailable: {type(error).__name__}", file=sys.stderr)
            try:
                api_request(args.api_origin, token, args.runner_id, "DELETE")
            except (OSError, ValueError):
                pass  # Short API lease expires without a successful renewal.
        time.sleep(RENEW_EVERY_SECONDS)
    try:
        api_request(args.api_origin, token, args.runner_id, "DELETE")
    except (OSError, ValueError):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
