"""Ignored queries keep mail guard allocations bounded without changing policy."""

import json
import tracemalloc

import pytest
from mitmproxy.net.http import http1, validate

import gmail_send
import mitm_addon
import outlook_send
from tests.request_handler_helpers import _single_firewall_sandbox, _write_registry


@pytest.fixture(
    params=[
        pytest.param(
            (
                "gmail.googleapis.com",
                "/gmail/v1/users/me/messages/send",
                "/gmail/v1/users/me/messages",
                "gmail_send_blocked",
            ),
            id="gmail",
        ),
        pytest.param(
            (
                "www.googleapis.com",
                "/gmail/v1/users/me/messages/send",
                "/gmail/v1/users/me/messages",
                "gmail_send_blocked",
            ),
            id="shared-google-host",
        ),
        pytest.param(
            (
                "graph.microsoft.com",
                "/v1.0/me/sendMail",
                "/v1.0/me/messages",
                "outlook_send_blocked",
            ),
            id="outlook",
        ),
    ],
)
def mail_target(request: pytest.FixtureRequest) -> tuple[str, str, str, str]:
    return request.param


def _blocks_send(host: str, path: str) -> bool:
    if host == "graph.microsoft.com":
        return outlook_send.blocks_outlook_send(host, path, None)
    return gmail_send.blocks_gmail_send(host, path)


@pytest.mark.parametrize("send", [True, False], ids=["send", "read"])
def test_large_ignored_query_does_not_allocate_a_suffix(mail_target, send):
    host, send_path, read_path, _ = mail_target
    path = send_path if send else read_path
    # Construct input before tracing; query syntax must not reach path validation.
    target = path + "?q=" + "x" * (4 * 1024 * 1024) + "&ignored=%FF%253F/../\\#?sendMail"

    tracemalloc.start()
    try:
        blocked = _blocks_send(host, target)
        peak_bytes = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()

    assert blocked is send
    # Allow ample path-processing overhead, but no query-sized intermediate.
    assert peak_bytes < 64 * 1024


@pytest.mark.parametrize(
    ("suffix", "blocked"),
    [
        pytest.param("", True, id="no-query"),
        pytest.param("?", True, id="empty-query"),
        pytest.param("??/../%FF#fragment", True, id="first-question-mark"),
        pytest.param("%3Fignored", False, id="encoded-question-mark-is-path"),
        pytest.param("#fragment", False, id="fragment-is-path"),
        pytest.param("#fragment?ignored", False, id="fragment-before-query"),
        pytest.param("?ignored#fragment", True, id="fragment-after-query"),
    ],
)
def test_query_delimiter_preserves_send_path_semantics(mail_target, suffix, blocked):
    host, send_path, _, _ = mail_target
    assert _blocks_send(host, send_path + suffix) is blocked


@pytest.mark.parametrize("send", [True, False], ids=["send", "read"])
async def test_native_valid_large_query_keeps_mail_policy(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers, mail_target, send
):
    host, send_path, read_path, reason = mail_target
    path = send_path if send else read_path
    target = path + "?hint=" + send_path + "&padding=" + "x" * (4 * 1024 * 1024)
    method = "POST" if send else "GET"
    registry = _write_registry(
        tmp_path,
        sandbox_info=_single_firewall_sandbox(
            tmp_path,
            firewall_name="outlook-mail" if host == "graph.microsoft.com" else "gmail",
            api_entry={
                "base": f"https://{host}",
                "auth": {"headers": {"Authorization": "Bearer ${{ secrets.MAIL_TOKEN }}"}},
                "permissions": [{"name": "mail", "rules": ["ANY /{path+}"]}],
            },
            network_policy={"allow": ["mail"], "deny": [], "unknownPolicy": "allow"},
            sandbox_fields={"outlookMailReviewEnabled": True},
        ),
    )
    flow = real_flow(with_response=False, client_ip="10.200.0.5", host=host)
    flow.request = http1.read_request_head(
        [
            f"{method} https://{host}{target} HTTP/1.1".encode(),
            f"Host: {host}".encode(),
            b"Content-Length: 0",
        ]
    )
    validate.validate_headers(flow.request)
    assert http1.expected_http_body_size(flow.request) == 0
    flow.request.content = b""

    with (
        mitm_ctx(registry_path=str(registry), api_url="https://api.okou.ai"),
        fake_firewall_headers(headers={"Authorization": "Bearer selected-account"}),
    ):
        header_result = mitm_addon.requestheaders(flow)
        if header_result is not None:
            await header_result
        await mitm_addon.request(flow)

    assert flow.request.path == target
    if send:
        assert flow.response is not None
        assert flow.response.status_code == 403
        error = json.loads(flow.response.content)["error"]
        if host == "graph.microsoft.com":
            assert error["code"] == reason
        else:
            assert error["errors"] == [{"domain": "okou", "reason": reason}]
        assert "Authorization" not in flow.request.headers
    else:
        assert flow.response is None
        assert flow.request.headers["Authorization"] == "Bearer selected-account"
