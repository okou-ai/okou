"""Tweet-create nesting bounds through the response hook and usage webhook."""

import json
import tracemalloc

import pytest

import mitm_addon
import usage
from tests.repeated_bytes_helpers import join_repeated_bytes
from tests.x_flow_helpers import make_x_pipeline_flow


@pytest.fixture
def tweet_create_response(tmp_path, real_flow, usage_webhook_api, sync_usage_executor):
    def run(request_body: bytes, *, status: int = 201):
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            permission="tweet.write",
            rule="POST /2/tweets",
            response_status=status,
        )
        flow.request.method = "POST"
        flow.request.content = request_body
        assert flow.response is not None
        flow.response.content = b'{"data":{"id":"1"}}'

        with usage_webhook_api() as webhook:
            tracemalloc.start()
            try:
                mitm_addon.response(flow)
                peak_bytes = tracemalloc.get_traced_memory()[1]
            finally:
                tracemalloc.stop()
            usage.flush_usage_events(trigger="test")

        return webhook.usage_events(), peak_bytes

    return run


@pytest.mark.parametrize("quoted_brackets", [255, 256])
def test_same_size_utf8_tweet_bounds_response_allocation(tweet_create_response, quoted_brackets):
    body = (
        b'{"text":"'
        + b"[" * quoted_brackets
        + b"a" * (256 - quoted_brackets)
        + "中".encode() * 21756
        + b'"}'
    )
    assert len(body) == 65535

    events, peak_bytes = tweet_create_response(body)

    [event] = events
    assert event["category"] == "content.create"
    assert event["quantity"] == 1
    # Allow normal hook/JSON allocations, but not multi-MiB string-scan state.
    assert peak_bytes < 1024 * 1024


@pytest.mark.parametrize(
    "text",
    [
        pytest.param("[" * 256 + "a" * 65268, id="long-ascii"),
        pytest.param("[" * 256 + '"' * 16384, id="escaped-quotes"),
        pytest.param("[" * 256 + "\\" * 16384, id="escaped-backslashes"),
    ],
)
def test_long_tweet_strings_keep_bounded_billing(tweet_create_response, text):
    body = json.dumps({"text": text}, separators=(",", ":")).encode()

    events, peak_bytes = tweet_create_response(body)

    [event] = events
    assert event["category"] == "content.create"
    assert event["quantity"] == 1
    assert peak_bytes < 1024 * 1024


@pytest.mark.parametrize("nested_depth", [254, 255, 256])
@pytest.mark.parametrize("ensure_ascii", [True, False])
def test_quoted_delimiters_and_escapes_preserve_exact_depth(
    tweet_create_response, nested_depth, ensure_ascii
):
    text = "[]{}" * 256 + '中☃\\"[\\\\]"{' + "\\"
    prefix = json.dumps({"text": text}, ensure_ascii=ensure_ascii).encode()[:-1]
    opens = [b"[" if index % 2 == 0 else b'{"x":' for index in range(nested_depth)]
    closes = [b"]" if index % 2 == 0 else b"}" for index in reversed(range(nested_depth))]
    body = prefix + b',"nested":' + b"".join(opens) + b"0" + b"".join(closes) + b"}"

    events, _ = tweet_create_response(body)

    [event] = events
    # The root tweet object adds one level to the nested value.
    expected = "content.create" if nested_depth <= 255 else "content.create_with_url"
    assert event["category"] == expected
    assert event["quantity"] == 1


def test_many_shallow_containers_do_not_exhaust_depth(tweet_create_response):
    body = join_repeated_bytes(b",", b"{}", 512, prefix=b'{"text":"hello","items":[', suffix=b"]}")

    events, _ = tweet_create_response(body)

    [event] = events
    assert event["category"] == "content.create"
    assert event["quantity"] == 1


@pytest.mark.parametrize("pairs", [4096, 8192, 16384])
@pytest.mark.parametrize("status", [201, 400])
def test_unterminated_escaped_quotes_preserve_billing_gate(tweet_create_response, pairs, status):
    body = b'{"text":"' + b'\\"' * pairs + b"[" * 256

    events, peak_bytes = tweet_create_response(body, status=status)

    if status == 201:
        [event] = events
        assert event["category"] == "content.create_with_url"
        assert event["quantity"] == 1
    else:
        assert events == []
    assert peak_bytes < 1024 * 1024


@pytest.mark.parametrize("ending", [b"\\", b'\\"', b"\\\\"])
def test_unterminated_string_endings_stay_conservative(tweet_create_response, ending):
    events, _ = tweet_create_response(b'{"text":"' + b"[" * 256 + ending)

    [event] = events
    assert event["category"] == "content.create_with_url"
    assert event["quantity"] == 1


@pytest.mark.parametrize("body_size", [64 * 1024, 64 * 1024 + 1])
def test_tweet_create_retains_request_inspection_byte_limit(tweet_create_response, body_size):
    prefix = b'{"text":"' + b"[" * 256
    suffix = b'"}'
    body = prefix + b"a" * (body_size - len(prefix) - len(suffix)) + suffix

    events, _ = tweet_create_response(body)

    [event] = events
    expected = "content.create" if body_size == 64 * 1024 else "content.create_with_url"
    assert event["category"] == expected
    assert event["quantity"] == 1
