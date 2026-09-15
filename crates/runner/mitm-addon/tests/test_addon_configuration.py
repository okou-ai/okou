"""Tests for mitm addon configuration hooks."""

import importlib.util
import json
import sys
import threading
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import pytest
from mitmproxy.addonmanager import Loader

import logging_utils
import mitm_addon
import platform_api
import runner_flush_lifecycle
import usage
import usage.buffer as usage_buffer
from tests.control_helpers import exchange, status_request
from tests.pending_helpers import assert_pending
from tests.usage_helpers import install_recording_usage_timer


@dataclass(frozen=True)
class _RecordedOption:
    name: str
    typespec: type
    default: object
    help: str
    choices: Sequence[str] | None


class _RecordingOptions:
    def __init__(self) -> None:
        self.added: list[_RecordedOption] = []
        self._options: dict[str, _RecordedOption] = {}

    def __contains__(self, name: str) -> bool:
        return name in self._options

    def add_option(
        self,
        name: str,
        typespec: type,
        default: object,
        help_text: str,
        choices: Sequence[str] | None = None,
    ) -> None:
        option = _RecordedOption(name, typespec, default, help_text, choices)
        self.added.append(option)
        self._options[name] = option


class _RecordingMaster:
    def __init__(self) -> None:
        self.options = _RecordingOptions()


class _Options:
    def __init__(
        self,
        *,
        usage_state_id: str = "runner-usage-state-id",
        control_socket_dir: str = "",
        flush_interval_seconds: float = usage.DEFAULT_FLUSH_INTERVAL_SECONDS,
        client_session_id: str = "runner-session-test",
        client_version: str = "runner-version-test",
        api_url: str = "https://api.okou.ai",
    ) -> None:
        self.okou_usage_state_id = usage_state_id
        self.okou_control_socket_dir = control_socket_dir
        self.okou_usage_flush_interval_seconds = flush_interval_seconds
        self.okou_client_session_id = client_session_id
        self.okou_client_version = client_version
        self.okou_api_url = api_url


def _addon_file_path(tmp_path: Path) -> str:
    return str(tmp_path / "mitm_addon.py")


def _usage_event(source_key: str) -> usage_buffer.UsageEvent:
    return {
        "idempotencyKey": source_key,
        "kind": "model",
        "provider": "claude-sonnet-4-6",
        "category": "tokens.input",
        "quantity": 1,
    }


@pytest.fixture
def addon_control_cleanup():
    yield
    mitm_addon.done()


class TestAddonConfiguration:
    def test_addon_script_executes_without_sys_modules_preregistration(self):
        spec = importlib.util.spec_from_file_location(
            "mitm_addon_without_preregistration",
            Path(mitm_addon.__file__),
        )
        assert spec is not None
        assert spec.loader is not None
        module = importlib.util.module_from_spec(spec)

        assert module.__name__ not in sys.modules
        spec.loader.exec_module(module)

    def test_load_registers_usage_options_and_signal_handler_without_pending_write(self, tmp_path):
        master = _RecordingMaster()
        loader = Loader(master)
        pending_path = tmp_path / "usage-pending"

        # OS signal registration is process-global boundary state. Handler
        # behavior is covered by test_runner_usage_flush_signal.py.
        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(mitm_addon.signal, "signal") as signal_handler,
        ):
            mitm_addon.load(loader)

        option_names = [option.name for option in master.options.added]
        assert "okou_usage_state_id" in option_names
        assert "okou_control_socket_dir" in option_names
        assert "okou_client_session_id" in option_names
        assert "okou_client_version" in option_names
        assert "okou_usage_flush_interval_seconds" in option_names
        assert not pending_path.exists()
        signal_handler.assert_called_once_with(
            runner_flush_lifecycle.RUNNER_USAGE_FLUSH_SIGNAL,
            runner_flush_lifecycle.handle_runner_usage_flush_signal,
        )

    def test_load_rejects_unreviewed_mitmproxy_version(self):
        loader = Loader(_RecordingMaster())

        with (
            patch.object(mitm_addon.mitmproxy_compat.version, "VERSION", "12.2.4"),
            pytest.raises(
                RuntimeError,
                match=r"runtime compatibility layer requires mitmproxy 12\.2\.3; found 12\.2\.4",
            ),
        ):
            mitm_addon.load(loader)

    def test_load_rejects_unreviewed_wsproto_version(self):
        loader = Loader(_RecordingMaster())

        with (
            patch.object(mitm_addon.mitmproxy_compat.wsproto, "__version__", "1.3.3"),
            pytest.raises(
                RuntimeError,
                match=r"runtime compatibility layer requires wsproto 1\.3\.2; found 1\.3\.3",
            ),
        ):
            mitm_addon.load(loader)

    def test_configure_writes_pending_state_with_usage_state_id(self, tmp_path):
        pending_path = tmp_path / "usage-pending"

        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(mitm_addon.ctx, "options", _Options(), create=True),
        ):
            mitm_addon.configure({"okou_usage_state_id"})

        state = assert_pending(pending_path, flows=0, buffered=0, reports=0)
        assert state["usageStateId"] == "runner-usage-state-id"

    def test_running_starts_jsonl_watcher_before_addon_ready(self, tmp_path, addon_control_cleanup):
        ready_path = tmp_path / "control.sock"
        log_path = tmp_path / "network.jsonl"
        (tmp_path / "jsonl-flush-request").write_text(
            json.dumps(
                {
                    "usageStateId": "runner-usage-state-id",
                    "flushRequestId": "jsonl-request-1",
                    "requestedAtMs": 1_770_000_000_000,
                    "path": str(log_path),
                }
            )
        )

        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(runner_flush_lifecycle, "__file__", str(tmp_path / "runner_flush.py")),
            patch.object(
                mitm_addon.ctx,
                "options",
                _Options(control_socket_dir=str(tmp_path)),
                create=True,
            ),
            patch.object(logging_utils, "flush_log_path", return_value=True) as flush_log_path,
        ):
            mitm_addon.configure({"okou_control_socket_dir", "okou_usage_state_id"})
            assert not ready_path.exists()
            mitm_addon.running()
            runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()

        assert exchange(tmp_path, status_request("runner-usage-state-id"))["data"] == {
            "state": "running"
        }
        state = json.loads((tmp_path / "jsonl-flush-state").read_text())
        assert state["flushRequestId"] == "jsonl-request-1"
        assert state["path"] == str(log_path)
        assert state["pending"] == 0
        flush_log_path.assert_called_once_with(
            str(log_path),
            timeout=runner_flush_lifecycle.RUNNER_JSONL_FLUSH_TIMEOUT_SECONDS,
        )

    def test_running_does_not_serve_status_when_jsonl_watcher_fails_to_start(
        self, tmp_path, addon_control_cleanup
    ):
        ready_path = tmp_path / "control.sock"
        startup_error = RuntimeError("can't start new thread")
        real_thread_start = runner_flush_lifecycle.threading.Thread.start

        def fail_start(_worker: threading.Thread) -> None:
            raise startup_error

        worker_started = False

        def start_before_ready(worker: threading.Thread) -> None:
            nonlocal worker_started

            assert not ready_path.exists()
            real_thread_start(worker)
            worker_started = True

        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(runner_flush_lifecycle, "__file__", str(tmp_path / "runner_flush.py")),
            patch.object(
                mitm_addon.ctx,
                "options",
                _Options(control_socket_dir=str(tmp_path)),
                create=True,
            ),
        ):
            mitm_addon.configure({"okou_control_socket_dir", "okou_usage_state_id"})
            assert not ready_path.exists()
            with (
                patch.object(
                    runner_flush_lifecycle.threading.Thread,
                    "start",
                    new=fail_start,
                ),
                pytest.raises(RuntimeError) as raised,
            ):
                mitm_addon.running()

            assert raised.value is startup_error
            assert not ready_path.exists()

            try:
                with patch.object(
                    runner_flush_lifecycle.threading.Thread,
                    "start",
                    new=start_before_ready,
                ):
                    mitm_addon.running()

                assert worker_started
                assert exchange(tmp_path, status_request("runner-usage-state-id"))["data"] == {
                    "state": "running"
                }
            finally:
                runner_flush_lifecycle.stop_runner_jsonl_flush_worker_for_tests()

    def test_configure_writes_fallback_pending_state_id_when_usage_state_id_is_empty(
        self, tmp_path
    ):
        pending_path = tmp_path / "usage-pending"

        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(
                mitm_addon.ctx,
                "options",
                _Options(usage_state_id=""),
                create=True,
            ),
        ):
            mitm_addon.configure({"okou_usage_state_id"})

        state = assert_pending(pending_path, flows=0, buffered=0, reports=0)
        uuid.UUID(state["usageStateId"])

    def test_configure_ignores_unrelated_option_updates(self, tmp_path):
        pending_path = tmp_path / "usage-pending"

        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(mitm_addon.ctx, "options", _Options(), create=True),
        ):
            mitm_addon.configure({"okou_api_url"})

        assert not pending_path.exists()

    def test_configure_snapshots_client_headers(self):
        with patch.object(
            mitm_addon.ctx,
            "options",
            _Options(
                client_session_id="runner-session-configured",
                client_version="runner-version-configured",
            ),
            create=True,
        ):
            mitm_addon.configure({"okou_client_session_id", "okou_client_version"})

        req = platform_api.make_api_request("https://api.okou.ai/webhook", b"{}", "tok")
        normalized_headers = {name.lower(): value for name, value in req.header_items()}
        assert normalized_headers["x-client-session-id"] == "runner-session-configured"
        assert normalized_headers["x-client-version"] == "runner-version-configured"

    def test_configure_updates_usage_flush_interval(self, tmp_path):
        timers = install_recording_usage_timer()
        flush_interval_seconds = 15.0
        jitter_seconds = flush_interval_seconds * usage_buffer.DEFAULT_FLUSH_JITTER_RATIO

        with patch.object(
            mitm_addon.ctx,
            "options",
            _Options(flush_interval_seconds=flush_interval_seconds),
            create=True,
        ):
            mitm_addon.configure({"okou_usage_flush_interval_seconds"})

        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [_usage_event("source-1")],
            str(tmp_path / "proxy.jsonl"),
        )

        assert len(timers) == 1
        assert timers[0].started is True
        assert max(0.001, flush_interval_seconds - jitter_seconds) <= timers[0].delay
        assert timers[0].delay <= flush_interval_seconds + jitter_seconds
