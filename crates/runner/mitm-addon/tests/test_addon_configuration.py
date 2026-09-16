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
import usage
import usage.buffer as usage_buffer
from tests.control_helpers import exchange, log_flush_request, status_request
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
        self.okou_proxy_registry_path = "/unused-registry.json"


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

    def test_load_registers_control_and_delivery_options(self):
        master = _RecordingMaster()
        mitm_addon.load(Loader(master))
        option_names = {option.name for option in master.options.added}
        assert {
            "okou_usage_state_id",
            "okou_control_socket_dir",
            "okou_client_session_id",
            "okou_client_version",
            "okou_usage_flush_interval_seconds",
        } <= option_names

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

    async def test_running_serves_status_and_log_flush(self, tmp_path, addon_control_cleanup):
        run_id = str(uuid.uuid4())
        log_path = tmp_path / f"network-{run_id}.jsonl"
        with (
            patch.object(mitm_addon, "__file__", _addon_file_path(tmp_path)),
            patch.object(
                mitm_addon.ctx,
                "options",
                _Options(control_socket_dir=str(tmp_path)),
                create=True,
            ),
        ):
            mitm_addon.configure({"okou_control_socket_dir", "okou_usage_state_id"})
            mitm_addon.running()
        logging_utils.log_proxy_entry(str(log_path), "info", "queued before flush")
        assert exchange(tmp_path, status_request("runner-usage-state-id"))["data"] == {
            "state": "running"
        }
        result = exchange(tmp_path, log_flush_request(log_path, run_id, "runner-usage-state-id"))
        assert isinstance(result["data"], dict)
        assert result["data"]["state"] == "processed"
        assert json.loads(log_path.read_text())["message"] == "queued before flush"

    async def test_running_can_retry_control_thread_start_failure(
        self, tmp_path, addon_control_cleanup
    ):
        with (
            patch.object(
                mitm_addon.ctx,
                "options",
                _Options(control_socket_dir=str(tmp_path)),
                create=True,
            ),
            patch.object(threading.Thread, "start", side_effect=RuntimeError("thread unavailable")),
            pytest.raises(RuntimeError, match="thread unavailable"),
        ):
            mitm_addon.running()
        with patch.object(
            mitm_addon.ctx,
            "options",
            _Options(control_socket_dir=str(tmp_path)),
            create=True,
        ):
            mitm_addon.running()
        assert exchange(tmp_path, status_request("runner-usage-state-id"))["data"] == {
            "state": "running"
        }

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
