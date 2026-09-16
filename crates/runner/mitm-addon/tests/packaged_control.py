"""Explicit standalone-artifact suite; invoked by check-packaged-addon-control.sh.

Not part of normal test discovery: running this suite requires the verified binary
and fails (rather than skips) when it is missing. No external service is contacted.
"""

import hashlib
import http.client
import json
import os
import shutil
import socket
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from tests.control_helpers import (
    control_connection,
    exchange,
    log_flush_request,
    registry_apply_request,
    registry_status_request,
    status_request,
)
from tests.registry_builtin_helpers import write_catalog_cache


@contextmanager
def launch(root: Path, generation: str):
    directory = root / generation
    directory.mkdir(mode=0o700)
    addon = directory / "addon"
    shutil.copytree(Path(__file__).parents[1] / "src", addon)
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    binary = Path(os.environ["MITMDUMP_CONTROL_TEST_BINARY"]).resolve(strict=True)
    with (directory / "process.log").open("w+") as output:
        # The wrapper verifies Runner's pinned archive and executable hashes;
        # arguments are fixture-owned and passed directly, never through a shell.
        process = subprocess.Popen(  # noqa: S603
            [
                str(binary),
                "--listen-host",
                "127.0.0.1",
                "--listen-port",
                str(port),
                "--scripts",
                str(addon / "mitm_addon.py"),
                "--set",
                f"confdir={directory / 'certificates'}",
                "--set",
                f"okou_control_socket_dir={directory}",
                "--set",
                f"okou_usage_state_id={generation}",
                "--set",
                "okou_api_url=http://127.0.0.1:1",
                "--set",
                f"okou_proxy_registry_path={directory / 'registry.json'}",
                "--set",
                f"okou_builtin_firewall_catalog_cache_path={directory / 'catalog.json'}",
                "--set",
                "connection_strategy=lazy",
            ],
            env={"PATH": os.defpath, "TMPDIR": str(directory)},
            stdout=output,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 10
            while True:
                if process.poll() is not None or time.monotonic() >= deadline:
                    output.seek(0)
                    raise AssertionError(f"standalone addon did not become ready: {output.read()}")
                try:
                    assert exchange(directory, status_request(generation))["type"] == "result"
                    break
                except (FileNotFoundError, ConnectionRefusedError):
                    time.sleep(0.02)
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                pass
            # Exercise the production HTTP hook alongside control without any
            # upstream connection: unavailable registry must fail closed locally.
            proxy = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            try:
                proxy.request("GET", "http://example.com/control-smoke")
                response = proxy.getresponse()
                assert response.status == 503
                assert json.loads(response.read())["error"] == "registry_unavailable"
            finally:
                proxy.close()
            yield directory, port
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                raise
        output.seek(0)
        assert process.returncode == 0, output.read()


def test_packaged_addon_status_shutdown_and_fresh_generation(tmp_path):
    with launch(tmp_path, "generation-1") as (directory, _):
        assert exchange(directory)["data"] == {"state": "running"}
        with control_connection(directory) as partial:
            partial.sendall(b"\x00")
            assert exchange(directory)["type"] == "result"
    # Addon closes the listener but never unlinks Runner's endpoint.
    assert (directory / "control.sock").is_socket()
    with launch(tmp_path, "generation-2") as (replacement, _):
        assert exchange(replacement)["code"] == "stale_generation"
        assert exchange(replacement, status_request("generation-2"))["type"] == "result"


def test_packaged_addon_flushes_production_network_log_after_unregister(tmp_path):
    run_id = str(uuid4())
    with launch(tmp_path, "generation-1") as (directory, port):
        log_path = directory / f"network-{run_id}.jsonl"
        registry_path = directory / "registry.json"
        registry_path.write_text(
            json.dumps(
                {
                    "sandboxes": {
                        "127.0.0.1": {
                            "runId": run_id,
                            "cliAgentType": "claude-code",
                            "billableFirewalls": [],
                            "networkLogPath": str(log_path),
                            "proxyLogPath": str(directory / f"proxy-{run_id}.jsonl"),
                            "firewalls": [
                                {
                                    "kind": "inline",
                                    "firewall": {
                                        "name": "example",
                                        "apis": [
                                            {
                                                "base": "http://example.com",
                                                "auth": {"headers": {}},
                                                "permissions": [
                                                    {"name": "read", "rules": ["GET /control-log"]}
                                                ],
                                            }
                                        ],
                                    },
                                }
                            ],
                            "networkPolicies": {
                                "example": {"allow": [], "deny": ["read"], "unknownPolicy": "deny"}
                            },
                        }
                    },
                    "updatedAt": 1,
                }
            )
        )
        # A local firewall denial runs the real HTTP and logging hooks without
        # connecting to an upstream service or requesting credentials.
        proxy = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        try:
            proxy.request("GET", "http://example.com/control-log")
            response = proxy.getresponse()
            assert response.status == 403
            assert json.loads(response.read())["reason"] == "permission_denied"
        finally:
            proxy.close()

        # Deferred upload happens after sandbox unregistration. Control must
        # retain the original log identity without a live registry entry.
        registry_path.write_text(json.dumps({"sandboxes": {}, "updatedAt": 2}))
        result = exchange(directory, log_flush_request(log_path, run_id))
        assert result["requestId"] == "request-1"
        assert result["generation"] == "generation-1"
        assert result["type"] == "result"
        data = result["data"]
        assert isinstance(data, dict)
        assert data["runId"] == run_id
        assert data["path"] == str(log_path)
        assert data["state"] == "processed"
        assert data["pending"] == 0
        records = [json.loads(line) for line in log_path.read_text().splitlines()]
        assert len(records) == 1
        assert records[0]["url"] == "http://example.com/control-log"
        assert records[0]["action"] == "DENY"
        assert records[0]["status"] == 403


def test_packaged_registry_receipt_matches_catalog_and_http_enforcement(tmp_path):
    with launch(tmp_path, "generation-1") as (directory, port):
        path = directory / "registry.json"
        catalog = directory / "catalog.json"
        write_catalog_cache(
            catalog,
            digest="sha256:" + "a" * 64,
            version="packaged-catalog",
            firewalls={
                "example": {
                    "name": "example",
                    "apis": [
                        {
                            "base": "http://example.com",
                            "auth": {"headers": {}},
                            "permissions": [{"name": "read", "rules": ["GET /control-apply"]}],
                        }
                    ],
                }
            },
        )
        path.write_text(
            json.dumps(
                {
                    "sandboxes": {
                        "127.0.0.1": {
                            "runId": str(uuid4()),
                            "cliAgentType": "claude-code",
                            "billableFirewalls": [],
                            "firewalls": [{"kind": "builtin", "name": "example"}],
                            "networkPolicies": {
                                "example": {"allow": [], "deny": ["read"], "unknownPolicy": "deny"}
                            },
                        }
                    },
                    "updatedAt": 1,
                }
            )
        )
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        response = exchange(directory, registry_apply_request(digest))
        data = response["data"]
        assert isinstance(data, dict)
        assert data["state"] == "applied"
        assert data["snapshot"]["digest"] == digest
        assert data["snapshot"]["catalog"]["digest"] == "a" * 64
        assert data["snapshot"]["catalog"]["file"]["inode"] == catalog.stat().st_ino
        assert exchange(directory, registry_status_request())["data"] == data["snapshot"]
        proxy = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        try:
            proxy.request("GET", "http://example.com/control-apply")
            denied = proxy.getresponse()
            assert denied.status == 403
            assert json.loads(denied.read())["reason"] == "permission_denied"
            path.write_text("{invalid")
            rejected = exchange(directory, registry_apply_request(digest))["data"]
            assert isinstance(rejected, dict)
            assert rejected["state"] == "rejected"
            assert rejected["snapshot"]["reason"] == "parse_failed"
            proxy.request("GET", "http://example.com/control-apply")
            unavailable = proxy.getresponse()
            assert unavailable.status == 503
            assert json.loads(unavailable.read())["error"] == "registry_unavailable"
        finally:
            proxy.close()
