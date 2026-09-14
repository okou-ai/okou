"""Response streaming setup and parser state for the mitmproxy addon.

Lifecycle:
- ``mitm_addon.responseheaders()`` calls ``configure_response_stream()`` to
  install the streaming callback, exact byte accounting, optional capped body
  buffer, and incremental or bounded terminal response inspectors.
- ``mitm_addon.response()`` finalizes HTTP model and connector usage before
  reporting it.
- ``mitm_addon.error()`` may finalize partial SSE or opted-in connector usage
  before terminal cleanup.
- hook cleanup paths call ``release_response_stream_state()`` to remove parser
  callbacks, byte accounting, and optional buffer metadata from
  ``flow.metadata``.
"""

from collections.abc import Callable
from typing import NamedTuple

from mitmproxy import http
from wsproto.utilities import generate_accept_token

import anthropic_accounting
import body_decoding
import claude_output_timing
import flow_metadata
import flow_metadata_keys as metadata_keys
import http_header_syntax
import http_response_classification
import model_provider_failure
import model_websocket_usage
import runtime_url_parsing
import stream_capture
import usage
from body_limits import STREAM_BUFFER_LIMIT
from logging_utils import log_proxy_entry
from usage.underbilling import log_usage_underbilling

_HTTP_STATUS_SWITCHING_PROTOCOLS = 101
_HTTP_STATUS_OK_MIN = 200
_HTTP_STATUS_REDIRECT_MIN = 300
_HTTP_STATUS_BAD_GATEWAY = 502
_WEBSOCKET_KEY_BASE64_BYTES = 24
_WEBSOCKET_ACCEPT_BASE64_BYTES = 28

_MODEL_JSON_USAGE_FINISH = "model_json_usage_finish"
_MODEL_SSE_USAGE_FINISH = "model_sse_usage_finish"
_CONNECTOR_RESPONSE_FINISH = "connector_response_finish"
_CONNECTOR_RESPONSE_REPORT_ON_INTERRUPTION = "connector_response_report_on_interruption"
_RESPONSE_STREAM_CALLBACK = "_response_stream_callback"

_ANTHROPIC_MESSAGES_SSE_PROTOCOL = "anthropic_messages_sse"
_OPENAI_CHAT_COMPLETIONS_SSE_PROTOCOL = "openai_chat_completions_sse"
_OPENAI_RESPONSES_SSE_PROTOCOL = "openai_responses_sse"
_ANTHROPIC_USAGE_EVENTS = frozenset(("message_start", "message_delta"))
_ANTHROPIC_MESSAGE_STOP_EVENT = "message_stop"

_ResponseChunkParser = Callable[[bytes], None]
_SseUsageParseErrorLogger = Callable[[str, str], None]
_AnthropicLifecycleObserver = Callable[[str, str | None], None]


def _anthropic_incomplete_accounting_status(
    usage_dict: dict,
    accounting_events: set[str],
) -> anthropic_accounting.AnthropicAccountingStatus:
    has_recoverable_usage = bool(accounting_events & _ANTHROPIC_USAGE_EVENTS) and (
        usage.has_positive_model_provider_usage(usage_dict)
    )
    if not has_recoverable_usage:
        return "no_recoverable_usage"
    if _ANTHROPIC_MESSAGE_STOP_EVENT in accounting_events:
        return "recovered_terminal"
    return "recovered_partial"


class _ResponseStreamSetup(NamedTuple):
    parser: _ResponseChunkParser | None
    needs_buffered_fallback: bool
    finish_stream: Callable[[], object] | None = None
    reject_uninspectable: bool = False


def model_usage_protocol(flow: http.HTTPFlow) -> usage.ModelUsageProtocol:
    """Classify model usage from the observed request and CLI fallback."""
    request_target = flow_metadata.original_url(flow.metadata) or flow.request.path
    request_path = runtime_url_parsing.strip_url_query_and_fragment(request_target).rstrip("/")
    if request_path.endswith("/chat/completions"):
        return "openai_chat_completions"
    if request_path.endswith("/responses"):
        return "openai_responses"
    if flow_metadata.cli_agent_type(flow.metadata) == "codex":
        return "openai_responses"
    return "anthropic_messages"


def uses_model_json_fallback(
    flow: http.HTTPFlow,
    *,
    websocket_header_work_limit: int,
) -> bool:
    """Return whether terminal model usage may parse a buffered JSON body."""
    response = flow.response
    if (
        response is None
        or not http_response_classification.can_have_body(flow, response)
        or not usage.is_model_provider_usage_billable(flow)
    ):
        return False
    if http_response_classification.has_event_stream_media_type(response):
        return False
    return not is_confirmed_websocket_upgrade_response(
        flow,
        websocket_header_work_limit=websocket_header_work_limit,
    )


def _make_response_decode_session(
    feed: _ResponseChunkParser,
    headers: http.Headers,
    *,
    should_continue: Callable[[], bool] | None = None,
) -> body_decoding.StreamDecodeSession | None:
    return body_decoding.create_stream_decode_session(
        headers,
        feed,
        should_continue=should_continue,
    )


def _make_model_sse_parse_error_logger(
    flow: http.HTTPFlow,
    *,
    usage_protocol: str,
) -> _SseUsageParseErrorLogger:
    proxy_log_path = flow_metadata.proxy_log_path(flow.metadata)

    def log_parse_error(event: str, error: str) -> None:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Model provider SSE usage extraction failed",
            type="usage_event",
            usage_protocol=usage_protocol,
            event=event,
            error=error,
        )

    return log_parse_error


def _anthropic_lifecycle_observer(
    flow: http.HTTPFlow,
) -> _AnthropicLifecycleObserver | None:
    if flow_metadata.cli_agent_type(flow.metadata) != "claude-code":
        return None

    def observe(event_type: str, content_block_type: str | None) -> None:
        claude_output_timing.observe_lifecycle_event(
            flow,
            event_type,
            content_block_type,
        )

    return observe


def _log_response_encoding_fail_closed(
    flow: http.HTTPFlow,
    response: http.Response,
) -> None:
    skip_reason = body_decoding.stream_decode_skip_reason(response.headers)
    if skip_reason is None:
        raise RuntimeError("fail-closed response encoding is stream-decodable")
    log_usage_underbilling(
        flow_metadata.proxy_log_path(flow.metadata),
        "Response encoding has no bounded usage accounting path",
        "response_encoding_not_stream_decodable",
        "risk",
        run_id=flow_metadata.run_id(flow.metadata),
        firewall_name=flow_metadata.firewall_name(flow.metadata),
        firewall_billable=flow_metadata.is_firewall_billable(flow.metadata),
        status_code=response.status_code,
        inspection_disposition="fail_closed",
        request_encoding_negotiation=flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION],
        decode_skip_reason=skip_reason,
    )


def _configure_response_inspection_stream(
    flow: http.HTTPFlow,
    failure_observer: model_provider_failure.HttpResponseFailureObserver | None,
    *,
    websocket_header_work_limit: int,
) -> _ResponseStreamSetup:
    # Set up model inspection or connector usage extraction for response classes
    # that need it. Parsers consume chunks separately from the optional buffer.
    response = flow.response
    if response is None:
        return _ResponseStreamSetup(None, False)

    # Platform-billable firewall flag, sourced from sandbox_info["billableFirewalls"]
    # via auth.handle_firewall_request. It gates model-provider and connector
    # usage extraction and reporting.
    is_billable_flow = flow_metadata.is_firewall_billable(flow.metadata)
    is_billable_model_provider = usage.is_model_provider_usage_billable(flow)
    model_protocol = (
        model_usage_protocol(flow)
        if is_billable_model_provider or failure_observer is not None
        else None
    )
    if (
        is_billable_model_provider
        and model_protocol == "openai_responses"
        and is_confirmed_websocket_upgrade_response(
            flow,
            websocket_header_work_limit=websocket_header_work_limit,
        )
    ):
        model_websocket_usage.activate(flow)
        return _ResponseStreamSetup(None, False)
    if not http_response_classification.can_have_body(flow, response):
        return _ResponseStreamSetup(None, False)
    if model_protocol is not None:
        if http_response_classification.has_event_stream_media_type(response):
            lifecycle_observer: _AnthropicLifecycleObserver | None = None
            anthropic_accounting_events: set[str] = set()
            openai_recoverable_usage: dict = {}
            if model_protocol == "openai_responses":
                usage_protocol = _OPENAI_RESPONSES_SSE_PROTOCOL
                log_parse_error = _make_model_sse_parse_error_logger(
                    flow,
                    usage_protocol=usage_protocol,
                )

                def record_openai_terminal_usage(terminal_usage: dict) -> None:
                    usage.merge_openai_responses_usage_result(
                        openai_recoverable_usage,
                        terminal_usage,
                    )

                parser_fn, usage_dict = usage.create_openai_responses_sse_usage_extractor(
                    on_parse_error=log_parse_error,
                    on_terminal_usage=(
                        record_openai_terminal_usage if is_billable_model_provider else None
                    ),
                    include_usage=is_billable_model_provider,
                    failure_observer=failure_observer,
                )
            elif model_protocol == "openai_chat_completions":
                usage_protocol = _OPENAI_CHAT_COMPLETIONS_SSE_PROTOCOL
                log_parse_error = _make_model_sse_parse_error_logger(
                    flow,
                    usage_protocol=usage_protocol,
                )
                parser_fn, usage_dict = usage.create_openai_chat_completions_sse_usage_extractor(
                    on_parse_error=log_parse_error,
                    include_usage=is_billable_model_provider,
                    failure_observer=failure_observer,
                )
            else:
                usage_protocol = _ANTHROPIC_MESSAGES_SSE_PROTOCOL
                log_parse_error = _make_model_sse_parse_error_logger(
                    flow,
                    usage_protocol=usage_protocol,
                )
                lifecycle_observer = (
                    _anthropic_lifecycle_observer(flow) if is_billable_model_provider else None
                )
                parser_fn, usage_dict = usage.create_anthropic_messages_sse_usage_extractor(
                    on_parse_error=log_parse_error,
                    on_lifecycle_event=lifecycle_observer,
                    on_accounting_event=(
                        anthropic_accounting_events.add if is_billable_model_provider else None
                    ),
                    include_usage=is_billable_model_provider,
                    failure_observer=failure_observer,
                )
            decode_session = _make_response_decode_session(parser_fn, response.headers)
            if decode_session is None:
                if failure_observer is not None:
                    model_provider_failure.register_response_finish(
                        flow,
                        failure_observer.finish,
                    )
                return _ResponseStreamSetup(
                    None,
                    False,
                    reject_uninspectable=(
                        is_billable_flow
                        and is_billable_model_provider
                        and _HTTP_STATUS_OK_MIN <= response.status_code < _HTTP_STATUS_REDIRECT_MIN
                    ),
                )

            finished = False

            def finish_sse_response() -> object:
                nonlocal finished
                if not finished:
                    decode_error = decode_session.finish_error()
                    if decode_error is None:
                        parser_fn.finish()
                    elif is_billable_model_provider:
                        log_parse_error("compressed_body", decode_error)
                        if (
                            usage_protocol == _ANTHROPIC_MESSAGES_SSE_PROTOCOL
                            and decode_error == body_decoding.INCOMPLETE_COMPRESSED_BODY
                        ):
                            accounting_status = _anthropic_incomplete_accounting_status(
                                usage_dict,
                                anthropic_accounting_events,
                            )
                            anthropic_accounting.report_incomplete(
                                flow,
                                accounting_status,
                            )
                        elif (
                            usage_protocol == _OPENAI_RESPONSES_SSE_PROTOCOL
                            and decode_error == body_decoding.INCOMPLETE_COMPRESSED_BODY
                        ):
                            usage_dict.clear()
                            usage.merge_openai_responses_usage_result(
                                usage_dict,
                                openai_recoverable_usage,
                            )
                        else:
                            usage_dict.clear()
                    if lifecycle_observer is not None:
                        claude_output_timing.retry_pending(flow)
                    finished = True
                return failure_observer.finish() if failure_observer is not None else None

            def finish_sse_stream() -> object:
                finish_sse_response()
                return failure_observer.settle() if failure_observer is not None else None

            if is_billable_model_provider:
                flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = usage_dict
                flow.metadata[_MODEL_SSE_USAGE_FINISH] = finish_sse_response
            if failure_observer is not None:
                model_provider_failure.register_response_finish(flow, finish_sse_response)
            return _ResponseStreamSetup(
                decode_session.feed,
                False,
                finish_sse_stream if failure_observer is not None else None,
            )

        extractor = usage.create_model_json_response_inspector(
            model_protocol,
            include_usage=is_billable_model_provider,
            include_failure=failure_observer is not None,
        )
        decode_session = _make_response_decode_session(
            extractor.feed,
            response.headers,
            should_continue=extractor.accepts_more_input,
        )
        needs_buffered_fallback = False
        if decode_session is None:
            needs_buffered_fallback = body_decoding.can_decode_json_usage_body(
                response.headers
            ) and (
                failure_observer is not None
                or (
                    is_billable_model_provider
                    and uses_model_json_fallback(
                        flow,
                        websocket_header_work_limit=websocket_header_work_limit,
                    )
                )
            )
            if not needs_buffered_fallback:
                if failure_observer is not None:
                    model_provider_failure.register_response_finish(
                        flow,
                        failure_observer.finish,
                    )
                return _ResponseStreamSetup(
                    None,
                    False,
                    reject_uninspectable=(
                        is_billable_flow
                        and is_billable_model_provider
                        and _HTTP_STATUS_OK_MIN <= response.status_code < _HTTP_STATUS_REDIRECT_MIN
                    ),
                )

        inspection: usage.ModelJsonResponseInspection | None = None
        decode_error: str | None = None
        finished = False

        def finish_json_response() -> object:
            nonlocal decode_error, finished, inspection
            if not finished:
                if decode_session is not None:
                    decode_error = decode_session.finish_error()
                else:
                    stream_body = stream_capture.captured_response_stream_body(flow)
                    if stream_body is None:
                        raise RuntimeError(
                            "buffered model JSON finalizer requires a response stream buffer"
                        )
                    decoded_body, decode_error = body_decoding.decode_captured_json_usage_body(
                        stream_body, response.headers
                    )
                    if decode_error is None:
                        if stream_body.buffer:
                            extractor.feed(decoded_body)
                        else:
                            finished = True
                if not finished and decode_error is None:
                    inspection = extractor.finish()
                    if failure_observer is not None:
                        failure_observer.observe_json(inspection.failure)
                finished = True
            return failure_observer.finish() if failure_observer is not None else None

        def finish_json_usage() -> tuple[dict | None, str | None]:
            finish_json_response()
            if decode_error is not None:
                return None, decode_error
            if inspection is None:
                return None, None
            return inspection.usage, inspection.usage_error

        def finish_json_stream() -> object:
            finish_json_response()
            return failure_observer.settle() if failure_observer is not None else None

        if is_billable_model_provider:
            flow.metadata[_MODEL_JSON_USAGE_FINISH] = finish_json_usage
        if failure_observer is not None:
            model_provider_failure.register_response_finish(flow, finish_json_response)
        return _ResponseStreamSetup(
            decode_session.feed if decode_session is not None else None,
            needs_buffered_fallback,
            finish_json_stream if failure_observer is not None else None,
        )

    if not is_billable_flow:
        return _ResponseStreamSetup(None, False)
    if not body_decoding.can_stream_decode_usage(response.headers):
        firewall_name = flow_metadata.firewall_name(flow.metadata)
        requires_response_inspection = (
            _HTTP_STATUS_OK_MIN <= response.status_code < _HTTP_STATUS_REDIRECT_MIN
            and usage.has_connector_response_parser(firewall_name)
        )
        needs_buffered_fallback = (
            http_response_classification.can_have_body(flow, response)
            and body_decoding.can_decode_json_usage_body(response.headers)
            and usage.needs_connector_response_buffer_fallback(flow)
        )
        return _ResponseStreamSetup(
            None,
            needs_buffered_fallback,
            reject_uninspectable=(requires_response_inspection and not needs_buffered_fallback),
        )
    connector_parser = usage.create_connector_response_parser(flow)
    if connector_parser is not None:
        decode_session = _make_response_decode_session(
            connector_parser.feed,
            response.headers,
            should_continue=connector_parser.should_continue,
        )
        if decode_session is None:
            raise RuntimeError("stream-decodable connector response did not create a decoder")
        if connector_parser.report_on_interruption:
            flow.metadata[_CONNECTOR_RESPONSE_REPORT_ON_INTERRUPTION] = True
        if connector_parser.finish is not None or connector_parser.finish_decode_error is not None:

            def finish_connector_response() -> None:
                decode_error = decode_session.finish_error()
                if decode_error is not None:
                    if connector_parser.finish_decode_error is not None:
                        connector_parser.finish_decode_error(decode_error)
                    return
                if connector_parser.finish is not None:
                    connector_parser.finish()

            flow.metadata[_CONNECTOR_RESPONSE_FINISH] = finish_connector_response
        return _ResponseStreamSetup(decode_session.feed, False)

    return _ResponseStreamSetup(None, False)


def is_confirmed_websocket_upgrade_response(
    flow: http.HTTPFlow,
    *,
    websocket_header_work_limit: int,
) -> bool:
    """Return whether ``flow`` completed a confirmed WebSocket upgrade.

    Confirmation requires a response with status 101, the exact ``True``
    value for ``WEBSOCKET_UPGRADE_REQUEST``, response ``Upgrade`` and
    ``Connection`` field values containing the ``websocket`` and ``upgrade``
    list tokens, singleton request ``Sec-WebSocket-Key`` and response
    ``Sec-WebSocket-Accept`` fields, an ASCII request key, and a matching
    RFC-generated accept token. Missing or malformed values fail closed and
    return ``False``.

    For a billable OpenAI Responses model-provider flow, ``True`` is the
    signal for WebSocket usage activation and allows tracked-flow release to
    wait for ``websocket_end()``; ``False`` follows ordinary HTTP terminal
    handling.
    """
    response = flow.response
    if response is None:
        return False
    if response.status_code != _HTTP_STATUS_SWITCHING_PROTOCOLS:
        return False
    if flow.metadata.get(metadata_keys.WEBSOCKET_UPGRADE_REQUEST) is not True:
        return False
    if not http_header_syntax.header_fields_contain_token(
        response.headers.fields,
        b"upgrade",
        b"websocket",
        max_work_units=websocket_header_work_limit,
    ):
        return False
    if not http_header_syntax.header_fields_contain_token(
        response.headers.fields,
        b"connection",
        b"upgrade",
        max_work_units=websocket_header_work_limit,
    ):
        return False

    request_key = http_header_syntax.single_header_value(
        flow.request.headers.fields,
        b"sec-websocket-key",
        max_fields=websocket_header_work_limit,
        max_value_bytes=websocket_header_work_limit,
    )
    response_accept = http_header_syntax.single_header_value(
        response.headers.fields,
        b"sec-websocket-accept",
        max_fields=websocket_header_work_limit,
        max_value_bytes=websocket_header_work_limit,
    )
    if (
        request_key is None
        or len(request_key) != _WEBSOCKET_KEY_BASE64_BYTES
        or not request_key.isascii()
        or response_accept is None
        or len(response_accept) != _WEBSOCKET_ACCEPT_BASE64_BYTES
    ):
        return False
    expected_accept = generate_accept_token(request_key)
    return response_accept == expected_accept


def _discard_uninspectable_response_body(_chunk: bytes) -> bytes:
    return b""


def _reject_uninspectable_response(flow: http.HTTPFlow) -> None:
    model_provider_failure.release_flow(flow)
    flow.response = http.Response.make(
        _HTTP_STATUS_BAD_GATEWAY,
        b"",
        {"Content-Type": "text/plain"},
    )
    flow.response.stream = _discard_uninspectable_response_body


def configure_response_stream(
    flow: http.HTTPFlow,
    *,
    websocket_header_work_limit: int,
) -> None:
    """Enable pass-through response streaming and body consumers.

    Every configured response records exact streamed bytes. A capped raw-wire
    body prefix is retained only for network capture or bounded terminal
    inspection that cannot use incremental decoding.
    """
    if not flow.response:
        return

    metrics = {"total_bytes": 0}
    failure_observer = model_provider_failure.configure_response_observer(flow)
    setup = _configure_response_inspection_stream(
        flow,
        failure_observer,
        websocket_header_work_limit=websocket_header_work_limit,
    )
    if setup.reject_uninspectable:
        _log_response_encoding_fail_closed(flow, flow.response)
        _reject_uninspectable_response(flow)
        return

    response_parser = setup.parser
    needs_buffered_fallback = setup.needs_buffered_fallback
    finish_stream = setup.finish_stream
    retain_body = flow_metadata.should_capture_body(flow.metadata) or needs_buffered_fallback
    buf = bytearray() if retain_body else None
    buffer_state = {"truncated": False} if retain_body else None

    def stream_and_observe(chunk: bytes) -> bytes:
        metrics["total_bytes"] += len(chunk)
        if buf is not None and buffer_state is not None and not buffer_state["truncated"]:
            remaining = STREAM_BUFFER_LIMIT - len(buf)
            if len(chunk) <= remaining:
                buf.extend(chunk)
            else:
                buf.extend(chunk[:remaining])
                buffer_state["truncated"] = True
        if response_parser is not None:
            response_parser(chunk)
        if not chunk and finish_stream is not None:
            finish_stream()
        return chunk

    flow.response.stream = stream_and_observe
    flow.metadata[metadata_keys.RESPONSE_STREAM_STATE] = metrics
    if buf is not None and buffer_state is not None:
        flow.metadata[metadata_keys.STREAM_BUFFER] = buf
        flow.metadata[metadata_keys.STREAM_BUFFER_STATE] = buffer_state
    flow.metadata[_RESPONSE_STREAM_CALLBACK] = stream_and_observe


def streamed_response_size(flow: http.HTTPFlow) -> int | None:
    """Return total bytes observed by the response streaming callback.

    Read-only helper used by ``response()`` network logging. Reads
    ``metadata_keys.RESPONSE_STREAM_STATE`` and returns ``None`` when
    ``responseheaders()`` did not configure streaming for this flow.
    """
    state = flow.metadata.get(metadata_keys.RESPONSE_STREAM_STATE)
    if state is None:
        return None
    return int(state["total_bytes"])


def finalize_model_json_usage(flow: http.HTTPFlow, proxy_log_path: str) -> None:
    """Finalize incremental or bounded terminal model-provider JSON usage extraction.

    Called from ``response()`` before usage reporting. Pops
    ``_MODEL_JSON_USAGE_FINISH``, so repeated calls after the first are no-ops.
    On success, writes ``metadata_keys.MODEL_PROVIDER_USAGE``. Parse failures
    are logged to ``proxy_log_path``.
    """
    finish = flow.metadata.pop(_MODEL_JSON_USAGE_FINISH, None)
    if finish is None:
        return
    usage_result, error = finish()
    if usage_result:
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = usage_result
        return
    if error:
        log_proxy_entry(
            proxy_log_path,
            "warn",
            "Model provider JSON usage extraction failed",
            type="usage_event",
            error=error,
        )


def finalize_model_sse_usage(flow: http.HTTPFlow) -> None:
    """Finalize incremental SSE model-provider usage extraction.

    Called from ``response()`` for normal completion and from ``error()`` to keep
    partial streamed usage when a connection fails. Pops
    ``_MODEL_SSE_USAGE_FINISH``, so repeated calls after the first are no-ops.
    The registered parser finalizer mutates the usage dictionary stored in
    ``metadata_keys.MODEL_PROVIDER_USAGE`` during response stream setup.
    """
    finish = flow.metadata.pop(_MODEL_SSE_USAGE_FINISH, None)
    if finish is not None:
        finish()


def _finish_connector_response_state(flow: http.HTTPFlow) -> None:
    finish = flow.metadata.pop(_CONNECTOR_RESPONSE_FINISH, None)
    if finish is not None:
        finish()


def finalize_connector_response_state(flow: http.HTTPFlow) -> None:
    """Finalize connector response parser state before connector usage reporting.

    Called from ``response()`` before ``usage.report_connector_usage()``. Clears
    the interrupted-report opt-in and pops ``_CONNECTOR_RESPONSE_FINISH``, so
    repeated calls after the first are no-ops. Connector-specific parser state
    is owned by the registered finish callback, for example X JSON or NDJSON
    usage metadata.
    """
    flow.metadata.pop(_CONNECTOR_RESPONSE_REPORT_ON_INTERRUPTION, None)
    _finish_connector_response_state(flow)


def finalize_interrupted_connector_response_state(flow: http.HTTPFlow) -> bool:
    """Finalize state when the active parser opted into interruption reporting.

    Returns whether the caller should run connector usage reporting. The parser
    finalizer handles decoder completion first, so an incomplete compressed body
    can invalidate best-effort state before the reporter observes it.
    """
    if not flow.metadata.pop(_CONNECTOR_RESPONSE_REPORT_ON_INTERRUPTION, False):
        return False
    _finish_connector_response_state(flow)
    return True


def release_response_stream_state(flow: http.HTTPFlow) -> None:
    """Release stream callbacks, buffers, and unfinalized parser state.

    Called by ``mitm_addon`` hook cleanup paths after ``response()``,
    ``error()``, and ``websocket_end()``. Safe to call repeatedly. This releases
    stream/parser state even when a 101 response keeps usage tracking alive
    until ``websocket_end()``. Removes ``_RESPONSE_STREAM_CALLBACK``,
    ``metadata_keys.RESPONSE_STREAM_STATE``, optional body-buffer metadata, and
    outstanding model or connector finish callbacks. Preserves externally
    replaced ``flow.response.stream`` callbacks and only disables the callback
    installed by this module.
    """
    stream_callback = flow.metadata.pop(_RESPONSE_STREAM_CALLBACK, None)
    flow.metadata.pop(metadata_keys.RESPONSE_STREAM_STATE, None)
    flow.metadata.pop(metadata_keys.STREAM_BUFFER, None)
    flow.metadata.pop(metadata_keys.STREAM_BUFFER_STATE, None)
    flow.metadata.pop(_MODEL_JSON_USAGE_FINISH, None)
    flow.metadata.pop(_MODEL_SSE_USAGE_FINISH, None)
    flow.metadata.pop(_CONNECTOR_RESPONSE_FINISH, None)
    flow.metadata.pop(_CONNECTOR_RESPONSE_REPORT_ON_INTERRUPTION, None)
    if stream_callback is not None and flow.response and flow.response.stream is stream_callback:
        flow.response.stream = False
