"""Direct X connector usage reporting tests."""

import json

import pytest

import flow_metadata_keys as metadata_keys
import usage
from tests.jsonl_log_helpers import (
    jsonl_exists_after_flush,
    read_jsonl_entries_after_flush,
    read_jsonl_text_after_flush,
)
from tests.stream_buffer_helpers import set_response_stream_buffer
from tests.x_connector_usage.helpers import assert_lost_visibility_error


def test_x_stream_mixed_rows_bills_valid_counts_and_logs_risk(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/stream",
        body=b"",
        rule="GET /2/tweets/search/stream",
    )
    proxy_log = tmp_path / "proxy.jsonl"
    flow.metadata[metadata_keys.X_NDJSON_STATE] = {
        "data_count": 50,
        "includes": {"users": 47, "tweets": 12},
        "lines_parsed": 50,
        "lines_failed": 1,
    }
    payloads = x_usage.call_and_get_billing(flow)
    by_cat = {p["category"]: p["quantity"] for p in payloads}
    assert len(payloads) == len(by_cat)
    assert by_cat == {
        "posts.read": 62,  # 50 primary + 12 from includes.tweets
        "user.read": 47,
    }

    [entry] = [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log)
        if entry.get("reason") == "unparseable_ndjson_rows"
    ]
    assert entry["type"] == "usage_underbilling"
    assert entry["reason"] == "unparseable_ndjson_rows"
    assert entry["underbilling_class"] == "risk"
    assert entry["component"] == "mitm_addon"
    assert entry["run_id"] == "run-abc-123"
    assert entry["firewall_name"] == "x"
    assert entry["permission"] == "tweet.read"
    assert entry["method"] == "GET"
    assert entry["url"] == "https://api.x.com/2/tweets/search/stream"
    assert entry["ndjson_lines_failed"] == 1
    assert entry["ndjson_lines_parsed"] == 50
    assert entry["response_data_count"] == 50


def test_x_stream_all_failed_rows_logs_risk_without_billing(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/stream",
        body=b"",
        rule="GET /2/tweets/search/stream",
    )
    proxy_log = tmp_path / "proxy.jsonl"
    flow.metadata[metadata_keys.X_NDJSON_STATE] = {
        "data_count": 0,
        "includes": {},
        "lines_parsed": 0,
        "lines_failed": 2,
    }

    assert x_usage.call_and_get_billing(flow) == []

    [entry] = [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log)
        if entry.get("reason") == "unparseable_ndjson_rows"
    ]
    assert entry["type"] == "usage_underbilling"
    assert entry["reason"] == "unparseable_ndjson_rows"
    assert entry["underbilling_class"] == "risk"
    assert entry["ndjson_lines_failed"] == 2
    assert entry["ndjson_lines_parsed"] == 0
    assert entry["response_data_count"] == 0


def test_x_stream_empty_emits_no_billing(x_usage, tmp_path, real_flow):
    """A parsed NDJSON stream with zero resources and no row failures
    emits no usage event or lost-visibility log."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/stream",
        body=b"",
        rule="GET /2/tweets/search/stream",
    )
    proxy_log = tmp_path / "proxy.jsonl"
    flow.metadata[metadata_keys.X_NDJSON_STATE] = {
        "data_count": 0,
        "includes": {},
        "lines_parsed": 0,
        "lines_failed": 0,
    }
    payloads = x_usage.call_and_get_billing(flow)
    assert payloads == []
    assert not jsonl_exists_after_flush(proxy_log)


def test_legacy_x_json_fallback_extracts_selective_field_counts(x_usage, tmp_path, real_flow):
    """Buffered fallback should share X JSON field semantics with the selective parser."""
    body = json.dumps(
        {
            "data": [{"id": "1"}, {"id": "2"}],
            "errors": [{"title": "partial failure"}],
            "includes": {
                "users": [{"id": "u1"}],
                "media": [],
                "topics": "ignored",
            },
            "meta": {"result_count": 2, "total_tweet_count": 3},
        }
    ).encode()
    flow = x_usage.make_flow(real_flow, tmp_path, body=body)

    payloads = x_usage.call_and_get_billing(flow)

    by_cat = {p["category"]: p["quantity"] for p in payloads}
    assert len(payloads) == len(by_cat)
    assert by_cat == {"posts.read": 2, "user.read": 1}


def test_legacy_x_json_fallback_ignores_boolean_result_count(x_usage, tmp_path, real_flow):
    body = json.dumps({"meta": {"result_count": True}}).encode()
    flow = x_usage.make_flow(real_flow, tmp_path, body=body)
    proxy_log = tmp_path / "proxy.jsonl"

    payloads = x_usage.call_and_get_billing(flow)

    assert payloads == []
    if jsonl_exists_after_flush(proxy_log):
        entries = read_jsonl_entries_after_flush(proxy_log)
        assert all(entry["level"] != "error" for entry in entries)
        assert all("unparseable" not in entry["message"].lower() for entry in entries)


def test_truncated_buffer_with_no_hints_skips_billing(x_usage, tmp_path, real_flow):
    """A valid JSON prefix cannot supply counts when response bytes were omitted."""
    flow = x_usage.make_flow(real_flow, tmp_path)
    set_response_stream_buffer(flow, b'{"data":[{"id":"prefix-only"}]}', truncated=True)
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []

    entry = read_jsonl_entries_after_flush(proxy_log)[0]
    assert entry["level"] == "error"
    assert "unparseable" in entry["message"].lower()
    assert entry["body_truncated"] is True
    assert entry["parse_error"] == "incomplete compressed body"


def test_invalid_json_with_no_hints_skips_billing(x_usage, tmp_path, real_flow):
    """Malformed body + no URL hints: skip emission (see above)."""
    flow = x_usage.make_flow(real_flow, tmp_path, body=b"not json")
    assert x_usage.call_and_get_billing(flow) == []


def test_non_dict_json_with_no_hints_skips_billing(x_usage, tmp_path, real_flow):
    """A valid top-level non-object JSON response remains unparsed; without reliable
    request hints, billing is skipped and a lost-visibility audit error is recorded."""
    flow = x_usage.make_flow(real_flow, tmp_path, body=b"[1,2,3]")
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []
    assert_lost_visibility_error(proxy_log)


def test_array_element_fields_do_not_drive_x_billing(x_usage, tmp_path, real_flow):
    """Fields under array elements must not masquerade as top-level X metadata."""
    body = json.dumps(
        {
            "data": [],
            "includes": [{"users": [{"id": "u1"}]}],
            "meta": [{"result_count": 5}],
        }
    ).encode()
    flow = x_usage.make_flow(real_flow, tmp_path, body=body)
    assert x_usage.call_and_get_billing(flow) == []


def test_unparseable_no_hints_writes_error_to_proxy_log(x_usage, tmp_path, real_flow):
    """Operators must be able to audit the lost-visibility case:
    the proxy log receives a structured error entry."""
    sensitive_query = "vm0-sensitive-unparseable"
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path=f"/2/tweets/search/recent?query={sensitive_query}",
        body=b"not json",
        rule="GET /2/tweets/search/recent",
    )
    flow.metadata[metadata_keys.ORIGINAL_URL] = (
        f"https://api.x.com:8443/2/tweets/search/recent?query={sensitive_query}"
    )
    proxy_log = tmp_path / "proxy.jsonl"
    assert x_usage.call_and_get_billing(flow) == []
    assert jsonl_exists_after_flush(proxy_log)
    content = read_jsonl_text_after_flush(proxy_log)
    assert sensitive_query not in content
    entries = [json.loads(line) for line in content.splitlines()]
    matching_entries = [
        entry
        for entry in entries
        if entry.get("level") == "error" and "unparseable" in entry.get("message", "").lower()
    ]
    assert len(matching_entries) == 1
    entry = matching_entries[0]
    assert entry["level"] == "error"
    assert "unparseable" in entry["message"].lower()
    assert entry["permission"] == "tweet.read"
    assert entry["url"] == "https://api.x.com:8443/2/tweets/search/recent"
    assert "parse_error" not in entry


def test_unparseable_no_hints_without_proxy_log_path_emits_process_event(
    x_usage, tmp_path, real_flow, mitm_ctx
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        body=b"not json",
        rule="GET /2/tweets/search/recent",
    )
    flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = ""

    with mitm_ctx(api_url="https://api.okou.ai") as log:
        usage.report_connector_usage(flow, "run-abc-123")

    fields = [call.args[1] for call in log.error.call_args_list]
    assert any(
        field["type"] == "usage_underbilling"
        and field["reason"] == "unparseable_usage_response"
        and field["underbilling_class"] == "confirmed"
        and field["component"] == "mitm_addon"
        for field in fields
    )


def test_unparseable_x_json_state_logs_parse_error(x_usage, tmp_path, real_flow):
    """Incremental parser failures should surface the parse reason for audit."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        rule="GET /2/tweets/search/recent",
    )
    flow.metadata[metadata_keys.X_JSON_STATE] = {
        "body_parsed": False,
        "body_truncated": False,
        "parse_error": "incomplete json",
    }
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []

    entry = read_jsonl_entries_after_flush(proxy_log)[0]
    assert entry["level"] == "error"
    assert "unparseable" in entry["message"].lower()
    assert entry["parse_error"] == "incomplete json"


@pytest.mark.parametrize(
    "parse_error",
    ["", "   ", None, b"incomplete json", {"reason": "incomplete json"}],
)
def test_unparseable_x_json_state_omits_invalid_parse_error(
    x_usage, tmp_path, real_flow, parse_error
):
    """Only non-empty string parse errors should be written to the audit log."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        rule="GET /2/tweets/search/recent",
    )
    flow.metadata[metadata_keys.X_JSON_STATE] = {
        "body_parsed": False,
        "body_truncated": False,
        "parse_error": parse_error,
    }
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []

    entry = read_jsonl_entries_after_flush(proxy_log)[0]
    assert entry["level"] == "error"
    assert "unparseable" in entry["message"].lower()
    assert "parse_error" not in entry


def test_billable_counts_fallback_only_when_no_hints(x_usage, tmp_path, real_flow):
    """body unparseable but ?ids= present -> uses ids_count, no fallback."""
    flow = x_usage.make_flow(real_flow, tmp_path, query="ids=1,2,3", body=b"not json")
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 3


@pytest.mark.parametrize(
    ("path", "query", "rule", "expected_quantity"),
    [
        pytest.param(
            "/2/tweets",
            "%69ds=1,2",
            "GET /2/tweets",
            2,
            id="encoded-key",
        ),
        pytest.param(
            "/2/tweets",
            "ids=1%2C2",
            "GET /2/tweets",
            2,
            id="encoded-comma",
        ),
        pytest.param(
            "/2/tweets/search/recent",
            "query=test&max_results=%35%30",
            "GET /2/tweets/search/recent",
            50,
            id="encoded-decimal",
        ),
    ],
)
def test_unparseable_response_decodes_percent_encoded_fallback_hints(
    x_usage,
    tmp_path,
    real_flow,
    path,
    query,
    rule,
    expected_quantity,
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path=path,
        query=query,
        body=b"not json",
        rule=rule,
    )

    event = x_usage.call_and_get_single_billing(flow)

    assert event["category"] == "posts.read"
    assert event["quantity"] == expected_quantity


def test_parsed_response_ignores_oversized_fallback_query(x_usage, tmp_path, real_flow):
    """Parsed responses bill from the body and do not need query fallback hints."""
    body = json.dumps({"data": [{"id": "1"}, {"id": "2"}]}).encode()
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        query=f"ignored={'x' * 200_000}",
        body=body,
    )

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "posts.read"
    assert p["quantity"] == 2


def test_unparseable_response_scans_relevant_fallback_query_hints(x_usage, tmp_path, real_flow):
    """Fallback query scanning ignores unrelated params without materializing them."""
    irrelevant_params = "&".join(f"noise{i}=value{i}" for i in range(500))
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        query=f"{irrelevant_params}&ids=1,2,3",
        body=b"not json",
    )

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "posts.read"
    assert p["quantity"] == 3


def test_unparseable_response_accumulates_repeated_id_like_fallback_hints(
    x_usage, tmp_path, real_flow
):
    """Repeated allowed selector keys are accumulated on the matching path."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        query="ids=1,2&ids=3",
        body=b"not json",
    )

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "posts.read"
    assert p["quantity"] == 3


@pytest.mark.parametrize(
    ("path", "query", "permission", "rule", "expected_category", "expected_quantity"),
    [
        (
            "/2/tweets",
            "ids=1,2&ids=,,",
            "tweet.read",
            "GET /2/tweets",
            "posts.read",
            2,
        ),
        (
            "/2/tweets",
            "ids=,,&ids=1,2",
            "tweet.read",
            "GET /2/tweets",
            "posts.read",
            2,
        ),
        (
            "/2/users/by",
            "usernames=a,b&usernames=,,",
            "users.read",
            "GET /2/users/by",
            "user.read",
            2,
        ),
        (
            "/2/users/by",
            "usernames=,,&usernames=a,b",
            "users.read",
            "GET /2/users/by",
            "user.read",
            2,
        ),
        (
            "/2/tweets",
            f"ids={','.join(str(i) for i in range(1, 101))}&ids=,,",
            "tweet.read",
            "GET /2/tweets",
            "posts.read",
            100,
        ),
    ],
)
def test_unparseable_response_preserves_repeated_selector_counts_across_empty_values(
    x_usage,
    tmp_path,
    real_flow,
    path,
    query,
    permission,
    rule,
    expected_category,
    expected_quantity,
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path=path,
        query=query,
        body=b"not json",
        permission=permission,
        rule=rule,
    )

    event = x_usage.call_and_get_single_billing(flow)

    assert event["category"] == expected_category
    assert event["quantity"] == expected_quantity


def test_unparseable_response_does_not_treat_semicolon_as_query_separator(
    x_usage, tmp_path, real_flow
):
    """Semicolons stay inside values, matching Python 3.12 parse_qs behavior."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        query="ids=1;max_results=50",
        body=b"not json",
    )

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == "posts.read"
    assert p["quantity"] == 1


def test_oversized_fallback_query_suppresses_request_hints(x_usage, tmp_path, real_flow):
    """Oversized fallback queries are treated as having no reliable count hints."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        query=f"ids=1,2,3&ignored={'x' * 200_000}",
        body=b"not json",
    )
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []

    assert jsonl_exists_after_flush(proxy_log)
    content = read_jsonl_text_after_flush(proxy_log)
    assert "unparseable" in content.lower()
    assert '"level":"error"' in content or '"level": "error"' in content


def test_unencodable_fallback_query_suppresses_request_hints(x_usage, tmp_path, real_flow):
    """Malformed Unicode in fallback queries should fail closed instead of crashing."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        query="noise=" + "\ud800" + "&ids=1",
        body=b"not json",
    )
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []
    assert_lost_visibility_error(proxy_log)


@pytest.mark.parametrize(
    ("path", "query_template", "permission", "rule", "expected_quantity"),
    [
        (
            "/2/tweets/search/recent",
            "ids={large}&query=hello&max_results=50",
            "tweet.read",
            "GET /2/tweets/search/recent",
            50,
        ),
        (
            "/2/tweets",
            "max_results={large}&ids=1,2",
            "tweet.read",
            "GET /2/tweets",
            2,
        ),
        (
            "/2/tweets/search/recent",
            "query=hello&max_results=50&max_results={large}",
            "tweet.read",
            "GET /2/tweets/search/recent",
            50,
        ),
    ],
)
def test_unparseable_response_ignores_oversized_irrelevant_fallback_hint_values(
    x_usage,
    tmp_path,
    real_flow,
    path,
    query_template,
    permission,
    rule,
    expected_quantity,
):
    """Oversized values only fail the hint that would actually be trusted."""
    query = query_template.format(large="x" * 20_000)
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path=path,
        query=query,
        body=b"not json",
        permission=permission,
        rule=rule,
    )

    p = x_usage.call_and_get_single_billing(flow)

    assert p["quantity"] == expected_quantity


@pytest.mark.parametrize(
    ("path", "query", "permission", "rule", "expected_category", "expected_quantity"),
    [
        ("/2/tweets", "ids=1,2,3", "tweet.read", "GET /2/tweets", "posts.read", 3),
        (
            "/2/tweets/search/recent",
            "query=hello&max_results=50",
            "tweet.read",
            "GET /2/tweets/search/recent",
            "posts.read",
            50,
        ),
        (
            "/2/users/search",
            "query=alice&max_results=1000",
            "users.read",
            "GET /2/users/search",
            "user.read",
            1000,
        ),
        (
            "/2/news/search",
            "query=vm0&max_results=100",
            "users.read",
            "GET /2/news/search",
            "user.read",
            100,
        ),
        ("/2/users", "ids=1,2", "users.read", "GET /2/users", "user.read", 2),
        ("/2/users/by", "usernames=a,b", "users.read", "GET /2/users/by", "user.read", 2),
        (
            "/2/users/123/followers",
            "max_results=1000",
            "follows.read",
            "GET /2/users/{id}/followers",
            "following_followers.read",
            1000,
        ),
        (
            "/2/users/123/following",
            "max_results=1000",
            "follows.read",
            "GET /2/users/{id}/following",
            "following_followers.read",
            1000,
        ),
        (
            "/2/spaces",
            "ids=1,2",
            "space.read",
            "GET /2/spaces",
            "space.read",
            2,
        ),
        (
            "/2/tweets/analytics",
            "ids=1,2",
            "tweet.read",
            "GET /2/tweets/analytics",
            "analytics.read",
            2,
        ),
        (
            "/2/tweets/123/quote_tweets",
            "max_results=100",
            "tweet.read",
            "GET /2/tweets/{id}/quote_tweets",
            "posts.read",
            100,
        ),
        (
            "/2/tweets/123/retweeted_by",
            "max_results=100",
            "tweet.read",
            "GET /2/tweets/{id}/retweeted_by",
            "user.read",
            100,
        ),
        (
            "/2/users/123/tweets",
            "max_results=100",
            "users.read",
            "GET /2/users/{id}/tweets",
            "posts.read",
            100,
        ),
        (
            "/2/users/123/liked_tweets",
            "max_results=5",
            "like.read",
            "GET /2/users/{id}/liked_tweets",
            "posts.read",
            5,
        ),
        (
            "/2/lists/123/members",
            "max_results=100",
            "list.read",
            "GET /2/lists/{id}/members",
            "list.read",
            100,
        ),
        (
            "/2/dm_events",
            "max_results=100",
            "dm.read",
            "GET /2/dm_events",
            "dm_event.read",
            100,
        ),
    ],
)
def test_x_json_parse_error_with_request_hints_uses_fallback_without_error_log(
    x_usage,
    tmp_path,
    real_flow,
    path,
    query,
    permission,
    rule,
    expected_category,
    expected_quantity,
):
    """Recoverable parser failures should bill from hints without lost-visibility logs."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path=path,
        query=query,
        permission=permission,
        rule=rule,
    )
    flow.metadata[metadata_keys.X_JSON_STATE] = {
        "body_parsed": False,
        "body_truncated": False,
        "parse_error": "incomplete json",
    }
    proxy_log = tmp_path / "proxy.jsonl"

    p = x_usage.call_and_get_single_billing(flow)

    assert p["category"] == expected_category
    assert p["quantity"] == expected_quantity
    assert jsonl_exists_after_flush(proxy_log)
    entries = read_jsonl_entries_after_flush(proxy_log)
    assert all(entry["level"] != "error" for entry in entries)
    assert all("unparseable" not in entry["message"].lower() for entry in entries)
    assert all("parse_error" not in entry for entry in entries)


def test_x_json_parse_error_with_zero_max_results_is_no_reliable_hint(x_usage, tmp_path, real_flow):
    """A zero max_results hint should preserve lost-visibility logs."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        query="query=hello&max_results=0",
        rule="GET /2/tweets/search/recent",
    )
    flow.metadata[metadata_keys.X_JSON_STATE] = {
        "body_parsed": False,
        "body_truncated": False,
        "parse_error": "incomplete json",
    }
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []
    entry = assert_lost_visibility_error(proxy_log)
    assert entry["parse_error"] == "incomplete json"


@pytest.mark.parametrize(
    ("path", "query", "permission", "rule"),
    [
        (
            "/2/tweets/search/recent",
            "query=hello&max_results=-5",
            "tweet.read",
            "GET /2/tweets/search/recent",
        ),
        (
            "/2/tweets/search/recent",
            "query=hello&max_results=999999",
            "tweet.read",
            "GET /2/tweets/search/recent",
        ),
        (
            "/2/tweets/search/recent",
            "query=hello&max_results=+50",
            "tweet.read",
            "GET /2/tweets/search/recent",
        ),
        (
            "/2/tweets/search/recent",
            "query=hello&max_results=%2050",
            "tweet.read",
            "GET /2/tweets/search/recent",
        ),
        (
            "/2/lists/123/members",
            "max_results=101",
            "list.read",
            "GET /2/lists/{id}/members",
        ),
        (
            "/2/users/123/tweets",
            "max_results=4",
            "users.read",
            "GET /2/users/{id}/tweets",
        ),
        (
            "/2/users/search",
            "query=alice&max_results=1001",
            "users.read",
            "GET /2/users/search",
        ),
    ],
)
def test_x_json_parse_error_with_invalid_max_results_preserves_audit_log(
    x_usage, tmp_path, real_flow, path, query, permission, rule
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path=path,
        query=query,
        body=b"not json",
        permission=permission,
        rule=rule,
    )
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []
    assert_lost_visibility_error(proxy_log)


def test_x_json_parse_error_ignores_max_results_on_irrelevant_path(x_usage, tmp_path, real_flow):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/123",
        query="max_results=1000",
        body=b"not json",
        rule="GET /2/tweets/{id}",
    )
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []
    assert_lost_visibility_error(proxy_log)


@pytest.mark.parametrize(
    ("path", "query", "permission", "rule"),
    [
        ("/2/users/by", "ids=1,2", "users.read", "GET /2/users/by"),
        (
            "/2/tweets/search/recent",
            "query=hello&ids=1,2",
            "tweet.read",
            "GET /2/tweets/search/recent",
        ),
    ],
)
def test_x_json_parse_error_ignores_id_like_hints_on_irrelevant_paths(
    x_usage, tmp_path, real_flow, path, query, permission, rule
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path=path,
        query=query,
        body=b"not json",
        permission=permission,
        rule=rule,
    )
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []
    assert_lost_visibility_error(proxy_log)


@pytest.mark.parametrize(
    ("path", "query", "permission", "rule"),
    [
        (
            "/2/tweets",
            f"ids={','.join(str(i) for i in range(101))}",
            "tweet.read",
            "GET /2/tweets",
        ),
        (
            "/2/users/by",
            f"usernames={','.join(f'user{i}' for i in range(101))}",
            "users.read",
            "GET /2/users/by",
        ),
        (
            "/2/tweets",
            f"ids={','.join(str(i) for i in range(1, 101))}&ids=,,&ids=101",
            "tweet.read",
            "GET /2/tweets",
        ),
    ],
)
def test_x_json_parse_error_ignores_excessive_selector_counts(
    x_usage, tmp_path, real_flow, path, query, permission, rule
):
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path=path,
        query=query,
        body=b"not json",
        permission=permission,
        rule=rule,
    )
    proxy_log = tmp_path / "proxy.jsonl"

    assert x_usage.call_and_get_billing(flow) == []
    assert_lost_visibility_error(proxy_log)


@pytest.mark.parametrize(
    ("query", "expected_quantity"),
    [
        ("ids=1,,2", 2),
        ("ids=,1,2,", 2),
        ("ids=1,+,2", 2),
    ],
)
def test_billable_counts_fallback_filters_empty_id_segments(
    x_usage, tmp_path, real_flow, query, expected_quantity
):
    """body unparseable but ?ids= present -> uses non-empty id segment count."""
    flow = x_usage.make_flow(real_flow, tmp_path, query=query, body=b"not json")
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == expected_quantity


def test_billable_counts_fallback_filters_empty_username_segments(x_usage, tmp_path, real_flow):
    """body unparseable but ?usernames= present -> uses non-empty username count."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/users/by",
        query="usernames=a,,b",
        body=b"not json",
        permission="users.read",
        rule="GET /2/users/by",
    )
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "user.read"
    assert p["quantity"] == 2


def test_billable_counts_fallback_empty_id_segments_are_no_hint(x_usage, tmp_path, real_flow):
    """body unparseable and only empty ?ids= segments -> no billing, with audit log."""
    flow = x_usage.make_flow(real_flow, tmp_path, query="ids=,,", body=b"not json")
    proxy_log = tmp_path / "proxy.jsonl"
    assert x_usage.call_and_get_billing(flow) == []
    assert jsonl_exists_after_flush(proxy_log)
    content = read_jsonl_text_after_flush(proxy_log)
    assert "unparseable" in content.lower()
    assert '"level":"error"' in content or '"level": "error"' in content


def test_billable_counts_fallback_uses_path_scoped_max_results(x_usage, tmp_path, real_flow):
    """body unparseable on a max_results endpoint -> uses max_results."""
    flow = x_usage.make_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/recent",
        query="query=hello&max_results=50",
        body=b"not json",
        rule="GET /2/tweets/search/recent",
    )
    p = x_usage.call_and_get_single_billing(flow)
    assert p["category"] == "posts.read"
    assert p["quantity"] == 50
