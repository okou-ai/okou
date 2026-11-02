"""Native script loading must finish before managed listeners accept traffic."""

import asyncio
import errno
import os
import socket
import sys
from pathlib import Path

import pytest

from tests.control_helpers import exchange, registry_status_request, status_request
from tests.registry_builtin_helpers import github_cache_firewall, write_catalog_cache

ADDON = Path(__file__).resolve().parents[1] / "src" / "mitm_addon.py"

CHILD = r"""
import asyncio
import os
from pathlib import Path
import socket
import sys
from mitmproxy import options
from mitmproxy.tools.dump import DumpMaster
import builtin_firewall_cache

async def main():
    directory = Path(sys.argv[1])
    cache = directory / 'catalog.json'
    port = int(sys.argv[2])
    original_bind = socket.socket.bind
    def bind_listener(sock, address):
        if address == ('127.0.0.1', port):
            print('listener-binding', flush=True)
            assert sys.stdin.buffer.read(1) == b'b'
        return original_bind(sock, address)
    socket.socket.bind = bind_listener
    inode = cache.stat().st_ino
    original_read = os.read
    armed = True
    def read_catalog(fd, count):
        nonlocal armed
        if armed and os.fstat(fd).st_ino == inode:
            armed = False
            print('catalog-reading', flush=True)
            assert sys.stdin.buffer.read(1) == b'!'
        return original_read(fd, count)
    os.read = read_catalog
    validated = asyncio.Event()
    original_load = builtin_firewall_cache.load_configured_catalog_snapshot
    def load_catalog():
        snapshot = original_load()
        validated.set()
        return snapshot
    builtin_firewall_cache.load_configured_catalog_snapshot = load_catalog

    opts = options.Options(confdir=str(directory / 'ca'), server=False,
                           listen_host='127.0.0.1', listen_port=int(sys.argv[2]))
    master = DumpMaster(opts, with_termlog=False, with_dumper=False)
    managed = sys.argv[4] == 'managed'
    running = asyncio.Event()
    class Observe:
        def running(self):
            running.set()
    master.addons.add(Observe())
    enabled = asyncio.Event()
    def configured(updated):
        if 'server' in updated and opts.server:
            enabled.set()
    opts.changed.connect(configured)
    opts.set('okou_builtin_firewall_catalog_cache_path=' + str(cache),
             'okou_proxy_registry_path=' + str(directory / 'registry.json'),
             'okou_control_socket_dir=' + (str(directory / 'control') if managed else ''),
             'okou_usage_state_id=generation-1', defer=True)
    opts.update(scripts=[sys.argv[3]])
    task = asyncio.create_task(master.run())
    try:
        if managed:
            await enabled.wait()
            await master.addons.get('proxyserver').setup_servers()
            print('listener-ready', flush=True)
        else:
            await validated.wait()
            await running.wait()
            assert not opts.server
            print('listener-disabled', flush=True)
        assert await asyncio.to_thread(sys.stdin.buffer.read, 1) == b'x'
    finally:
        master.shutdown()
        await task

asyncio.run(main())
"""


@pytest.mark.parametrize("valid", [True, False])
@pytest.mark.parametrize("managed", [True, False])
async def test_listener_waits_for_catalog_and_preserves_standalone_options(
    tmp_path, valid, managed
):
    cache = tmp_path / "catalog.json"
    if valid:
        write_catalog_cache(
            cache,
            digest="sha256:" + "a" * 64,
            version="a",
            firewalls={"github": github_cache_firewall()},
        )
    else:
        cache.write_text("{invalid")
        cache.chmod(0o600)
    control = tmp_path / "control"
    control.mkdir(mode=0o700)
    for _ in range(2):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-u",
            "-c",
            CHILD,
            str(tmp_path),
            str(port),
            str(ADDON),
            "managed" if managed else "standalone",
            env={**os.environ, "PYTHONPATH": str(ADDON.parent)},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdout is not None
        assert process.stdin is not None
        assert process.stderr is not None
        try:
            assert await asyncio.wait_for(process.stdout.readline(), 5) == b"catalog-reading\n"
            with socket.socket() as client:
                client.settimeout(1)
                assert client.connect_ex(("127.0.0.1", port)) == errno.ECONNREFUSED
            process.stdin.write(b"!")
            await process.stdin.drain()
            if managed:
                assert await asyncio.wait_for(process.stdout.readline(), 5) == b"listener-binding\n"
                # A different process listening on the selected port must not
                # make this launch's control owner claim listener readiness.
                with socket.socket() as unrelated:
                    unrelated.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    unrelated.bind(("127.0.0.1", port))
                    unrelated.listen()
                    status = await asyncio.to_thread(exchange, control, status_request())
                    assert status["type"] == "error"
                    assert status["code"] == "not_ready"
                process.stdin.write(b"b")
                await process.stdin.drain()
            marker = b"listener-ready\n" if managed else b"listener-disabled\n"
            assert await asyncio.wait_for(process.stdout.readline(), 5) == marker
            if managed:
                _, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                await writer.wait_closed()
                request = registry_status_request() | {"method": "catalog.warm"}
                reply = await asyncio.to_thread(exchange, control, request)
                assert reply["type"] == "result", reply
                data = reply["data"]
                assert isinstance(data, dict)
                assert data["state"] == ("available" if valid else "unavailable")
                if not valid:
                    assert data["reason"] == "cache_invalid"
            else:
                with socket.socket() as client:
                    client.settimeout(1)
                    assert client.connect_ex(("127.0.0.1", port)) == errno.ECONNREFUSED
            process.stdin.write(b"x")
            await process.stdin.drain()
            remaining, errors = await asyncio.wait_for(
                asyncio.gather(process.stdout.read(), process.stderr.read()), 5
            )
            assert await asyncio.wait_for(process.wait(), 5) == 0, errors.decode()
            assert not remaining
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()
        if managed:
            (control / "control.sock").unlink()
