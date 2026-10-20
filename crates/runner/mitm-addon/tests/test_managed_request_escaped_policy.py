"""Equivalent escaped policy strings retain the same managed authorization."""

from unittest.mock import patch

import pytest
from mitmproxy.addons.proxyserver import Proxyserver
from mitmproxy.proxy.layers.http import GetHttpConnection, GetHttpConnectionCompleted, SendHttp
from mitmproxy.proxy.layers.http._events import RequestData, RequestEndOfMessage
from mitmproxy.test import taddons

import managed_openrouter as managed
import mitm_addon
from tests.managed_openrouter_helpers import PRESET, sandbox
from tests.managed_request_transport_helpers import begin_upload, finish_hooks
from tests.request_handler_helpers import _write_registry


def _string(value: str, *, escaped: bool) -> bytes:
    content = "".join(f"\\u{ord(char):04x}" for char in value) if escaped else value
    return ('"' + content + '"').encode()


@pytest.mark.parametrize("escaped", ["model", "service_tier", "tool_type", "keys"])
async def test_equivalent_escaped_policy_strings_are_authorized_and_forwarded_unchanged(
    tmp_path,
    fake_firewall_headers,
    escaped,
):
    preset = "@preset/" + "x" * 504 if escaped == "model" else PRESET
    info = sandbox(tmp_path, "openai-responses", preset)
    info["piModelConfig"]["serviceTier"] = "priority"
    registry = _write_registry(tmp_path, sandbox_info=info)
    model = _string(preset, escaped=escaped == "model")
    tier = _string("priority", escaped=escaped == "service_tier")
    tool = _string("function", escaped=escaped == "tool_type")
    model_key = _string("model", escaped=escaped == "keys")
    tier_key = _string("service_tier", escaped=escaped == "keys")
    type_key = _string("type", escaped=escaped == "keys")
    body = (
        b"{"
        + model_key
        + b":"
        + model
        + b","
        + tier_key
        + b":"
        + tier
        + b',"tools":[{'
        + type_key
        + b":"
        + tool
        + b',"name":"tool","parameters":{}}]}'
    )
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer escaped-policy"}) as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(body), dialect="openai-responses")
        for offset in range(0, len(body), 7):
            await finish_hooks(
                context, stream, stream.handle_event(RequestData(1, body[offset : offset + 7]))
            )
            auth_fetch.assert_not_called()
        pending = await finish_hooks(context, stream, stream.handle_event(RequestEndOfMessage(1)))
        assert flow.response is None
        acquire = next(command for command in pending if isinstance(command, GetHttpConnection))
        sent = await finish_hooks(
            context,
            stream,
            stream.handle_event(GetHttpConnectionCompleted(acquire, (flow.server_conn, None))),
        )
        assert (
            b"".join(
                command.event.data
                for command in sent
                if isinstance(command, SendHttp) and isinstance(command.event, RequestData)
            )
            == body
        )
        auth_fetch.assert_awaited_once()
        assert managed.admission_state_for_tests() == (0, 0)
        mitm_addon.error(flow)


@pytest.mark.parametrize("dialect", ["openai-completions", "openai-responses"])
@pytest.mark.parametrize("key_kind", ["high", "low"])
@pytest.mark.parametrize("duplicate", [False, True])
async def test_opaque_escaped_keys_preserve_json_identity_and_duplicate_rejection(
    tmp_path, fake_firewall_headers, dialect, key_kind, duplicate
):
    keys = {
        "high": (rb'"\ud800"', rb'"\ud801"', rb'"\uD800"'),
        "low": (rb'"\udc00"', rb'"\udc01"', rb'"\uDC00"'),
    }[key_kind]
    body = (
        b'{"model":'
        + _string(PRESET, escaped=False)
        + b',"metadata":{'
        + keys[0]
        + b':"private-first",'
        + keys[2 if duplicate else 1]
        + b':"private-second"}}'
    )
    registry = _write_registry(tmp_path, sandbox_info=sandbox(tmp_path, dialect))
    with (
        patch.object(mitm_addon, "__file__", str(tmp_path / "mitm_addon.py")),
        taddons.context(Proxyserver(), mitm_addon) as context,
        fake_firewall_headers(headers={"Authorization": "Bearer escaped-policy"}) as auth_fetch,
    ):
        context.options.update(
            okou_api_url="https://api.okou.ai", okou_proxy_registry_path=str(registry)
        )
        stream, flow = await begin_upload(context, len(body), dialect=dialect)
        try:
            for offset in range(0, len(body), 7):
                await finish_hooks(
                    context, stream, stream.handle_event(RequestData(1, body[offset : offset + 7]))
                )
                auth_fetch.assert_not_called()
            pending = await finish_hooks(
                context, stream, stream.handle_event(RequestEndOfMessage(1))
            )
            if duplicate:
                auth_fetch.assert_not_called()
                assert flow.response is not None
                assert flow.response.status_code == 403
                assert b"duplicate_json_key" in (flow.response.raw_content or b"")
                assert b"private-first" not in (flow.response.raw_content or b"")
                assert not any(
                    isinstance(command, GetHttpConnection)
                    or (isinstance(command, SendHttp) and command.connection == flow.server_conn)
                    for command in pending
                )
            else:
                assert flow.response is None
                acquire = next(
                    command for command in pending if isinstance(command, GetHttpConnection)
                )
                sent = await finish_hooks(
                    context,
                    stream,
                    stream.handle_event(
                        GetHttpConnectionCompleted(acquire, (flow.server_conn, None))
                    ),
                )
                assert (
                    b"".join(
                        command.event.data
                        for command in sent
                        if isinstance(command, SendHttp) and isinstance(command.event, RequestData)
                    )
                    == body
                )
                auth_fetch.assert_awaited_once()
            assert managed.admission_state_for_tests() == (0, 0)
        finally:
            mitm_addon.error(flow)
