"""Request-lifetime X URL parsing through parser dispatch and response hooks."""

import gc
import tracemalloc
import urllib.parse

import pytest

import flow_metadata_keys as metadata_keys
import matching
import mitm_addon
import usage
from tests.flow_helpers import response_stream
from tests.x_flow_helpers import RealFlowFactory, make_x_pipeline_flow


def _register_and_report_large_urls(real_flow: RealFlowFactory, path: str, body: bytes) -> None:
    for index in range(128):
        original_url = f"https://api.x.com{path}?ids=1,2&unused={index}-" + "a" * (60 * 1024)
        flow = real_flow(host="api.x.com", path=path)
        flow.metadata.update(
            {
                metadata_keys.FIREWALL_NAME: "x",
                metadata_keys.FIREWALL_BILLABLE: True,
                metadata_keys.FIREWALL_PERMISSION: "tweet.read",
                metadata_keys.ORIGINAL_URL: original_url,
            }
        )
        parser = usage.create_connector_response_parser(flow)
        assert parser is not None
        parser.feed(body)
        if parser.finish is not None:
            parser.finish()
        # Missing delivery context keeps this allocation check focused on URL
        # ownership. Complete billing/resource output is exercised below.
        usage.report_connector_usage(flow, "run-url-cache")


@pytest.mark.parametrize(
    ("path", "body"),
    [
        pytest.param("/2/tweets", b'{"data":[{"id":"1"}]}', id="json"),
        pytest.param("/2/tweets", b"invalid", id="query-hint-fallback"),
        pytest.param("/2/tweets/search/stream", b'{"data":{"id":"1"}}\n', id="ndjson"),
    ],
)
def test_completed_x_flows_do_not_retain_large_urls(real_flow, mitm_ctx, path, body):
    urllib.parse.urlsplit.cache_clear()
    try:
        assert matching.firewall_base_config_is_valid("https://stable-config.example.com")
        stable_cache = urllib.parse.urlsplit.cache_info()
        gc.collect()
        tracemalloc.start()
        try:
            with mitm_ctx():
                _register_and_report_large_urls(real_flow, path, body)
            gc.collect()
            retained_bytes = tracemalloc.get_traced_memory()[0]
        finally:
            tracemalloc.stop()

        # The released URLs contain over 7 MiB of query bytes. Allow incidental
        # allocations, but not aggregate URL/query retention after flow cleanup.
        assert retained_bytes < 1024 * 1024
        assert urllib.parse.urlsplit.cache_info() == stable_cache
    finally:
        urllib.parse.urlsplit.cache_clear()


@pytest.mark.parametrize("params", ["", ";legacy=1"])
@pytest.mark.parametrize(
    ("path", "permission", "body", "query_bytes", "quantity", "resources", "remainder"),
    [
        pytest.param(
            "/2/tweets",
            "tweet.read",
            b'{"data":[{"id":"1"}]}',
            60 * 1024,
            1,
            [{"id": "1", "occurrences": 1}],
            [],
            id="json-posts",
        ),
        pytest.param(
            "/2/users",
            "users.read",
            b'{"data":[{"id":"7"}]}',
            60 * 1024,
            1,
            [{"id": "7", "occurrences": 1}],
            [],
            id="json-users",
        ),
        pytest.param(
            "/2/tweets/counts/recent",
            "tweet.read",
            b'{"data":[{"tweet_count":2}],"meta":{"total_tweet_count":2}}',
            60 * 1024,
            2,
            [],
            [{"reason": "unsupported_resource", "quantity": 2}],
            id="counts",
        ),
        pytest.param(
            "/2/tweets/search/stream",
            "tweet.read",
            b'{"data":{"id":"1"}}\n',
            60 * 1024,
            1,
            [{"id": "1", "occurrences": 1}],
            [],
            id="ndjson",
        ),
        pytest.param(
            "/2/tweets",
            "tweet.read",
            b"invalid",
            60 * 1024,
            2,
            [],
            [{"reason": "parse_fallback", "quantity": 2}],
            id="query-hint-fallback",
        ),
        pytest.param(
            "/2/tweets",
            "tweet.read",
            b"invalid",
            64 * 1024 + 1,
            0,
            [],
            [],
            id="over-budget-hints",
        ),
    ],
)
def test_x_response_hooks_preserve_billing_without_caching_runtime_urls(
    real_flow,
    tmp_path,
    usage_webhook_api,
    sync_usage_executor,
    path,
    permission,
    body,
    query_bytes,
    quantity,
    resources,
    remainder,
    params,
):
    query = "ids=1,2&unused=" + "a" * query_bytes
    flow = make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path=f"{path}?{query}",
        original_url=f"https://api.x.com{path}{params}?{query}#fragment",
        permission=permission,
    )

    with usage_webhook_api() as webhook:
        urllib.parse.urlsplit.cache_clear()
        try:
            assert matching.firewall_base_config_is_valid("https://stable-config.example.com")
            stable_cache = urllib.parse.urlsplit.cache_info()

            mitm_addon.responseheaders(flow)
            stream = response_stream(flow)
            assert stream(body) == body
            stream(b"")
            mitm_addon.response(flow)

            assert urllib.parse.urlsplit.cache_info() == stable_cache
            # HTTP delivery may legitimately parse/cache its stable API URL.
            usage.flush_usage_events(trigger="test")
        finally:
            urllib.parse.urlsplit.cache_clear()

    events = webhook.usage_events()
    if quantity == 0:
        assert events == []
    else:
        (event,) = events
        assert event["category"] == ("user.read" if permission == "users.read" else "posts.read")
        assert event["quantity"] == quantity
        assert event["protocol"] == "x-resource-v1"
        assert event["resources"] == resources
        assert event["remainder"] == remainder
