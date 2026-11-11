"""Local harness for direct X connector usage reporting tests."""

from collections.abc import Callable
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any

from mitmproxy import http

import usage
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.usage_helpers import UsageWebhookServer
from tests.x_flow_helpers import RealFlowFactory, make_x_usage_flow

UsageWebhookApi = Callable[[], AbstractContextManager[UsageWebhookServer]]


class XUsageHarness:
    def __init__(self, usage_webhook_api: UsageWebhookApi) -> None:
        self._usage_webhook_api = usage_webhook_api

    def webhook(self) -> AbstractContextManager[UsageWebhookServer]:
        return self._usage_webhook_api()

    def make_flow(
        self,
        real_flow: RealFlowFactory,
        tmp_path: Path,
        *,
        path: str = "/2/tweets",
        query: str = "",
        body: bytes = b"",
        status: int = 200,
        permission: str = "tweet.read",
        rule: str = "GET /2/tweets",
        content_encoding: str = "",
        request_body: bytes | None = None,
        request_encoding: str | None = None,
    ) -> http.HTTPFlow:
        return make_x_usage_flow(
            real_flow,
            tmp_path,
            path=path,
            query=query,
            body=body,
            status=status,
            permission=permission,
            rule=rule,
            content_encoding=content_encoding,
            request_body=request_body,
            request_encoding=request_encoding,
        )

    def call_and_get_billing(
        self,
        flow: http.HTTPFlow,
        run_id: str = "run-abc-123",
    ) -> list[dict[str, Any]]:
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

    def call_and_get_single_billing(
        self,
        flow: http.HTTPFlow,
        run_id: str = "run-abc-123",
    ) -> dict[str, Any]:
        payloads = self.call_and_get_billing(flow, run_id)
        assert len(payloads) == 1, f"expected 1 billing record, got {len(payloads)}"
        return payloads[0]


def assert_lost_visibility_error(proxy_log: Path) -> dict[str, Any]:
    entries = read_jsonl_entries_after_flush(proxy_log)
    matching_entries = [
        entry
        for entry in entries
        if entry["level"] == "error" and "unparseable" in entry["message"].lower()
    ]
    assert len(matching_entries) == 1
    assert matching_entries[0]["type"] == "usage_underbilling"
    assert matching_entries[0]["reason"] == "unparseable_usage_response"
    assert matching_entries[0]["underbilling_class"] == "confirmed"
    assert matching_entries[0]["component"] == "mitm_addon"
    return matching_entries[0]
