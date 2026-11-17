"""Tests for TCP connection hooks."""

import json
import time
from pathlib import Path
from typing import cast

import pytest
from mitmproxy import tcp
from mitmproxy.flow import Error

import flow_metadata_keys as metadata_keys
import logging_utils
import mitm_addon
import registry
from tests.deferred_callback_helpers import (
    capture_deferred_callbacks,
    run_deferred_callbacks,
)
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


class TestTcpStart:
    def test_sets_metadata_for_registered_sandbox(self, registry_file, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="10.200.0.1")

        with (
            mitm_ctx(registry_path=str(registry_file)),
        ):
            mitm_addon.tcp_start(flow)

        assert flow.metadata[metadata_keys.SANDBOX_RUN_ID] == "run-abc-123"
        assert metadata_keys.SANDBOX_NETWORK_LOG_PATH in flow.metadata
        assert metadata_keys.TCP_START_MONOTONIC in flow.metadata

    @pytest.mark.parametrize(
        "client_peername",
        [
            pytest.param(None, id="missing"),
            pytest.param(
                cast(tuple[str, int], ("10.200.0.1", "12345")),
                id="string-port",
            ),
        ],
    )
    def test_skips_when_client_ip_is_unavailable(
        self,
        registry_file,
        mitm_ctx,
        real_tcp_flow,
        client_peername: tuple[str, int] | None,
    ):
        flow = real_tcp_flow()
        flow.client_conn.peername = client_peername

        with (
            mitm_ctx(registry_path=str(registry_file)),
        ):
            mitm_addon.tcp_start(flow)

        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata

    def test_skips_when_sandbox_not_registered(self, registry_file, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="192.168.99.99")

        with (
            mitm_ctx(registry_path=str(registry_file)),
        ):
            mitm_addon.tcp_start(flow)

        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata

    def test_registry_unavailable_kills_flow(self, registry_file, mitm_ctx, real_tcp_flow):
        registry.load_registry(str(registry_file))
        registry_file.unlink()
        flow = real_tcp_flow(client_ip="10.200.0.1")

        with mitm_ctx(registry_path=str(registry_file)):
            mitm_addon.tcp_start(flow)

        assert flow.error is not None
        assert flow.error.msg == Error.KILLED_MESSAGE
        assert not flow.live
        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata

    def test_invalid_registered_sandbox_kills_flow(self, tmp_path, mitm_ctx, real_tcp_flow):
        registry_file = tmp_path / "registry.json"
        registry_file.write_text(
            json.dumps({"sandboxes": {"10.200.0.9": {"runId": ""}}, "updatedAt": 0})
        )
        flow = real_tcp_flow(client_ip="10.200.0.9")

        with mitm_ctx(registry_path=str(registry_file)):
            mitm_addon.tcp_start(flow)

        assert flow.error is not None
        assert flow.error.msg == Error.KILLED_MESSAGE
        assert not flow.live
        assert metadata_keys.SANDBOX_RUN_ID not in flow.metadata


class TestTcpLog:
    def test_logs_tcp_connection(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="10.200.0.1")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        flow.metadata[metadata_keys.TCP_START_MONOTONIC] = time.monotonic() - 0.05

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        entries = read_jsonl_entries_after_flush(Path(log_path))
        assert len(entries) == 1
        entry = entries[0]
        assert entry["type"] == "tcp"
        assert entry["host"] == "140.82.116.3"
        assert entry["port"] == 22
        assert entry["latency_ms"] > 0
        assert entry["request_size"] == 5  # b"hello"
        assert entry["response_size"] == 14  # b"SSH-2.0-babeld"
        assert "error" not in entry
        assert_utc_millisecond_timestamp(entry["timestamp"])

    def test_logs_tcp_error(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow(client_ip="10.200.0.1")
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        flow.metadata[metadata_keys.TCP_START_MONOTONIC] = time.monotonic()
        flow.error = Error("connection reset by peer")

        with mitm_ctx():
            mitm_addon.tcp_error(flow)

        entry = read_jsonl_entries_after_flush(Path(log_path))[0]
        assert entry["type"] == "tcp"
        assert entry["error"] == "connection reset by peer"

    def test_skips_when_no_run_id(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        logging_utils.flush_log_path(log_path)
        assert not Path(log_path).exists()

    def test_handles_missing_server_addr(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        flow.metadata[metadata_keys.TCP_START_MONOTONIC] = time.monotonic()
        flow.server_conn = None

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["host"] == "unknown"
        assert entry["port"] == 0

    def test_handles_missing_start_time(self, tmp_path, mitm_ctx, real_tcp_flow):
        flow = real_tcp_flow()
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["latency_ms"] == 0

    def test_tcp_message_defers_registered_flow_drain(
        self, tmp_path, monkeypatch, mitm_ctx, real_tcp_flow
    ):
        messages = [
            tcp.TCPMessage(True, b"client-one"),
            tcp.TCPMessage(False, b"server-one"),
            tcp.TCPMessage(True, b"client-two"),
        ]
        flow = real_tcp_flow(messages=messages)
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        scheduled = capture_deferred_callbacks(monkeypatch)

        with mitm_ctx():
            mitm_addon.tcp_message(flow)
            mitm_addon.tcp_message(flow)

        assert flow.messages == messages
        assert len(scheduled) == 1

        run_deferred_callbacks(scheduled)

        assert flow.messages == []

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["request_size"] == len(b"client-one") + len(b"client-two")
        assert entry["response_size"] == len(b"server-one")

    def test_tcp_end_drains_pending_messages_before_deferred_callback(
        self, tmp_path, monkeypatch, mitm_ctx, real_tcp_flow
    ):
        messages = [
            tcp.TCPMessage(True, b"client"),
            tcp.TCPMessage(False, b"server-response"),
        ]
        flow = real_tcp_flow(messages=messages)
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        scheduled = capture_deferred_callbacks(monkeypatch)

        with mitm_ctx():
            mitm_addon.tcp_message(flow)
            mitm_addon.tcp_end(flow)

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["request_size"] == len(b"client")
        assert entry["response_size"] == len(b"server-response")
        assert flow.messages == []

        run_deferred_callbacks(scheduled)
        assert flow.messages == []

    def test_tcp_message_reschedules_after_previous_drain(
        self, tmp_path, monkeypatch, mitm_ctx, real_tcp_flow
    ):
        first_client = tcp.TCPMessage(True, b"first-client")
        first_server = tcp.TCPMessage(False, b"first-server")
        flow = real_tcp_flow(messages=[first_client, first_server])
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        scheduled = capture_deferred_callbacks(monkeypatch)

        with mitm_ctx():
            mitm_addon.tcp_message(flow)

        run_deferred_callbacks(scheduled)
        assert flow.messages == []

        second_client = tcp.TCPMessage(True, b"second-client")
        second_server = tcp.TCPMessage(False, b"second-server")
        flow.messages.extend([second_client, second_server])

        with mitm_ctx():
            mitm_addon.tcp_message(flow)

        assert len(scheduled) == 1

        run_deferred_callbacks(scheduled)

        with mitm_ctx():
            mitm_addon.tcp_end(flow)

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["request_size"] == len(first_client.content) + len(second_client.content)
        assert entry["response_size"] == len(first_server.content) + len(second_server.content)
        assert flow.messages == []

    def test_tcp_message_leaves_unregistered_flow_messages(
        self, monkeypatch, mitm_ctx, real_tcp_flow
    ):
        messages = [tcp.TCPMessage(True, b"client")]
        flow = real_tcp_flow(messages=messages)
        scheduled = capture_deferred_callbacks(monkeypatch)

        with mitm_ctx():
            mitm_addon.tcp_message(flow)

        assert scheduled == []
        assert flow.messages == messages

    @pytest.mark.parametrize(
        "drain_before_end",
        [
            pytest.param(False, id="one-shot"),
            pytest.param(True, id="deferred"),
        ],
    )
    def test_tcp_size_accumulation_matches_across_drain_paths(
        self,
        tmp_path,
        monkeypatch,
        mitm_ctx,
        real_tcp_flow,
        drain_before_end: bool,
    ):
        max_log_size = 8
        first_messages = [
            tcp.TCPMessage(True, b"first"),
            tcp.TCPMessage(False, b"reply"),
        ]
        second_messages = [
            tcp.TCPMessage(True, b"later"),
            tcp.TCPMessage(False, b"again"),
        ]
        flow = real_tcp_flow(messages=first_messages)
        log_path = str(tmp_path / "network.jsonl")
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-abc-123"
        flow.metadata[metadata_keys.SANDBOX_NETWORK_LOG_PATH] = log_path
        monkeypatch.setattr(logging_utils, "NETWORK_LOG_MAX_SAFE_SIZE", max_log_size)
        scheduled = capture_deferred_callbacks(monkeypatch)

        if drain_before_end:
            with mitm_ctx():
                mitm_addon.tcp_message(flow)

            assert len(scheduled) == 1

            run_deferred_callbacks(scheduled)
            assert flow.messages == []

        flow.messages.extend(second_messages)

        with mitm_ctx():
            if drain_before_end:
                mitm_addon.tcp_message(flow)
                assert len(scheduled) == 1
                assert flow.messages == second_messages
            mitm_addon.tcp_end(flow)

        [entry] = read_jsonl_entries_after_flush(Path(log_path))
        assert entry["request_size"] == max_log_size
        assert entry["response_size"] == max_log_size
        assert flow.messages == []

        run_deferred_callbacks(scheduled)
        assert flow.messages == []
