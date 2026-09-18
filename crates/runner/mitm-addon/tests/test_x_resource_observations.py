"""Resource observation accounting through production response hooks and HTTP delivery."""

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from mitmproxy.flow import Error

import mitm_addon
import usage
from tests.flow_helpers import response_stream
from tests.x_flow_helpers import make_x_pipeline_flow
from usage.providers.connectors import x_resources


@pytest.fixture(autouse=True)
def _inline_delivery(sync_usage_executor):
    pass


def _flow(real_flow, tmp_path, *, path="/2/tweets", permission="tweet.read"):
    return make_x_pipeline_flow(
        real_flow, tmp_path, path=path, permission=permission, sandbox_run_id=str(uuid.uuid4())
    )


def _complete(flow, body):
    mitm_addon.responseheaders(flow)
    response_stream(flow)(body)
    response_stream(flow)(b"")
    mitm_addon.response(flow)
    usage.flush_usage_events(trigger="test")


def test_json_preserves_occurrences_expansions_exact_ids_and_unidentified_remainder(
    real_flow, tmp_path, usage_webhook_api
):
    flow = _flow(real_flow, tmp_path)
    body = json.dumps(
        {
            "data": [
                {"id": "001"},
                {"id": "001"},
                {"id": 3},
                {"referenced_tweets": [{"id": "99"}]},
            ],
            "meta": {"result_count": 5},
            "includes": {
                "tweets": [{"id": "001"}, {"id": "2"}],
                "users": [{"id": "7"}],
                "polls": [{"id": "8"}],
            },
        }
    ).encode()
    with usage_webhook_api() as webhook:
        _complete(flow, body)
        # Even after flush, duplicate terminal hooks cannot create another obligation.
        mitm_addon.response(flow)
        flow.error = Error("late transport close")
        mitm_addon.error(flow)
        usage.flush_usage_events(trigger="test")
    events = {event["category"]: event for event in webhook.usage_events()}
    assert set(events) == {"posts.read", "user.read"}
    post = events["posts.read"]
    assert post["quantity"] == 8
    assert post["resources"] == [{"id": "001", "occurrences": 3}, {"id": "2", "occurrences": 1}]
    assert post["remainder"] == [
        {"reason": "missing_id", "quantity": 3},
        {"reason": "unsupported_resource", "quantity": 1},
    ]
    assert events["user.read"]["resources"] == [{"id": "7", "occurrences": 1}]
    assert all(event["protocol"] == "x-resource-v1" for event in events.values())
    assert len(webhook.usage_events()) == 2


@pytest.mark.parametrize(
    ("body", "reason", "quantity"),
    [
        (b'{"data":[{"id":"1"}],"text":"' + b"a" * (256 * 1024) + b'"}', "identity_limit", 1),
        (b'{"data":[{"id":"1"}]} trailing', "parse_fallback", 2),
        (json.dumps({"data": [{"id": str(i)} for i in range(1001)]}).encode(), "identity_limit", 1),
    ],
)
def test_bounded_or_malformed_identity_inspection_preserves_original_count(
    real_flow, tmp_path, usage_webhook_api, body, reason, quantity
):
    flow = _flow(real_flow, tmp_path, path="/2/tweets?ids=1,2")
    with usage_webhook_api() as webhook:
        _complete(flow, body)
    (event,) = webhook.usage_events()
    assert event["remainder"] == [{"reason": reason, "quantity": quantity}]
    assert event["quantity"] == sum(item["occurrences"] for item in event["resources"]) + quantity
    assert len(event["resources"]) <= 1000


def test_profile_ids_are_supported_but_unknown_posts_paths_do_not_claim_ids(
    real_flow, tmp_path, usage_webhook_api
):
    with usage_webhook_api() as webhook:
        _complete(
            _flow(
                real_flow, tmp_path, path="/2/users/by/username/example", permission="users.read"
            ),
            b'{"data":{"id":"0007"}}',
        )
        _complete(
            _flow(real_flow, tmp_path, path="/2/tweets/compliance/stream"),
            b'{"data":{"id":"900"}}\n',
        )
    events = {event["category"]: event for event in webhook.usage_events()}
    assert events["user.read"]["resources"] == [{"id": "0007", "occurrences": 1}]
    assert events["posts.read"]["resources"] == []
    assert events["posts.read"]["remainder"] == [{"reason": "unsupported_resource", "quantity": 1}]


def test_count_endpoint_ignores_data_and_expansion_ids_when_preserving_total(
    real_flow, tmp_path, usage_webhook_api
):
    flow = _flow(real_flow, tmp_path, path="/2/tweets/counts/recent")
    body = json.dumps(
        {
            "data": [{"id": "900", "tweet_count": 2}],
            "meta": {"total_tweet_count": 2},
            "includes": {"tweets": [{"id": "1"}, {"id": "2"}, {"id": "3"}]},
        }
    ).encode()
    with usage_webhook_api() as webhook:
        _complete(flow, body)
    (event,) = webhook.usage_events()
    assert event["quantity"] == 2
    assert event["resources"] == []
    assert event["remainder"] == [{"reason": "unsupported_resource", "quantity": 2}]


def test_ndjson_reports_complete_rows_during_stream_and_never_at_terminal_again(
    real_flow, tmp_path, usage_webhook_api
):
    flow = _flow(real_flow, tmp_path, path="/2/tweets/search/stream")
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        stream(b'{"data":{"id":"1"}}\nmalformed\n{"data":{"id":"2"')
        usage.flush_usage_events(trigger="test")
        assert [event["resources"] for event in webhook.usage_events()] == [
            [{"id": "1", "occurrences": 1}]
        ]
        stream(b"}}")
        flow.error = Error("stream disconnected after a complete trailing row")
        mitm_addon.error(flow)
        usage.flush_usage_events(trigger="test")
        mitm_addon.error(flow)
        usage.flush_usage_events(trigger="test")
    events = webhook.usage_events()
    assert [event["resources"] for event in events] == [
        [{"id": "1", "occurrences": 1}],
        [{"id": "2", "occurrences": 1}],
    ]
    assert len({event["idempotencyKey"] for event in events}) == 2


def test_rows_crossing_midnight_keep_their_observation_time_after_delayed_completion(
    real_flow, tmp_path, usage_webhook_api, monkeypatch
):
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)

    class Clock(datetime):
        value = today - timedelta(milliseconds=1)

        @classmethod
        def now(cls, tz=None):
            return cls.value

    monkeypatch.setattr(x_resources, "datetime", Clock)
    flow = _flow(real_flow, tmp_path, path="/2/tweets/search/stream")
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        stream(b'{"data":{"id":"1"}}\n')
        Clock.value = today
        stream(b'{"data":{"id":"1"}}\n')
        Clock.value = today + timedelta(hours=1)
        stream(b"")
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")
    events = webhook.usage_events()
    assert len(events) == 2
    assert [event["observedAt"] for event in events] == [
        (today - timedelta(milliseconds=1))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        today.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    ]
    assert all(event["quantity"] == 1 for event in events)
    assert all(event["resources"] == [{"id": "1", "occurrences": 1}] for event in events)
    assert len({event["idempotencyKey"] for event in events}) == 2
