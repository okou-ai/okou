"""Process-exit coverage for best-effort model-provider reporting."""

import multiprocessing
import socket
import threading
from multiprocessing.connection import Connection
from unittest.mock import patch

from mitmproxy import http
from mitmproxy.test import tflow

import flow_metadata_keys as metadata_keys
import mitm_addon
import model_provider_failure


def _shutdown_with_stalled_dns(status: Connection) -> None:
    dns_started = threading.Event()
    release_dns = threading.Event()

    def stalled_dns(*args, **kwargs):
        dns_started.set()
        release_dns.wait()
        raise socket.gaierror("synthetic resolver failure")

    with patch.object(socket, "getaddrinfo", stalled_dns):
        model_provider_failure.configure_reporting(
            api_url="https://report.invalid",
            bearer_credential="synthetic-nonsecret",
        )
        flow = tflow.tflow(resp=True)
        flow.request = http.Request.make("POST", "https://openrouter.ai/api/v1/chat/completions")
        flow.response = http.Response.make(503, b"")
        flow.metadata.update(
            {
                metadata_keys.SANDBOX_RUN_ID: "run-shutdown-regression",
                metadata_keys.SANDBOX_PROXY_LOG_PATH: "",
                metadata_keys.ORIGINAL_URL: flow.request.url,
                metadata_keys.FIREWALL_NAME: "model-provider:openrouter-codex",
                metadata_keys.FIREWALL_BILLABLE: True,
                metadata_keys.FIREWALL_ACTION: "ALLOW",
            }
        )
        model_provider_failure.admit_flow(flow)
        mitm_addon.responseheaders(flow)
        assert dns_started.wait(timeout=5), "report did not reach DNS"
        status.send("dns-blocked")
        # Exercise the production done hook and unchanged ten-second drain.
        mitm_addon.done()
        assert not release_dns.is_set()
        status.send("shutdown-complete")
        status.close()
    # Never release DNS: normal interpreter exit is the behavior under test.


def test_process_exits_after_shutdown_with_dns_still_blocked():
    context = multiprocessing.get_context("spawn")
    status, child_status = context.Pipe(duplex=False)
    process = context.Process(target=_shutdown_with_stalled_dns, args=(child_status,))
    process.start()
    child_status.close()
    try:
        assert status.poll(10), "child did not start reporting"
        assert status.recv() == "dns-blocked"
        assert status.poll(15), "addon shutdown did not finish its drain window"
        assert status.recv() == "shutdown-complete"
        process.join(timeout=5)
        assert process.exitcode == 0, "reporter kept the child alive after addon shutdown"
    finally:
        # A forced kill only cleans up a failed regression; it cannot satisfy the assertion.
        if process.is_alive():
            process.kill()
        process.join(timeout=5)
        process.close()
        status.close()
