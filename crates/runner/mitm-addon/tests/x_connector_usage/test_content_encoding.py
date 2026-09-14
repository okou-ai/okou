"""Request header budgets through X billing's HTTP usage reporting boundary."""

import gzip

import pytest

from tests.content_encoding_cases import (
    BUDGET_CASES,
    encoding_budget_fields,
    encoding_inspections,
)

_TWEET_BODY = b'{"text":"hello world"}'


@pytest.mark.parametrize("encoding", ["identity", "gzip"])
@pytest.mark.parametrize(("budget", "size", "in_budget"), BUDGET_CASES)
def test_request_encoding_budget_preserves_conservative_billing(
    x_usage, real_flow, tmp_path, encoding, budget, size, *, in_budget
):
    body = gzip.compress(_TWEET_BODY) if encoding == "gzip" else _TWEET_BODY
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=body,
    )
    flow.request.method = "POST"
    fields = encoding_budget_fields(flow.request.headers.fields, encoding, budget, size)
    flow.request.headers.fields = fields

    event = x_usage.call_and_get_single_billing(flow)

    # Even in budget, folded duplicates are unsupported by request billing.
    inspectable = in_budget and budget != "aggregate"
    assert event["category"] == ("content.create" if inspectable else "content.create_with_url")
    assert event["quantity"] == 1
    assert bool(encoding_inspections(fields)) is in_budget
    assert flow.request.raw_content == body
    assert flow.request.headers.fields == fields


@pytest.mark.parametrize(
    ("values", "inspectable"),
    [
        pytest.param((), True, id="missing"),
        pytest.param((b"",), True, id="empty"),
        pytest.param((b" \tIdEnTiTy\t ",), True, id="mixed-case-whitespace"),
        pytest.param((b"\xc2\xa0identity\xc2\xa0",), True, id="unicode-whitespace"),
        pytest.param((b"identity", b""), False, id="blank-duplicate"),
        pytest.param((b"identity", b"identity"), False, id="duplicate-coding"),
        pytest.param((b",identity,",), False, id="empty-list-tokens"),
        pytest.param((b"identity, gzip",), False, id="multiple-codings"),
        pytest.param((b"\xff",), False, id="surrogateescape"),
    ],
)
def test_request_encoding_preserves_folded_value_semantics(
    x_usage, real_flow, tmp_path, values, *, inspectable
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets",
        status=201,
        permission="tweet.write",
        rule="POST /2/tweets",
        request_body=_TWEET_BODY,
    )
    flow.request.method = "POST"
    flow.request.headers.fields += tuple((b"Content-Encoding", value) for value in values)

    event = x_usage.call_and_get_single_billing(flow)

    assert event["category"] == ("content.create" if inspectable else "content.create_with_url")
    assert event["quantity"] == 1
