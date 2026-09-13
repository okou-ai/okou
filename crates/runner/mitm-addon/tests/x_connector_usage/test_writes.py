"""Direct X connector usage reporting tests."""

import gzip
import json
import zlib
from unittest.mock import patch

import pytest

import flow_metadata_keys as metadata_keys
import request_streaming
from body_limits import REQUEST_BODY_BILLING_INSPECTION_LIMIT, STREAM_BUFFER_LIMIT
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
)
from tests.x_flow_helpers import (
    json_body_that_exceeds_integer_digit_limit,
    json_body_that_exceeds_nesting_limit,
)
from usage.providers.connectors import x_billing

_PLAIN_TEXT_TWEET_BODY = b'{"text":"hello world"}'
_GZIP_WBITS = 16 + zlib.MAX_WBITS
_ZLIB_DEFLATE_WBITS = zlib.MAX_WBITS
_RAW_DEFLATE_WBITS = -zlib.MAX_WBITS
_ZLIB_INPUT_BOUND = 1024


def _gzip_members(*payloads: bytes) -> bytes:
    return b"".join(gzip.compress(payload, mtime=0) for payload in payloads)


def _raw_deflate_body(payload: bytes) -> bytes:
    compressor = zlib.compressobj(wbits=_RAW_DEFLATE_WBITS)
    return compressor.compress(payload) + compressor.flush()


def _tweet_body_with_size(size: int) -> bytes:
    framing = b'{"text":""}'
    return b'{"text":"' + b"x" * (size - len(framing)) + b'"}'


_GZIP_TWEET_BODY = _gzip_members(_PLAIN_TEXT_TWEET_BODY)
_ZLIB_DEFLATE_TWEET_BODY = zlib.compress(_PLAIN_TEXT_TWEET_BODY)
_RAW_DEFLATE_TWEET_BODY = _raw_deflate_body(_PLAIN_TEXT_TWEET_BODY)


def test_logs_write_operation_charges_one(x_usage, tmp_path, real_flow):
    """POST /2/tweets (no request body parsed) -> stay on the expensive
    with_url bucket, quantity=1."""
    body = json.dumps({"data": {"id": "99", "text": "new tweet"}}).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=body,
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_x_json_parse_error_on_write_does_not_emit_lost_visibility_log(
    x_usage, tmp_path, real_flow
):
    """Write operations bill by method and should not emit read visibility errors."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.metadata[metadata_keys.X_JSON_STATE] = {
        "body_parsed": False,
        "body_truncated": False,
        "parse_error": "incomplete json",
    }
    proxy_log = tmp_path / "proxy.jsonl"

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1
    assert jsonl_exists_after_flush(proxy_log)
    entries = read_jsonl_entries_after_flush(proxy_log)
    assert all(entry["level"] != "error" for entry in entries)
    assert all("unparseable" not in entry["message"].lower() for entry in entries)
    assert all("parse_error" not in entry for entry in entries)


def test_tweet_create_plain_text_downgrades_to_content_create(x_usage, tmp_path, real_flow):
    """POST /2/tweets with text only (no URL, no quote, no media)
    downgrades to the cheaper Content: Create bucket."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = json.dumps({"text": "hello world"}).encode()
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_depth_guard_ignores_delimiters_inside_strings(x_usage, tmp_path, real_flow):
    """Escaped strings with many delimiters remain valid plain-text bodies."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = json.dumps({"text": '[{"escaped \\" delimiter"}]' * 100}).encode()

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_lowercase_post_tweet_create_plain_text_downgrades(x_usage, tmp_path, real_flow):
    """Lowercase POST methods still refine plain-text tweet creation."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "post"
    flow.request.content = json.dumps({"text": "hello world"}).encode()
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


@pytest.mark.parametrize(
    ("request_encoding", "request_body"),
    [
        pytest.param(
            "gzip",
            _GZIP_TWEET_BODY,
            id="gzip",
        ),
        pytest.param(
            "deflate",
            _ZLIB_DEFLATE_TWEET_BODY,
            id="deflate-zlib",
        ),
        pytest.param(
            "deflate",
            _RAW_DEFLATE_TWEET_BODY,
            id="deflate-raw",
        ),
        pytest.param(
            "gzip",
            _gzip_members(_PLAIN_TEXT_TWEET_BODY[:10], _PLAIN_TEXT_TWEET_BODY[10:]),
            id="gzip-multiple-members",
        ),
    ],
)
def test_tweet_create_compressed_plain_text_downgrades_to_content_create(
    x_usage, tmp_path, real_flow, request_encoding, request_body
):
    """Small compressed tweet create bodies still refine to Content: Create."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=request_body,
        request_encoding=request_encoding,
    )
    flow.request.method = "POST"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_many_gzip_members_use_bounded_input(x_usage, tmp_path, real_flow):
    empty_member = _gzip_members(b"")
    request_body = _GZIP_TWEET_BODY + empty_member * (
        (REQUEST_BODY_BILLING_INSPECTION_LIMIT - len(_GZIP_TWEET_BODY)) // len(empty_member)
    )
    assert (
        REQUEST_BODY_BILLING_INSPECTION_LIMIT - len(empty_member)
        < len(request_body)
        <= REQUEST_BODY_BILLING_INSPECTION_LIMIT
    )

    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=request_body,
        request_encoding="gzip",
    )
    flow.request.method = "POST"

    real_factory = zlib.decompressobj
    stats = {"calls": 0, "max_input": 0, "max_unused_data": 0}

    class NonConcatenableUnusedData(bytes):
        def __add__(self, _other: object) -> bytes:
            raise TypeError("zlib unused data must not be concatenated")

    class TrackingDecompressionObj:
        def __init__(self, wrapped):
            self._wrapped = wrapped

        def decompress(self, chunk, *args, **kwargs):
            stats["calls"] += 1
            stats["max_input"] = max(stats["max_input"], len(chunk))
            return self._wrapped.decompress(chunk, *args, **kwargs)

        @property
        def eof(self):
            return self._wrapped.eof

        @property
        def unused_data(self):
            unused_data = NonConcatenableUnusedData(self._wrapped.unused_data)
            stats["max_unused_data"] = max(stats["max_unused_data"], len(unused_data))
            return unused_data

        @property
        def unconsumed_tail(self):
            return self._wrapped.unconsumed_tail

    def factory(*args, **kwargs):
        return TrackingDecompressionObj(real_factory(*args, **kwargs))

    with patch("zlib_decoding.zlib.decompressobj", factory):
        p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "content.create"
    assert p["quantity"] == 1
    assert stats["calls"] > 0
    assert stats["max_input"] <= _ZLIB_INPUT_BOUND
    assert stats["max_unused_data"] <= _ZLIB_INPUT_BOUND


@pytest.mark.parametrize(
    ("decoded_size", "trailing_data", "expected_category"),
    [
        pytest.param(
            REQUEST_BODY_BILLING_INSPECTION_LIMIT,
            _gzip_members(b""),
            "content.create",
            id="exact-limit-with-empty-member",
        ),
        pytest.param(
            REQUEST_BODY_BILLING_INSPECTION_LIMIT,
            b"trailing garbage",
            "content.create_with_url",
            id="exact-limit-with-trailing-garbage",
        ),
        pytest.param(
            REQUEST_BODY_BILLING_INSPECTION_LIMIT + 1,
            b"",
            "content.create_with_url",
            id="over-limit",
        ),
    ],
)
def test_tweet_create_multi_member_gzip_enforces_total_decoded_cap(
    x_usage, tmp_path, real_flow, decoded_size, trailing_data, expected_category
):
    request_payload = _tweet_body_with_size(decoded_size)
    split = len(request_payload) // 2
    request_body = _gzip_members(request_payload[:split], request_payload[split:]) + trailing_data
    assert len(request_payload) == decoded_size
    assert len(request_body) < REQUEST_BODY_BILLING_INSPECTION_LIMIT
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=request_body,
        request_encoding="gzip",
    )
    flow.request.method = "POST"

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == expected_category
    assert p["quantity"] == 1


@pytest.mark.parametrize(
    ("wbits", "decoded_size", "expected_category"),
    [
        pytest.param(
            _ZLIB_DEFLATE_WBITS,
            REQUEST_BODY_BILLING_INSPECTION_LIMIT,
            "content.create",
            id="zlib-exact-limit",
        ),
        pytest.param(
            _RAW_DEFLATE_WBITS,
            REQUEST_BODY_BILLING_INSPECTION_LIMIT,
            "content.create",
            id="raw-exact-limit",
        ),
        pytest.param(
            _ZLIB_DEFLATE_WBITS,
            REQUEST_BODY_BILLING_INSPECTION_LIMIT + 1,
            "content.create_with_url",
            id="zlib-over-limit",
        ),
        pytest.param(
            _RAW_DEFLATE_WBITS,
            REQUEST_BODY_BILLING_INSPECTION_LIMIT + 1,
            "content.create_with_url",
            id="raw-over-limit",
        ),
    ],
)
def test_tweet_create_deflate_enforces_decoded_cap(
    x_usage, tmp_path, real_flow, wbits, decoded_size, expected_category
):
    request_payload = _tweet_body_with_size(decoded_size)
    request_body = zlib.compress(request_payload, wbits=wbits)
    assert len(request_payload) == decoded_size
    assert len(request_body) < REQUEST_BODY_BILLING_INSPECTION_LIMIT

    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=request_body,
        request_encoding="deflate",
    )
    flow.request.method = "POST"

    real_factory = zlib.decompressobj
    max_lengths: list[int] = []

    class TrackingDecompressionObj:
        def __init__(self, wrapped):
            self._wrapped = wrapped

        def decompress(self, data, max_length=0):
            max_lengths.append(max_length)
            return self._wrapped.decompress(data, max_length=max_length)

        @property
        def eof(self):
            return self._wrapped.eof

        @property
        def unused_data(self):
            return self._wrapped.unused_data

        @property
        def unconsumed_tail(self):
            return self._wrapped.unconsumed_tail

    def factory(*args, **kwargs):
        return TrackingDecompressionObj(real_factory(*args, **kwargs))

    with patch("zlib_decoding.zlib.decompressobj", factory):
        p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == expected_category
    assert p["quantity"] == 1
    assert max_lengths
    assert set(max_lengths) == {REQUEST_BODY_BILLING_INSPECTION_LIMIT + 1}


@pytest.mark.parametrize(
    ("request_encoding", "request_body", "wbits"),
    [
        pytest.param(
            "gzip",
            _GZIP_TWEET_BODY[:-1],
            _GZIP_WBITS,
            id="gzip-truncated-first-member",
        ),
        pytest.param(
            "gzip",
            _GZIP_TWEET_BODY + _gzip_members(b"")[:-1],
            _GZIP_WBITS,
            id="gzip-truncated-later-member",
        ),
        pytest.param(
            "gzip",
            _GZIP_TWEET_BODY + b"trailing garbage",
            _GZIP_WBITS,
            id="gzip-trailing-garbage",
        ),
        pytest.param(
            "deflate",
            _ZLIB_DEFLATE_TWEET_BODY[:-1],
            _ZLIB_DEFLATE_WBITS,
            id="deflate-zlib-truncated",
        ),
        pytest.param(
            "deflate",
            _ZLIB_DEFLATE_TWEET_BODY + b"trailing garbage",
            _ZLIB_DEFLATE_WBITS,
            id="deflate-zlib-trailing-garbage",
        ),
        pytest.param(
            "deflate",
            _ZLIB_DEFLATE_TWEET_BODY + _ZLIB_DEFLATE_TWEET_BODY,
            _ZLIB_DEFLATE_WBITS,
            id="deflate-zlib-second-stream",
        ),
        pytest.param(
            "deflate",
            _RAW_DEFLATE_TWEET_BODY[:-1],
            _RAW_DEFLATE_WBITS,
            id="deflate-raw-truncated",
        ),
        pytest.param(
            "deflate",
            _RAW_DEFLATE_TWEET_BODY + b"trailing garbage",
            _RAW_DEFLATE_WBITS,
            id="deflate-raw-trailing-garbage",
        ),
        pytest.param(
            "deflate",
            _RAW_DEFLATE_TWEET_BODY + _RAW_DEFLATE_TWEET_BODY,
            _RAW_DEFLATE_WBITS,
            id="deflate-raw-second-stream",
        ),
    ],
)
def test_tweet_create_incomplete_or_trailing_compressed_body_stays_conservative(
    x_usage, tmp_path, real_flow, request_encoding, request_body, wbits
):
    prefix_decoder = zlib.decompressobj(wbits)
    assert prefix_decoder.decompress(request_body) == _PLAIN_TEXT_TWEET_BODY
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=request_body,
        request_encoding=request_encoding,
    )
    flow.request.method = "POST"

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_tweet_create_gzip_decoded_body_over_cap_stays_conservative(x_usage, tmp_path, real_flow):
    """A gzip body that expands beyond the billing inspection cap is not refined."""
    long_text = "x" * REQUEST_BODY_BILLING_INSPECTION_LIMIT
    request_body = gzip.compress(json.dumps({"text": long_text}).encode())
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=request_body,
        request_encoding="gzip",
    )
    flow.request.method = "POST"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_tweet_create_raw_body_over_cap_stays_conservative(x_usage, tmp_path, real_flow):
    """An oversized identity request body is not refined."""
    request_body = b"{" + b'"text":"' + b"x" * REQUEST_BODY_BILLING_INSPECTION_LIMIT + b'"}'
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=request_body,
    )
    flow.request.method = "POST"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_tweet_create_refines_from_complete_stream_capture(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.raw_content = None
    request_streaming.configure_request_stream(flow)
    stream = flow.request.stream
    assert callable(stream)
    assert stream(b'{"text":"hello world"}') == b'{"text":"hello world"}'
    flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] = True

    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_refines_from_complete_stream_capture_when_raw_content_is_empty(
    x_usage, tmp_path, real_flow
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.raw_content = b""
    request_streaming.configure_request_stream(flow)
    stream = flow.request.stream
    assert callable(stream)
    assert stream(b'{"text":"hello world"}') == b'{"text":"hello world"}'
    flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] = True

    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_complete_stream_capture_overrides_stale_raw_content(
    x_usage, tmp_path, real_flow
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=b'{"text":"https://example.com"}',
    )
    flow.request.method = "POST"
    request_streaming.configure_request_stream(flow)
    stream = flow.request.stream
    assert callable(stream)
    assert stream(b'{"text":"hello world"}') == b'{"text":"hello world"}'
    flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] = True

    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_truncated_stream_capture_ignores_stale_raw_content(
    x_usage, tmp_path, real_flow
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=b'{"text":"hello world"}',
    )
    flow.request.method = "POST"
    request_streaming.configure_request_stream(flow)
    stream = flow.request.stream
    assert callable(stream)
    request_body = b"{" + b'"text":"' + b"x" * STREAM_BUFFER_LIMIT + b'"}'
    assert stream(request_body) == request_body
    flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] = True

    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_tweet_create_incomplete_stream_capture_stays_conservative(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.raw_content = None
    request_streaming.configure_request_stream(flow)
    stream = flow.request.stream
    assert callable(stream)
    assert stream(b'{"text":"hello world"}') == b'{"text":"hello world"}'

    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_tweet_create_truncated_stream_capture_stays_conservative(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.raw_content = None
    request_streaming.configure_request_stream(flow)
    stream = flow.request.stream
    assert callable(stream)
    request_body = b"{" + b'"text":"' + b"x" * STREAM_BUFFER_LIMIT + b'"}'
    assert stream(request_body) == request_body
    flow.metadata[metadata_keys.REQUEST_STREAM_COMPLETE] = True

    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


@pytest.mark.parametrize("request_encoding", ["gzip", "deflate", "br", "zstd", "x-okou-test"])
def test_tweet_create_invalid_or_unsupported_encoding_stays_conservative(
    x_usage, tmp_path, real_flow, request_encoding
):
    """Invalid compressed or unsupported encoded bodies are not refined."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=b'{"text":"hello world"}',
        request_encoding=request_encoding,
    )
    flow.request.method = "POST"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_non_refinement_flow_does_not_decode_request_body(x_usage, tmp_path, real_flow):
    """Only body-refinement candidates should inspect request content."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/123/retweeted_by?max_results=10",
        body=json.dumps({"data": [{"id": "u1"}]}).encode(),
        permission="tweet.read",
        rule="GET /2/tweets/{id}/retweeted_by",
        request_body=b"not gzip request content",
        request_encoding="gzip",
    )
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        "https://api.x.com/2/tweets/123/retweeted_by?max_results=10"
    )

    # The billing payload cannot prove this negative side effect: the decoder
    # fails closed, so a regression that decodes non-refinement request bodies
    # could still emit `user.read`. Keep this addon-owned call-site spy to guard
    # the resource boundary from #15705; #17256 moved the spy off mitmproxy
    # internals.
    with patch(
        "usage.providers.connectors.x.billing_body.decode_request_body_for_billing"
    ) as decode_request_body:
        p = x_usage.call_and_get_single_billing(flow)

    decode_request_body.assert_not_called()
    assert p["category"] == "user.read"
    assert p["quantity"] == 1


@pytest.mark.parametrize(
    "text",
    [
        "check https://example.com",
        "check HTTPS://example.com",
        "check HtTp://www.ExaMPLE.COM/index.html",
        "Visit okou.ai for details",
        "Visit okou.ai.",
        "(okou.ai)",
        "Visit go.dev",
        "Read example.museum",
        "Visit example.web",
        "Label:example.com",
        "Param url=example.com",
        "Pipe|example.com",
        "Visit EXAMPLE.COM",
        "Visit 123.com",
        "Visit blog.example.co.uk",
        "Visit example.com.notatld",
        "Visit okou.ai.notatld",
        "Visit foo.co.uk.notatld",
        "Visit example.com.notatld@user",
        "Visit example.com.notatld+tag",
        "Visit example.com.notatld-tag",
        "Visit example.com.123",
        "Visit example.com.例",
        "Visit example.com例",
        "Visit mañana.com例",
        "Visit foo.みんな例",
        "Open example.com/path/to/resource?search=foo&lang=en",
        "Open example.com:443/path",
        "Open xn--r8jz45g.xn--q9jyb4c",
        "Uppercase IDN XN--R8JZ45G.XN--Q9JYB4C",
        "IDN 例え.みんな",
        "Accent mañana.com",
        "Sharp S faß.de",
        "Fullwidth compatibility \uff26\uff2f\uff2f.com",
        "Fullwidth terminal example.\uff23\uff2f\uff2d",
        "Repeated fullwidth compatibility \uff26\uff2f\uff2f.\uff26\uff2f\uff2f",
    ],
)
def test_tweet_create_with_url_stays_on_with_url_bucket(x_usage, tmp_path, real_flow, text):
    """POST /2/tweets whose text contains a URL stays on the
    Content: Create (with URL) bucket."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = json.dumps({"text": text}).encode()
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


@pytest.mark.parametrize(
    "text",
    [
        "Email support@example.com",
        "Mention @twitter.com",
        "Unicode mention @éexample.com",
        "Tag #twitter.com",
        "Unicode tag #éexample.com",
        "Cash $twitter.com",
        "Unicode cash $éexample.com",
        "Path /twitter.com",
        "Unicode path /éexample.com",
        "Archive long.test.tar.bz2",
        "Word abcHTTPS://example.com",
        "Fullwidth mention \uff20twitter.com",
        "Unicode fullwidth mention \uff20éexample.com",
        "Fullwidth tag \uff03twitter.com",
        "Unicode fullwidth tag \uff03éexample.com",
        "Unicode dot boundary .éexample.com",
        "Plus suffix example.com+tag",
        "Fullwidth terminal plus suffix example.\uff23\uff2f\uff2d+tag",
        "At suffix example.com@user",
        "Hyphen suffix example.com-tag",
        "ASCII suffix example.comuser",
        "Numeric suffix example.com1",
        "Unknown example.notatld",
        "TLD-only prefix com.notatld",
        "Fullwidth unknown \uff26\uff2f\uff2f.notatld",
        "Underscore foo_bar.example.com",
        "Unicode underscore _éexample.com",
        "Leading hyphen -bad.com",
        "Trailing hyphen bad-.com",
        "Invalid prefix bad-.com.notatld",
        "Invalid A-label xn--a.com",
        "Invalid uppercase A-label XN--A.com",
    ],
)
def test_tweet_create_url_like_non_links_downgrade_to_content_create(
    x_usage, tmp_path, real_flow, text
):
    """twitter-text-style boundary guards avoid obvious non-link
    domains while still allowing plain text to downgrade."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = json.dumps({"text": text}).encode()
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_long_dotted_ascii_candidate_skips_idna_normalization(
    x_usage, tmp_path, real_flow
):
    """Long ordinary ASCII candidates avoid generic IDNA work."""
    text = ("a." * 12_500)[:25_000]
    request_body = json.dumps({"text": text}).encode()
    assert len(text) == 25_000
    assert len(request_body) < REQUEST_BODY_BILLING_INSPECTION_LIMIT
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = request_body

    with patch.object(
        x_billing,
        "normalize_idna_label",
        wraps=x_billing.normalize_idna_label,
    ) as normalize_idna_label:
        p = x_usage.call_and_get_single_billing(flow)

    normalize_idna_label.assert_not_called()
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_long_unicode_label_does_not_restart_candidate_search(
    x_usage, tmp_path, real_flow
):
    """Failed Unicode candidates do not restart inside the same label."""
    interior_candidate = "éexample.com"
    assert x_billing._BARE_DOMAIN_CANDIDATE_RE.match(interior_candidate, 1) is None

    text = "é" * 16_000 + "."
    request_body = json.dumps(
        {"text": text},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()
    assert len(request_body) < REQUEST_BODY_BILLING_INSPECTION_LIMIT
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = request_body

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_repeated_unicode_labels_reuse_classification(x_usage, tmp_path, real_flow):
    """Repeated Unicode labels reuse IDNA work and remain non-link."""
    text = "a." + (("é" * 20 + ".") * 1_189) + "notatld"
    request_body = json.dumps(
        {"text": text},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()
    assert len(text) == 24_978
    assert len(request_body) == 48_769
    assert len(request_body) < REQUEST_BODY_BILLING_INSPECTION_LIMIT
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = request_body

    with (
        patch.object(
            x_billing,
            "normalize_idna_label",
            wraps=x_billing.normalize_idna_label,
        ) as normalize_idna_label,
        patch.object(
            x_billing,
            "_label_has_tld_prefix_before_unicode",
            wraps=x_billing._label_has_tld_prefix_before_unicode,
        ) as label_has_tld_prefix_before_unicode,
    ):
        p = x_usage.call_and_get_single_billing(flow)

    assert normalize_idna_label.call_count == 3
    assert label_has_tld_prefix_before_unicode.call_count == 2
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_distinct_unicode_labels_stop_at_body_work_limit(x_usage, tmp_path, real_flow):
    """Distinct labels across candidates stop at one body-wide work limit."""
    unicode_labels = [chr(0x4E00 + index) for index in range(10_000)]
    labels_per_candidate = 128
    text = " ".join(
        "a." + ".".join(unicode_labels[start : start + labels_per_candidate]) + ".notatld"
        for start in range(0, len(unicode_labels), labels_per_candidate)
    )
    request_body = json.dumps(
        {"text": text},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()
    assert len(request_body) < REQUEST_BODY_BILLING_INSPECTION_LIMIT
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = request_body

    with (
        patch.object(
            x_billing,
            "normalize_idna_label",
            wraps=x_billing.normalize_idna_label,
        ) as normalize_idna_label,
        patch.object(
            x_billing,
            "_label_has_tld_prefix_before_unicode",
            wraps=x_billing._label_has_tld_prefix_before_unicode,
        ) as label_has_tld_prefix_before_unicode,
    ):
        p = x_usage.call_and_get_single_billing(flow)

    assert normalize_idna_label.call_count == 256
    assert label_has_tld_prefix_before_unicode.call_count == 255
    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_tweet_create_rendered_link_signals_stay_on_with_url_bucket(x_usage, tmp_path, real_flow):
    """Quote tweets, attached media, cards, and DM deep links render links;
    we stay on the expensive bucket even when the text has no URL."""
    for req_body in [
        # quote tweet
        json.dumps({"text": "nice", "quote_tweet_id": "abc"}).encode(),
        # attached media
        json.dumps({"text": "pic", "media": {"media_ids": ["42"]}}).encode(),
        # attached card
        json.dumps({"text": "card", "card_uri": "card://123"}).encode(),
        # direct-message deep link
        json.dumps(
            {
                "text": "DM me for details",
                "direct_message_deep_link": "https://x.com/messages/compose?recipient_id=123",
            }
        ).encode(),
    ]:
        flow = x_usage.make_flow(
            real_flow,
            tmp_path,
            path="/2/tweets",
            body=json.dumps({"data": {"id": "1"}}).encode(),
            status=201,
            permission="tweet.write",
            rule="POST /2/tweets",
        )
        flow.request.method = "POST"
        flow.request.content = req_body
        p = x_usage.call_and_get_single_billing(flow)
        assert p["category"] == "content.create_with_url"
        assert p["quantity"] == 1


@pytest.mark.parametrize("direct_message_deep_link", ["", "   ", None, 123, {"url": "x"}])
def test_tweet_create_invalid_direct_message_deep_link_downgrades_to_content_create(
    x_usage, tmp_path, real_flow, direct_message_deep_link
):
    """Invalid DM deep-link values do not block the plain-text downgrade."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = json.dumps(
        {"text": "DM me for details", "direct_message_deep_link": direct_message_deep_link}
    ).encode()
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create"
    assert p["quantity"] == 1


def test_tweet_create_unparseable_body_stays_conservative(x_usage, tmp_path, real_flow):
    """A malformed request body keeps billing on the max bucket so
    we never under-charge on parse failure."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = b"not valid json at all"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.create_with_url"


@pytest.mark.parametrize(
    "request_body",
    [
        pytest.param(b"[]", id="array"),
        pytest.param(b"null", id="null"),
        pytest.param(b"123", id="number"),
        pytest.param(b'"text"', id="string"),
    ],
)
def test_tweet_create_non_object_json_body_stays_conservative(
    x_usage, tmp_path, real_flow, request_body
):
    """Valid non-object JSON cannot refine tweet-create billing."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = request_body

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


@pytest.mark.parametrize(
    "request_body",
    [
        pytest.param(json_body_that_exceeds_nesting_limit(), id="excessive-nesting"),
        pytest.param(json_body_that_exceeds_integer_digit_limit(), id="integer-digit-limit"),
    ],
)
def test_tweet_create_uninspectable_json_stays_conservative(
    x_usage, tmp_path, real_flow, request_body
):
    """Uninspectable JSON must not interrupt tweet-create billing."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        body=json.dumps({"data": {"id": "1"}}).encode(),
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
    )
    flow.request.method = "POST"
    flow.request.content = request_body

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "content.create_with_url"
    assert p["quantity"] == 1


def test_delete_method_charges_one(x_usage, tmp_path, real_flow):
    """DELETE /2/tweets/{id} routes to Content: Manage, not the
    tweet.write scope default.  Writes always charge quantity=1
    regardless of response shape."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/123",
        body=b"",
        permission="tweet.write",
        rule="DELETE /2/tweets/{id}",
    )
    flow.request.method = "DELETE"
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "content.manage"
    assert p["quantity"] == 1
