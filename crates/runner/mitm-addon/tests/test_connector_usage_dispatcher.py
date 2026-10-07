"""Tests for connector usage dispatcher fallback behavior."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import usage
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
    read_jsonl_text_after_flush,
)
from tests.x_flow_helpers import make_x_usage_flow


class TestConnectorUsageDispatcher:
    """Tests for report_connector_usage dispatcher gates and warnings."""

    @pytest.fixture(autouse=True)
    def _sync_executor(self, sync_usage_executor, usage_webhook_api):
        """All tests here route billing through ``_call_and_get_billing`` which
        inspects webhook delivery inline; the sync executor makes that work
        without each test needing its own ``fresh_usage_executor`` + shutdown.
        """
        self._usage_webhook_api = usage_webhook_api

    def _make_x_flow(self, real_flow, tmp_path, **kwargs):
        return make_x_usage_flow(real_flow, tmp_path, **kwargs)

    def _call_and_get_billing(self, flow, run_id="run-abc-123"):
        """Call report_connector_usage and return the webhook payload(s).

        Relies on the class-level ``_sync_executor`` autouse fixture to
        route submissions inline.
        """
        with self._usage_webhook_api() as webhook:
            start_count = webhook.request_count
            usage.report_connector_usage(flow, run_id)
            usage.flush_usage_events(trigger="test")
        return [
            event
            for request in webhook.requests[start_count:]
            for body in [request.json_body()]
            for event in body["events"]
        ]

    def test_x_usage_flow_buffer_state_matches_response_stream_contract(self, tmp_path, real_flow):
        body = b'{"data":[{"id":"1","text":"hi"}]}'
        flow = self._make_x_flow(real_flow, tmp_path, body=body)

        assert flow.metadata[metadata_keys.STREAM_BUFFER] == bytearray(body)
        assert flow.metadata[metadata_keys.STREAM_BUFFER_STATE] == {"truncated": False}

    def test_skips_for_model_provider(self, tmp_path, real_flow):
        """Model-provider flows go through report_model_provider_usage instead.
        The dispatcher has no ``model-provider:*`` entry in ``_REGISTRATIONS``, so
        it early-returns and never reaches the X parser even when
        firewall_billable=True."""
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openrouter-codex"
        assert self._call_and_get_billing(flow) == []
        proxy_log = tmp_path / "proxy.jsonl"
        if jsonl_exists_after_flush(proxy_log):
            assert "no registered handler" not in read_jsonl_text_after_flush(proxy_log)

    @pytest.mark.parametrize("firewall_name", [None, 42])
    def test_skips_malformed_firewall_name_without_warning(
        self, tmp_path, real_flow, firewall_name
    ):
        body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
        flow = self._make_x_flow(
            real_flow, tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}"
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = firewall_name

        assert self._call_and_get_billing(flow) == []

        proxy_log = tmp_path / "proxy.jsonl"
        if jsonl_exists_after_flush(proxy_log):
            assert "no registered handler" not in read_jsonl_text_after_flush(proxy_log)

    def test_skips_for_non_x_billable_firewall(self, tmp_path, real_flow):
        """Billable non-x connectors (hypothetical future additions to
        the TypeScript firewall billable metadata) must NOT reach the X parser.
        The dispatcher drops when the firewall_name has no registered handler,
        which prevents bogus billing records if someone marks a connector
        billable without also adding it to ``_REGISTRATIONS``."""
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.FIREWALL_NAME] = "github"
        assert self._call_and_get_billing(flow) == []

    def test_unregistered_handler_does_not_require_original_url(self, tmp_path, real_flow):
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.FIREWALL_NAME] = "github"
        flow.metadata.pop(metadata_keys.ORIGINAL_URL)

        assert self._call_and_get_billing(flow) == []

    def test_logs_underbilling_once_per_unregistered_firewall_name(self, tmp_path, real_flow):
        """First billable flow for an unregistered firewall_name emits an error;
        subsequent flows for the same name stay silent (one-shot guard)."""
        proxy_log = tmp_path / "proxy.jsonl"
        for _ in range(3):
            flow = self._make_x_flow(real_flow, tmp_path)
            flow.metadata[metadata_keys.FIREWALL_NAME] = "github"
            assert self._call_and_get_billing(flow) == []

        lines = [
            entry
            for entry in read_jsonl_entries_after_flush(proxy_log)
            if "no registered handler" in entry["message"]
        ]
        assert len(lines) == 1
        assert lines[0]["level"] == "error"
        assert lines[0]["firewall_name"] == "github"
        assert lines[0]["type"] == "usage_underbilling"
        assert lines[0]["reason"] == "unregistered_billable_handler"
        assert lines[0]["underbilling_class"] == "confirmed"
        assert lines[0]["component"] == "mitm_addon"

    def test_logs_underbilling_separately_per_firewall_name(self, tmp_path, real_flow):
        """One-shot guard is per-firewall-name, not global; a new desynced
        connector name still surfaces even after an earlier one logged."""
        proxy_log = tmp_path / "proxy.jsonl"
        for name in ("github", "slack", "github"):  # github repeats; slack new
            flow = self._make_x_flow(real_flow, tmp_path)
            flow.metadata[metadata_keys.FIREWALL_NAME] = name
            assert self._call_and_get_billing(flow) == []

        warned_names = [
            entry["firewall_name"]
            for entry in read_jsonl_entries_after_flush(proxy_log)
            if "no registered handler" in entry["message"]
        ]
        assert warned_names == ["github", "slack"]

    def test_does_not_warn_on_empty_firewall_name(self, tmp_path, real_flow):
        """Empty firewall_name is a different bug class (web-layer contract
        violation) already logged elsewhere; don't double-warn here."""
        proxy_log = tmp_path / "proxy.jsonl"
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.FIREWALL_NAME] = ""
        assert self._call_and_get_billing(flow) == []

        if jsonl_exists_after_flush(proxy_log):
            assert "no registered handler" not in read_jsonl_text_after_flush(proxy_log)

    def test_registered_x_usage_requires_original_url(self, tmp_path, real_flow, mitm_ctx):
        flow = self._make_x_flow(real_flow, tmp_path)
        flow.metadata.pop(metadata_keys.ORIGINAL_URL)

        with (
            mitm_ctx(api_url="https://api.okou.ai"),
            pytest.raises(ValueError, match="original_url"),
        ):
            usage.report_connector_usage(flow, "run-abc-123")
