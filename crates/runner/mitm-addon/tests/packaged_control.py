"""Explicit standalone-artifact suite; invoked by check-packaged-addon-control.sh.

Not part of normal test discovery: running this suite requires the verified binary
and fails (rather than skips) when it is missing. No external service is contacted.
"""

import http.client
import json
import os
import shutil
import socket
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path

from tests.control_helpers import control_connection, exchange, status_request


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
                f"okou_proxy_registry_path={directory / 'missing-registry.json'}",
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
            yield directory
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
    with launch(tmp_path, "generation-1") as directory:
        assert exchange(directory)["data"] == {"state": "running"}
        with control_connection(directory) as partial:
            partial.sendall(b"\x00")
            assert exchange(directory)["type"] == "result"
    # Addon closes the listener but never unlinks Runner's endpoint.
    assert (directory / "control.sock").is_socket()
    with launch(tmp_path, "generation-2") as replacement:
        assert exchange(replacement)["code"] == "stale_generation"
        assert exchange(replacement, status_request("generation-2"))["type"] == "result"
