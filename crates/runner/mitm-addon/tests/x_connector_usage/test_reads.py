"""Direct X connector usage reporting tests."""

import gzip
import json

import pytest

import flow_metadata_keys as metadata_keys
import usage
from tests.jsonl_log_helpers import (
    read_jsonl_entries_after_flush,
    read_jsonl_text_after_flush,
)


def test_logs_single_resource_get(x_usage, tmp_path, real_flow):
    """GET /2/tweets/:id with tweet.read permission bills posts.read, quantity=1."""
    body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
    flow = x_usage.make_flow(
        real_flow, tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}"
    )
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 1


def test_logs_batch_ids(x_usage, tmp_path, real_flow):
    """GET /2/tweets?ids=1,2,3 with tweet.read permission bills posts.read, quantity=3."""
    body = json.dumps({"data": [{"id": "1"}, {"id": "2"}, {"id": "3"}]}).encode()
    flow = x_usage.make_flow(real_flow, tmp_path, query="ids=1,2,3", body=body)
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 3


def test_logs_lowercase_get_using_response_count(x_usage, tmp_path, real_flow):
    """Lowercase GET methods use the same response-count billing as GET."""
    body = json.dumps({"data": [{"id": "1"}, {"id": "2"}, {"id": "3"}]}).encode()
    flow = x_usage.make_flow(real_flow, tmp_path, body=body)
    flow.request.method = "get"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 3


def test_logs_batch_ids_with_deletions(x_usage, tmp_path, real_flow):
    """Batch with some missing ids -> bills actual data returned."""
    body = json.dumps({"data": [{"id": "1"}, {"id": "3"}]}).encode()
    flow = x_usage.make_flow(real_flow, tmp_path, query="ids=1,2,3", body=body)
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 2


def test_logs_expansions_includes(x_usage, tmp_path, real_flow):
    """?expansions=author_id -> three billing payloads for each resource type."""
    body = json.dumps(
        {
            "data": [{"id": "1", "author_id": "99"}],
            "includes": {
                "users": [{"id": "99"}],
                "media": [{"media_key": "m1"}, {"media_key": "m2"}],
            },
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        query="expansions=author_id,attachments.media_keys",
        body=body,
    )
    payloads = x_usage.call_and_get_billing(flow)
    by_cat = {p["category"]: p["quantity"] for p in payloads}
    assert len(payloads) == len(by_cat)
    assert by_cat == {"posts.read": 1, "user.read": 1, "media.read": 2}


def test_posts_usage_events_as_one_batch(x_usage, tmp_path, real_flow):
    """One X response with multiple categories sends one batched webhook."""
    body = json.dumps(
        {
            "data": [{"id": "1", "author_id": "99"}],
            "includes": {"users": [{"id": "99"}]},
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        query="expansions=author_id",
        body=body,
    )

    with x_usage.webhook() as webhook:
        usage.report_connector_usage(flow, "run-abc-123")
        assert webhook.request_count == 0
        usage.flush_usage_events(trigger="test")

    assert webhook.request_count == 1
    [payload] = webhook.json_bodies()
    assert payload["runId"] == "run-abc-123"
    assert "idempotencyKey" not in payload
    by_cat = {event["category"]: event for event in payload["events"]}
    assert len(payload["events"]) == len(by_cat)
    assert set(by_cat) == {"posts.read", "user.read"}
    assert by_cat["posts.read"]["kind"] == "connector"
    assert by_cat["posts.read"]["provider"] == "x"
    assert by_cat["posts.read"]["quantity"] == 1
    assert by_cat["user.read"]["quantity"] == 1


def test_source_dedupe_handles_colon_bearing_run_and_flow_ids(x_usage, tmp_path, real_flow):
    body = json.dumps({"data": {"id": "1", "text": "hi"}}).encode()
    first = x_usage.make_flow(
        real_flow, tmp_path, path="/2/tweets/1", body=body, rule="GET /2/tweets/{id}"
    )
    second = x_usage.make_flow(
        real_flow, tmp_path, path="/2/tweets/2", body=body, rule="GET /2/tweets/{id}"
    )
    first.id = "flow"
    second.id = "a:flow"

    with x_usage.webhook() as webhook:
        usage.report_connector_usage(first, "run:a")
        usage.report_connector_usage(second, "run")
        usage.flush_usage_events(trigger="test")

    events_by_run = {body["runId"]: body["events"] for body in webhook.json_bodies()}
    assert set(events_by_run) == {"run", "run:a"}
    assert sum(event["quantity"] for events in events_by_run.values() for event in events) == 2
    assert {
        (event["kind"], event["provider"], event["category"], event["quantity"])
        for events in events_by_run.values()
        for event in events
    } == {("connector", "x", "posts.read", 1)}


def test_bounds_unknown_include_categories_before_buffering(x_usage, tmp_path, real_flow):
    """Unknown includes cannot create unbounded synthetic usage categories."""
    body = json.dumps(
        {
            "data": [],
            "includes": {f"future_{index}": [{"id": str(index)}] for index in range(101)},
        }
    ).encode()
    flow = x_usage.make_flow(real_flow, tmp_path, query="expansions=future", body=body)

    with x_usage.webhook() as webhook:
        usage.report_connector_usage(flow, "run-abc-123")
        usage.flush_usage_events(trigger="test")

    bodies = webhook.json_bodies()
    assert [len(body["events"]) for body in bodies] == [65]
    assert {body["runId"] for body in bodies} == {"run-abc-123"}
    assert all(
        event["kind"] == "connector" and event["provider"] == "x"
        for body in bodies
        for event in body["events"]
    )
    events = [event for body in bodies for event in body["events"]]
    by_cat = {event["category"]: event["quantity"] for event in events}
    assert len(events) == len(by_cat)
    assert by_cat == {
        **{f"includes.future_{index}": 1 for index in range(64)},
        "includes.__overflow__": 37,
    }
    assert all(len(category) <= 100 for category in by_cat)


def test_overlong_unknown_include_key_uses_overflow_category(x_usage, tmp_path, real_flow):
    """Unsafe synthetic categories are folded into the fallback-priced overflow bucket."""
    overlong_key = "x" * 92
    body = json.dumps(
        {
            "data": [{"id": "1"}],
            "includes": {
                overlong_key: [{"id": "long"}],
                "bad/key": [{"id": "unsafe"}, {"id": "unsafe-2"}],
                "__overflow__": [{"id": "reserved"}],
            },
        }
    ).encode()
    flow = x_usage.make_flow(real_flow, tmp_path, query="expansions=future", body=body)

    payloads = x_usage.call_and_get_billing(flow)
    by_cat = {p["category"]: p["quantity"] for p in payloads}

    assert len(payloads) == len(by_cat)
    assert by_cat == {"posts.read": 1, "includes.__overflow__": 4}
    assert all(len(category) <= 100 for category in by_cat)


def test_empty_search_emits_no_billing(x_usage, tmp_path, real_flow):
    """Search returning zero results emits no usage_event row."""
    body = json.dumps({"data": [], "meta": {"result_count": 0}}).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        query="query=nothing",
        body=body,
        rule="GET /2/tweets/search/recent",
    )
    payloads = x_usage.call_and_get_billing(flow)
    assert payloads == []


def test_soft_error_with_request_hints_emits_no_billing(x_usage, tmp_path, real_flow):
    """HTTP 200 + errors array + no data field emits no usage_event
    row (issue #9620)."""
    body = json.dumps(
        {
            "errors": [
                {
                    "value": "999999999999999999",
                    "detail": "Could not find tweet with id: [999999999999999999].",
                    "title": "Not Found Error",
                    "resource_type": "tweet",
                    "parameter": "id",
                    "type": "https://api.twitter.com/2/problems/resource-not-found",
                }
            ]
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        query="ids=999999999999999999",
        body=body,
        rule="GET /2/tweets",
    )
    payloads = x_usage.call_and_get_billing(flow)
    assert payloads == []


def test_zero_result_search_with_max_results_emits_no_billing(x_usage, tmp_path, real_flow):
    """Search with max_results=10 returning 0 results emits no
    usage_event row (issue #9620)."""
    body = json.dumps({"meta": {"result_count": 0, "newest_id": None}}).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        query="query=xyzzy_no_results&max_results=10",
        body=body,
        rule="GET /2/tweets/search/recent",
    )
    payloads = x_usage.call_and_get_billing(flow)
    assert payloads == []


def test_logs_expansions_users_and_referenced_tweets(x_usage, tmp_path, real_flow):
    """includes.users and includes.tweets produce two billing payloads."""
    body = json.dumps(
        {
            "data": [{"id": "1", "author_id": "99", "referenced_tweets": [{"id": "ref1"}]}],
            "includes": {
                "users": [{"id": "99"}, {"id": "author2"}],
                "tweets": [{"id": "ref1"}, {"id": "ref2"}],
            },
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        query="expansions=author_id,referenced_tweets.id",
        body=body,
    )
    payloads = x_usage.call_and_get_billing(flow)
    by_cat = {p["category"]: p["quantity"] for p in payloads}
    assert len(payloads) == len(by_cat)
    assert by_cat == {
        "posts.read": 3,  # 1 primary + 2 referenced tweets
        "user.read": 2,
    }


def test_handles_unknown_includes_key(x_usage, tmp_path, real_flow):
    """Unknown includes.<key> types emit a synthetic ``includes.<key>``
    category (the billing processor applies a server-side fallback
    price) and emit a warn log at the decision point."""
    sensitive_query = "vm0-sensitive-unknown-includes"
    body = json.dumps(
        {
            "data": [{"id": "1"}],
            "includes": {
                "users": [{"id": "99"}],
                "future_widget": [{"id": "w1"}, {"id": "w2"}, {"id": "w3"}],
            },
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path=f"/2/tweets?expansions=author_id&query={sensitive_query}",
        body=body,
    )
    payloads = x_usage.call_and_get_billing(flow)
    by_cat = {p["category"]: p["quantity"] for p in payloads}
    assert len(payloads) == len(by_cat)
    # 1 primary (posts.read) + 1 users include (mapped to user.read)
    # + 3 unknown-widget includes (emitted as `includes.future_widget`).
    assert by_cat == {
        "posts.read": 1,
        "user.read": 1,
        "includes.future_widget": 3,
    }
    proxy_log = tmp_path / "proxy.jsonl"
    content = read_jsonl_text_after_flush(proxy_log)
    assert "future_widget" in content
    assert "unrecognised" in content.lower()
    assert '"level":"warn"' in content or '"level": "warn"' in content
    assert sensitive_query not in content
    entries = [json.loads(line) for line in content.splitlines()]
    matching_entries = [
        entry
        for entry in entries
        if entry.get("level") == "warn" and "unrecognised" in entry.get("message", "").lower()
    ]
    assert len(matching_entries) == 1
    entry = matching_entries[0]
    assert entry["url"] == "https://api.x.com/2/tweets"


def test_logs_search_meta_result_count(x_usage, tmp_path, real_flow):
    """Search response with meta.result_count -> quantity=20."""
    body = json.dumps(
        {
            "data": [{"id": str(i)} for i in range(20)],
            "meta": {"result_count": 20, "next_token": "abc"},
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        query="query=hello&max_results=100",
        body=body,
        permission="tweet.read",
        rule="GET /2/tweets/search/recent",
    )
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 20


def test_logs_users_by_usernames_batch(x_usage, tmp_path, real_flow):
    """GET /2/users/by?usernames=a,b,c with users.read permission bills user.read, quantity=2."""
    body = json.dumps(
        {"data": [{"id": "1", "username": "a"}, {"id": "2", "username": "b"}]}
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/users/by",
        query="usernames=a,b,c",
        body=body,
        permission="users.read",
        rule="GET /2/users/by",
    )
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "user.read"
    assert p["quantity"] == 2


def test_logs_tweet_counts_total_tweet_count(x_usage, tmp_path, real_flow):
    """GET /2/tweets/counts/recent with tweet.read permission bills posts.read, quantity=12567."""
    body = json.dumps(
        {
            "data": [
                {"start": "2026-04-14T00:00", "end": "2026-04-15T00:00", "tweet_count": 8000},
                {"start": "2026-04-15T00:00", "end": "2026-04-16T00:00", "tweet_count": 4567},
            ],
            "meta": {"total_tweet_count": 12567},
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/counts/recent",
        query="query=hello",
        body=body,
        rule="GET /2/tweets/counts/recent",
    )
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 12567


def test_tweet_counts_zero_total_does_not_bill_buckets(x_usage, tmp_path, real_flow):
    """Count endpoint data arrays are time buckets, not returned posts."""
    body = json.dumps(
        {
            "data": [
                {"start": "2026-04-14T00:00", "end": "2026-04-15T00:00", "tweet_count": 0},
                {"start": "2026-04-15T00:00", "end": "2026-04-16T00:00", "tweet_count": 0},
            ],
            "meta": {"total_tweet_count": 0},
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/counts/recent",
        query="query=nothing",
        body=body,
        rule="GET /2/tweets/counts/recent",
    )

    assert x_usage.call_and_get_billing(flow) == []


@pytest.mark.parametrize(
    "path",
    ["/2/tweets/counts/recent", "/2/tweets/counts/all"],
)
def test_tweet_counts_total_lower_than_bucket_count_bills_total(x_usage, tmp_path, real_flow, path):
    """Both count endpoints bill total_tweet_count, not time-bucket count."""
    body = json.dumps(
        {
            "data": [
                {"start": "2026-04-14T00:00", "end": "2026-04-15T00:00", "tweet_count": 1},
                {"start": "2026-04-15T00:00", "end": "2026-04-16T00:00", "tweet_count": 0},
                {"start": "2026-04-16T00:00", "end": "2026-04-17T00:00", "tweet_count": 0},
            ],
            "meta": {"total_tweet_count": 1},
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path=path,
        query="query=rare",
        body=body,
        rule=f"GET {path}",
    )

    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 1


def test_tweet_counts_path_matching_requires_exact_endpoint(x_usage, tmp_path, real_flow):
    body = json.dumps(
        {
            "data": [{"id": "1"}, {"id": "2"}, {"id": "3"}],
            "meta": {"total_tweet_count": 1},
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/counts/recent/extra",
        body=body,
        rule="GET /2/tweets/counts/recent/extra",
    )

    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 3


@pytest.mark.parametrize(
    ("meta", "query"),
    [
        pytest.param({}, "query=missing_total", id="missing"),
        pytest.param(
            {"total_tweet_count": -1},
            "query=negative_total",
            id="negative",
        ),
    ],
)
def test_tweet_counts_invalid_total_skips_billing_and_logs_underbilling(
    x_usage, tmp_path, real_flow, meta, query
):
    """Parsed count endpoints without a valid total should not bill buckets."""
    body = json.dumps(
        {
            "data": [
                {"start": "2026-04-14T00:00", "end": "2026-04-15T00:00", "tweet_count": 2},
                {"start": "2026-04-15T00:00", "end": "2026-04-16T00:00", "tweet_count": 3},
            ],
            "meta": meta,
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/counts/recent",
        query=query,
        body=body,
        rule="GET /2/tweets/counts/recent",
    )
    assert metadata_keys.X_JSON_STATE not in flow.metadata

    assert x_usage.call_and_get_billing(flow) == []

    proxy_log = tmp_path / "proxy.jsonl"
    entries = read_jsonl_entries_after_flush(proxy_log)
    matching_entries = [
        entry for entry in entries if entry["reason"] == "missing_count_endpoint_total"
    ]
    assert len(matching_entries) == 1
    assert matching_entries[0]["level"] == "error"
    assert matching_entries[0]["type"] == "usage_underbilling"
    assert matching_entries[0]["underbilling_class"] == "confirmed"
    assert matching_entries[0]["component"] == "mitm_addon"
    assert matching_entries[0]["firewall_name"] == "x"
    assert matching_entries[0]["permission"] == "tweet.read"
    assert matching_entries[0]["response_data_count"] == 2


def test_tweet_counts_unparseable_ignores_request_hints_and_logs_error(
    x_usage, tmp_path, real_flow
):
    """Count endpoint request hints do not represent returned post count."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/counts/recent",
        query="max_results=50",
        body=b"not json",
        rule="GET /2/tweets/counts/recent",
    )

    assert x_usage.call_and_get_billing(flow) == []

    proxy_log = tmp_path / "proxy.jsonl"
    entries = read_jsonl_entries_after_flush(proxy_log)
    assert any(
        entry["level"] == "error" and "count endpoint" in entry["message"] for entry in entries
    )


def test_handles_gzip_body(x_usage, tmp_path, real_flow):
    """gzip-encoded response body decompresses before parsing."""
    raw = json.dumps({"data": [{"id": "1"}], "meta": {"result_count": 1}}).encode()
    body = gzip.compress(raw)
    flow = x_usage.make_flow(real_flow, tmp_path, body=body, content_encoding="gzip")
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 1


def test_query_string_does_not_break_literal_suffix_override(x_usage, tmp_path, real_flow):
    """``flow.request.path`` from mitmproxy includes the query string;
    literal-suffix overrides (e.g. ``/2/tweets/{id}/retweeted_by``)
    must still fire.  Regression guard for under-charging on
    popular paginated read endpoints."""
    body = json.dumps({"data": [{"id": "u1"}, {"id": "u2"}]}).encode()
    # The helper sets flow.request.path = path (no query), so we
    # craft the path-with-query explicitly to mirror what mitmproxy
    # delivers in real traffic.
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/123/retweeted_by?max_results=10",
        body=body,
        permission="tweet.read",
        rule="GET /2/tweets/{id}/retweeted_by",
    )
    # The ?max_results metadata goes into original_url for
    # req-meta parsing to consume.
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        "https://api.x.com/2/tweets/123/retweeted_by?max_results=10"
    )
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "user.read"
    assert p["quantity"] == 2


def test_expansion_with_empty_includes_array(x_usage, tmp_path, real_flow):
    """includes.users is empty array -> no users.read billing record."""
    body = json.dumps(
        {
            "data": [{"id": "1"}],
            "includes": {"users": []},
        }
    ).encode()
    flow = x_usage.make_flow(real_flow, tmp_path, query="expansions=author_id", body=body)
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 1


def test_empty_search_with_includes_emits_only_includes(x_usage, tmp_path, real_flow):
    """Search returns 0 data but non-empty includes -> only the
    includes row is emitted; the zero-primary row is skipped."""
    body = json.dumps(
        {
            "data": [],
            "meta": {"result_count": 0},
            "includes": {"users": [{"id": "u1"}]},
        }
    ).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        query="query=test&expansions=author_id",
        body=body,
        rule="GET /2/tweets/search/recent",
    )
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "user.read"
    assert p["quantity"] == 1
