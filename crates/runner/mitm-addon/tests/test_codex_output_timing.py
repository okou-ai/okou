"""Tests for default Codex provider request/output timing observations."""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType
from unittest.mock import patch

import pytest
from mitmproxy import http
from mitmproxy.flow import Error

import codex_output_timing
import flow_metadata_keys as metadata_keys
import mitm_addon
import model_provider_failure
import openai_responses_events
import usage
from tests.jsonl_log_helpers import read_jsonl_text_after_flush
from tests.model_provider_flow_helpers import make_openai_responses_websocket_flow
from tests.model_provider_websocket_helpers import (
    ScheduledWebSocketTrim,
    capture_deferred_websocket_trims,
    capture_openai_responses_extractor_feeds,
    feed_websocket_server_message,
    set_websocket_message,
)
from tests.pending_helpers import assert_pending
from tests.usage_helpers import CapturedWebhookRequest, UsageWebhookServer
from tests.webhook_test_helpers import (
    QueuedUsageExecutor,
    request_runner_usage_flush,
)
from usage import json_probe

_TELEMETRY_PATH = "/api/webhooks/agent/telemetry"
_FIRST_GENERATED_RESPONSE_CREATE_SENT = "codex_proxy_first_generated_response_create_sent"
_FIRST_GENERATED_RESPONSE_CREATED = "codex_proxy_first_generated_response_created"
_FIRST_OUTPUT_ITEM_ADDED = "codex_proxy_first_output_item_added"
_FIRST_OUTPUT_TEXT_DELTA = "codex_proxy_first_output_text_delta"
_FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE = "codex_proxy_first_text_in_first_generated_response"
_FIRST_TEXT_IN_LATER_GENERATED_RESPONSE = "codex_proxy_first_text_in_later_generated_response"


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_websocket_trims(monkeypatch)


def _event(event_type: str, *, secret: str | None = None) -> bytes:
    event: dict[str, object] = {"type": event_type}
    if secret is not None:
        event["content"] = {
            "text": secret,
            "response_id": "sensitive-response-id",
        }
    return json.dumps(event).encode()


def _timing_requests(webhook: UsageWebhookServer) -> list[CapturedWebhookRequest]:
    return [request for request in webhook.requests if request.path == _TELEMETRY_PATH]


def _operations(requests: list[CapturedWebhookRequest]) -> list[dict[str, object]]:
    operations: list[dict[str, object]] = []
    for request in requests:
        body = request.json_body()
        request_operations = body.get("sandboxOperations")
        assert isinstance(request_operations, list)
        for operation in request_operations:
            assert isinstance(operation, dict)
            operations.append(operation)
    return operations


def _feed_client_event(
    flow: http.HTTPFlow,
    event: bytes,
    *,
    received_at: float | None = None,
) -> None:
    set_websocket_message(flow, from_client=True, content=event)
    assert flow.websocket is not None
    if received_at is not None:
        flow.websocket.messages[-1].timestamp = received_at
    mitm_addon.websocket_message(flow)


def _feed_generated_response(
    flow: http.HTTPFlow,
    *,
    include_text: bool = True,
    secret: str | None = None,
    request_received_at: float | None = None,
) -> None:
    _feed_client_event(
        flow,
        _event("response.create", secret=secret),
        received_at=request_received_at,
    )
    feed_websocket_server_message(flow, _event("response.created", secret=secret))
    feed_websocket_server_message(flow, _event("response.output_item.added", secret=secret))
    if include_text:
        feed_websocket_server_message(flow, _event("response.output_text.delta", secret=secret))


def test_default_codex_excludes_prewarm_and_reports_content_free_milestones(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    secret = "provider-secret-that-must-not-be-reported"
    generated_request_received_at = 1_700_000_000.125

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed_client_event(flow, _event("response.create", secret=secret))
        feed_websocket_server_message(flow, _event("response.created", secret=secret))
        feed_websocket_server_message(flow, _event("response.completed", secret=secret))
        assert _timing_requests(usage_webhook_server) == []

        _feed_generated_response(
            flow,
            secret=secret,
            request_received_at=generated_request_received_at,
        )

    requests = _timing_requests(usage_webhook_server)
    assert len(requests) == 2
    assert [len(request.json_body()["sandboxOperations"]) for request in requests] == [3, 2]
    assert all(request.header("authorization") == "Bearer tok-xyz" for request in requests)

    operations = _operations(requests)
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_GENERATED_RESPONSE_CREATE_SENT,
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
        _FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE,
    ]
    assert all(operation["duration_ms"] == 0 for operation in operations)
    assert all(operation["success"] is True for operation in operations)
    timestamps = [datetime.fromisoformat(str(operation["ts"])) for operation in operations]
    assert timestamps == sorted(timestamps)
    assert timestamps[0] == datetime.fromtimestamp(generated_request_received_at, UTC)
    assert all(request.json_body()["runId"] == "run-abc-123" for request in requests)

    serialized_requests = b"".join(request.body for request in requests)
    assert secret.encode() not in serialized_requests
    assert secret not in read_jsonl_text_after_flush(proxy_log)


@pytest.mark.parametrize(
    "interleaving",
    ["single-flow", "before-output", "terminal-before-output", "before-text"],
)
def test_concurrent_prewarm_preserves_generated_response_timing(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
    interleaving: str,
) -> None:
    first = make_openai_responses_websocket_flow(real_flow, tmp_path)
    prewarm = make_openai_responses_websocket_flow(real_flow, tmp_path)
    first_sent_at = 1_700_000_000.125

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(first)
        mitm_addon.responseheaders(prewarm)
        _feed_client_event(first, _event("response.create"), received_at=first_sent_at)
        before_created = datetime.now(UTC)
        feed_websocket_server_message(
            first, b'{"type":"response.created","response":{"id":"first-response"}}'
        )
        after_created = datetime.now(UTC)
        if interleaving == "before-text":
            feed_websocket_server_message(first, _event("response.output_item.added"))

        if interleaving != "single-flow":
            _feed_client_event(
                prewarm,
                b'{"type":"response.create","generate":false}',
                received_at=first_sent_at + 10,
            )
            feed_websocket_server_message(
                prewarm, b'{"type":"response.created","response":{"id":"prewarm-response"}}'
            )
            if interleaving != "before-output":
                feed_websocket_server_message(
                    prewarm,
                    b'{"type":"response.completed","response":{"id":"prewarm-response"}}',
                )

        if interleaving != "before-text":
            feed_websocket_server_message(first, _event("response.output_item.added"))
        feed_websocket_server_message(first, _event("response.output_text.delta"))

    operations = _operations(_timing_requests(usage_webhook_server))
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_GENERATED_RESPONSE_CREATE_SENT,
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
        _FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE,
    ]
    assert operations[0]["ts"] == datetime.fromtimestamp(first_sent_at, UTC).isoformat()
    assert before_created <= datetime.fromisoformat(str(operations[1]["ts"])) <= after_created


@pytest.mark.parametrize("first_output_index", [0, 1])
@pytest.mark.parametrize("first_text_index", [0, 1])
def test_concurrent_generated_responses_select_their_own_timestamps_and_text_path(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
    first_output_index: int,
    first_text_index: int,
) -> None:
    flows = [make_openai_responses_websocket_flow(real_flow, tmp_path) for _ in range(2)]
    sent_at = [1_700_000_000.125, 1_700_000_010.125]

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        for index, flow in enumerate(flows):
            mitm_addon.responseheaders(flow)
            _feed_client_event(flow, _event("response.create"), received_at=sent_at[index])
            feed_websocket_server_message(flow, _event("response.created"))

        feed_websocket_server_message(
            flows[first_output_index], _event("response.output_item.added")
        )
        feed_websocket_server_message(
            flows[1 - first_output_index], _event("response.output_item.added")
        )
        feed_websocket_server_message(flows[first_text_index], _event("response.output_text.delta"))
        feed_websocket_server_message(
            flows[1 - first_text_index], _event("response.output_text.delta")
        )

    operations = _operations(_timing_requests(usage_webhook_server))
    text_path = (
        _FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE
        if first_text_index == first_output_index
        else _FIRST_TEXT_IN_LATER_GENERATED_RESPONSE
    )
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_GENERATED_RESPONSE_CREATE_SENT,
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
        text_path,
    ]
    assert (
        operations[0]["ts"] == datetime.fromtimestamp(sent_at[first_output_index], UTC).isoformat()
    )


@pytest.mark.parametrize("text_response", ["first", "next"])
def test_queued_request_does_not_replace_active_response_timing(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
    text_response: str,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    first_sent_at = 1_700_000_000.125

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed_client_event(flow, _event("response.create"), received_at=first_sent_at)
        feed_websocket_server_message(flow, _event("response.created"))
        _feed_client_event(flow, _event("response.create"), received_at=first_sent_at + 10)
        feed_websocket_server_message(flow, _event("response.output_item.added"))
        if text_response == "next":
            feed_websocket_server_message(flow, _event("response.completed"))
            feed_websocket_server_message(flow, _event("response.created"))
            feed_websocket_server_message(flow, _event("response.output_item.added"))
        feed_websocket_server_message(flow, _event("response.output_text.delta"))

    operations = _operations(_timing_requests(usage_webhook_server))
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_GENERATED_RESPONSE_CREATE_SENT,
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
        (
            _FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE
            if text_response == "first"
            else _FIRST_TEXT_IN_LATER_GENERATED_RESPONSE
        ),
    ]
    assert operations[0]["ts"] == datetime.fromtimestamp(first_sent_at, UTC).isoformat()


@pytest.mark.parametrize("terminal_hook", ["websocket_end", "error"])
def test_terminated_flow_does_not_supply_unconfirmed_timing_to_reconnect(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
    terminal_hook: str,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    reconnect = make_openai_responses_websocket_flow(real_flow, tmp_path)

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed_client_event(flow, _event("response.create"))
        feed_websocket_server_message(flow, _event("response.created"))
        if terminal_hook == "websocket_end":
            mitm_addon.websocket_end(flow)
        else:
            flow.error = Error("connection closed")
            mitm_addon.error(flow)
        mitm_addon.responseheaders(reconnect)
        feed_websocket_server_message(reconnect, _event("response.output_item.added"))
        feed_websocket_server_message(reconnect, _event("response.output_text.delta"))

    assert [
        operation["action_type"]
        for operation in _operations(_timing_requests(usage_webhook_server))
    ] == [
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
        _FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE,
    ]


@pytest.mark.parametrize("terminal_event", sorted(openai_responses_events.TERMINAL_EVENTS))
def test_responses_terminals_discard_unconfirmed_timing_candidate(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
    terminal_event: str,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed_client_event(flow, _event("response.create"))
        feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": "response.created",
                    "response": {"id": "unconfirmed-response"},
                }
            ).encode(),
        )
        feed_websocket_server_message(
            flow,
            json.dumps(
                {
                    "type": terminal_event,
                    "response": {"id": "unconfirmed-response"},
                }
            ).encode(),
        )
        feed_websocket_server_message(flow, _event("response.output_item.added"))

    assert [
        operation["action_type"]
        for operation in _operations(_timing_requests(usage_webhook_server))
    ] == [_FIRST_OUTPUT_ITEM_ADDED]


def test_output_first_codex_reports_only_observed_content_free_milestones(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    secret = "output-first-provider-secret"

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        feed_websocket_server_message(
            flow,
            _event("response.output_item.added", secret=secret),
        )

        [output_request] = _timing_requests(usage_webhook_server)
        assert [operation["action_type"] for operation in _operations([output_request])] == [
            _FIRST_OUTPUT_ITEM_ADDED
        ]

        feed_websocket_server_message(
            flow,
            _event("response.output_text.delta", secret=secret),
        )

    requests = _timing_requests(usage_webhook_server)
    operations = _operations(requests)
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
        _FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE,
    ]
    assert all(request.json_body()["runId"] == "run-abc-123" for request in requests)
    assert secret.encode() not in b"".join(request.body for request in requests)


def test_tool_turns_reconnects_and_reused_sandboxes_preserve_run_boundaries(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed_generated_response(flow, include_text=False)
        feed_websocket_server_message(flow, _event("response.completed"))

        _feed_generated_response(flow)
        feed_websocket_server_message(flow, _event("response.output_text.delta"))

        reconnect = make_openai_responses_websocket_flow(real_flow, tmp_path)
        mitm_addon.responseheaders(reconnect)
        _feed_generated_response(reconnect)

        reused_sandbox_run = make_openai_responses_websocket_flow(real_flow, tmp_path)
        reused_sandbox_run.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-reused-sandbox"
        mitm_addon.responseheaders(reused_sandbox_run)
        _feed_generated_response(reused_sandbox_run)

    requests = _timing_requests(usage_webhook_server)
    operations_by_run: dict[str, list[dict[str, object]]] = {}
    for request in requests:
        body = request.json_body()
        run_id = body["runId"]
        assert isinstance(run_id, str)
        operations_by_run.setdefault(run_id, []).extend(_operations([request]))

    first_run_actions = [
        _FIRST_GENERATED_RESPONSE_CREATE_SENT,
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
        _FIRST_TEXT_IN_LATER_GENERATED_RESPONSE,
    ]
    direct_run_actions = [
        _FIRST_GENERATED_RESPONSE_CREATE_SENT,
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
        _FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE,
    ]
    assert {
        run_id: [operation["action_type"] for operation in operations]
        for run_id, operations in operations_by_run.items()
    } == {
        "run-abc-123": first_run_actions,
        "run-reused-sandbox": direct_run_actions,
    }


def test_irrelevant_websocket_messages_do_not_report_timings(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)

        set_websocket_message(
            flow,
            from_client=True,
            content=_event("response.output_item.added"),
        )
        mitm_addon.websocket_message(flow)
        _feed_client_event(flow, b'{"type":')
        _feed_client_event(flow, _event("future.client-event"))
        _feed_client_event(flow, _event("response.create"))
        feed_websocket_server_message(flow, b'{"type":')
        feed_websocket_server_message(flow, _event("future.unknown"))
        feed_websocket_server_message(flow, _event("response.output_text.delta"))

        unobservable = make_openai_responses_websocket_flow(real_flow, tmp_path)
        set_websocket_message(
            unobservable,
            from_client=False,
            content=_event("response.output_item.added"),
        )
        mitm_addon.websocket_message(unobservable)

    assert _timing_requests(usage_webhook_server) == []


@pytest.mark.parametrize(
    ("from_client", "event_type"),
    [(True, "response.create"), (False, "response.output_text.delta")],
)
def test_websocket_event_type_is_probed_once(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    *,
    from_client: bool,
    event_type: str,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    probe_code = json_probe.probe_top_level_string_field.__code__
    probe_calls = 0

    def count_probe(frame: FrameType, event: str, _arg: object) -> None:
        nonlocal probe_calls
        if event == "call" and frame.f_code is probe_code:
            probe_calls += 1

    previous_profile = sys.getprofile()
    with mitm_ctx():
        mitm_addon.responseheaders(flow)
        sys.setprofile(count_probe)
        try:
            set_websocket_message(
                flow,
                from_client=from_client,
                content=_event(event_type),
            )
            mitm_addon.websocket_message(flow)
        finally:
            sys.setprofile(previous_profile)

    assert probe_calls == 1


def test_ambiguous_client_correlations_keep_timing_without_full_parse(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
    sync_usage_executor,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    model_provider_failure.admit_flow(flow)
    full_body_feeds = capture_openai_responses_extractor_feeds(monkeypatch)
    probe_code = json_probe.probe_top_level_string_field.__code__
    probe_calls = 0

    def count_probe(frame: FrameType, event: str, _arg: object) -> None:
        nonlocal probe_calls
        if event == "call" and frame.f_code is probe_code:
            probe_calls += 1

    with mitm_ctx(api_url=usage_webhook_server.api_url):
        mitm_addon.responseheaders(flow)
        _feed_client_event(flow, b"not-json")
        assert full_body_feeds.count(b"not-json") == 1
        full_body_feeds.clear()

        previous_profile = sys.getprofile()
        sys.setprofile(count_probe)
        try:
            _feed_client_event(
                flow,
                _event("response.create"),
                received_at=1_700_000_000.125,
            )
        finally:
            sys.setprofile(previous_profile)

        feed_websocket_server_message(flow, _event("response.created"))
        feed_websocket_server_message(flow, _event("response.output_item.added"))

    assert probe_calls == 1
    assert full_body_feeds == []
    assert [
        operation["action_type"]
        for operation in _operations(_timing_requests(usage_webhook_server))
    ] == [
        _FIRST_GENERATED_RESPONSE_CREATE_SENT,
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
    ]


def test_eviction_and_reset_release_retained_buffered_report(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
) -> None:
    control_root = tmp_path / "delivery-control"

    with (
        mitm_ctx(api_url="https://api.test"),
        patch.object(
            usage.webhook,
            "enqueue_webhook_delivery",
            return_value=False,
        ),
        patch.object(codex_output_timing._store, "_max_tracked_runs", 1),
    ):
        first_flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        first_flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-first"
        mitm_addon.responseheaders(first_flow)
        _feed_generated_response(first_flow, include_text=False)

        second_flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        second_flow.metadata[metadata_keys.SANDBOX_RUN_ID] = "run-second"
        mitm_addon.responseheaders(second_flow)
        _feed_generated_response(second_flow, include_text=False)

        assert_pending(
            control_root,
            flows=0,
            buffered=1,
            reports=0,
        )

        codex_output_timing.reset_for_tests()

    assert_pending(
        control_root,
        flows=0,
        buffered=0,
        reports=0,
    )


def test_lru_hit_recency_preserves_recent_buffered_report(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
) -> None:
    control_root = tmp_path / "delivery-control"
    delivery_available = False

    def enqueue_timing_delivery(
        _url: str,
        _sandbox_token: str,
        _payload: dict[str, object],
        _proxy_log_path: str,
        _log_type: str,
    ) -> bool:
        return delivery_available

    def codex_flow(run_id: str) -> http.HTTPFlow:
        flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
        flow.metadata[metadata_keys.SANDBOX_RUN_ID] = run_id
        mitm_addon.responseheaders(flow)
        return flow

    with (
        mitm_ctx(api_url="https://api.test"),
        patch.object(
            usage.webhook,
            "enqueue_webhook_delivery",
            side_effect=enqueue_timing_delivery,
        ),
        patch.object(codex_output_timing._store, "_max_tracked_runs", 2),
    ):
        first_flow = codex_flow("run-a")
        _feed_generated_response(first_flow, include_text=False)

        second_flow = codex_flow("run-b")
        _feed_generated_response(second_flow, include_text=False)

        feed_websocket_server_message(first_flow, _event("response.completed"))

        overflow_flow = codex_flow("run-c")
        _feed_generated_response(overflow_flow, include_text=False)

        assert_pending(
            control_root,
            flows=0,
            buffered=2,
            reports=0,
        )

        delivery_available = True
        feed_websocket_server_message(second_flow, _event("response.completed"))
        assert_pending(
            control_root,
            flows=0,
            buffered=2,
            reports=0,
        )

        feed_websocket_server_message(first_flow, _event("response.completed"))
        assert_pending(
            control_root,
            flows=0,
            buffered=1,
            reports=0,
        )


def test_repeated_runner_flush_retries_saturated_timing_after_websocket_end(
    tmp_path: Path,
    real_flow,
    mitm_ctx,
    usage_webhook_server: UsageWebhookServer,
) -> None:
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    executor = QueuedUsageExecutor()
    control_root = tmp_path
    secret = "provider-secret-that-must-not-be-reported"

    with (
        mitm_ctx(api_url=usage_webhook_server.api_url),
        patch.object(usage.webhook, "usage_executor", executor),
    ):
        mitm_addon.responseheaders(flow)
        for index in range(usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS):
            assert usage.webhook.enqueue_webhook_delivery(
                usage_webhook_server.url("/filler"),
                "tok-xyz",
                {"runId": f"filler-{index}", "events": []},
                str(tmp_path / "filler.jsonl"),
                "usage_event",
            )

        _feed_generated_response(flow, secret=secret)
        feed_websocket_server_message(flow, _event("response.completed", secret=secret))
        mitm_addon.websocket_end(flow)
        assert _timing_requests(usage_webhook_server) == []

        first_flush_started_at = datetime.now(UTC)
        request_runner_usage_flush()
        assert_pending(
            control_root,
            flows=0,
            buffered=1,
            reports=usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS,
        )

        executor.run_next()
        request_runner_usage_flush()
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=usage.webhook.MAX_PENDING_WEBHOOK_PAYLOADS,
        )

        executor.run_all()
        request_runner_usage_flush()
        assert_pending(
            control_root,
            flows=0,
            buffered=0,
            reports=0,
        )

    [request] = _timing_requests(usage_webhook_server)
    operations = _operations([request])
    assert [operation["action_type"] for operation in operations] == [
        _FIRST_GENERATED_RESPONSE_CREATE_SENT,
        _FIRST_GENERATED_RESPONSE_CREATED,
        _FIRST_OUTPUT_ITEM_ADDED,
        _FIRST_OUTPUT_TEXT_DELTA,
        _FIRST_TEXT_IN_FIRST_GENERATED_RESPONSE,
    ]
    sent_at = datetime.fromisoformat(str(operations[0]["ts"]))
    created_at = datetime.fromisoformat(str(operations[1]["ts"]))
    output_at = datetime.fromisoformat(str(operations[2]["ts"]))
    text_at = datetime.fromisoformat(str(operations[3]["ts"]))
    path_at = datetime.fromisoformat(str(operations[4]["ts"]))
    assert sent_at <= created_at <= output_at <= text_at == path_at <= first_flush_started_at
    assert secret.encode() not in request.body
    assert usage.webhook.pending_delivery_payload_count_for_tests() == 0
