"""Response stream buffering integration tests."""

from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import stream_capture
from body_limits import STREAM_BUFFER_LIMIT
from tests.flow_helpers import header_map, response_stream
from tests.stream_buffer_helpers import response_stream_capture


class TestResponseStreamBuffer:
    """Tests for generic response stream buffering behavior."""

    def _json_response_flow(
        self,
        real_flow,
        *,
        host: str = "api.example.com",
        capture_body: bool = True,
    ) -> http.HTTPFlow:
        flow = real_flow(with_response=False, host=host)
        if capture_body:
            flow.metadata[metadata_keys.CAPTURE_BODY] = True
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        return flow

    def test_stream_callback_buffers_chunks(self, real_flow):
        flow = self._json_response_flow(real_flow)

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        assert callback(b"hello ") == b"hello "
        assert callback(b"world") == b"world"
        assert bytes(response_stream_capture(flow).buffer) == b"hello world"
        assert response_stream_capture(flow).truncated is False

    def test_stream_callback_stops_buffering_at_limit(self, real_flow):
        flow = self._json_response_flow(real_flow)

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        chunk = b"x" * STREAM_BUFFER_LIMIT
        assert callback(chunk) == chunk
        assert len(response_stream_capture(flow).buffer) == STREAM_BUFFER_LIMIT
        assert response_stream_capture(flow).truncated is False

        assert callback(b"overflow") == b"overflow"
        assert len(response_stream_capture(flow).buffer) == STREAM_BUFFER_LIMIT
        assert response_stream_capture(flow).truncated is True

    def test_stream_callback_large_single_chunk(self, real_flow):
        flow = self._json_response_flow(real_flow)

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        big_chunk = b"A" * (STREAM_BUFFER_LIMIT + 1000)
        assert callback(big_chunk) == big_chunk
        assert len(response_stream_capture(flow).buffer) == STREAM_BUFFER_LIMIT
        assert response_stream_capture(flow).truncated is True

    def test_stream_callback_partial_fill_then_overflow(self, real_flow):
        flow = self._json_response_flow(real_flow)

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        half = STREAM_BUFFER_LIMIT // 2
        callback(b"A" * half)
        assert response_stream_capture(flow).truncated is False

        callback(b"B" * STREAM_BUFFER_LIMIT)
        remaining = STREAM_BUFFER_LIMIT - half
        assert len(response_stream_capture(flow).buffer) == STREAM_BUFFER_LIMIT
        assert response_stream_capture(flow).buffer[:half] == bytearray(b"A" * half)
        assert response_stream_capture(flow).buffer[half:] == bytearray(b"B" * remaining)
        assert response_stream_capture(flow).truncated is True

    def test_stream_callback_empty_chunk(self, real_flow):
        flow = self._json_response_flow(real_flow)

        mitm_addon.responseheaders(flow)

        callback = response_stream(flow)
        assert callback(b"") == b""
        assert len(response_stream_capture(flow).buffer) == 0
        assert response_stream_capture(flow).truncated is False

        callback(b"hello")
        assert bytes(response_stream_capture(flow).buffer) == b"hello"

    def test_non_capture_response_does_not_retain_body_prefix(self, real_flow):
        flow = self._json_response_flow(
            real_flow,
            host="api.github.com",
            capture_body=False,
        )

        mitm_addon.responseheaders(flow)

        body = b"x" * (STREAM_BUFFER_LIMIT + 1000)
        assert response_stream(flow)(body) == body

        assert stream_capture.captured_response_stream_body(flow) is None
        assert flow.metadata[metadata_keys.RESPONSE_STREAM_STATE]["total_bytes"] == len(body)

    def test_billable_connector_without_body_parser_does_not_retain_prefix(self, real_flow):
        flow = self._json_response_flow(
            real_flow,
            host="api.gamma.example",
            capture_body=False,
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = "gamma"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True

        mitm_addon.responseheaders(flow)

        response_stream(flow)(b"g" * (STREAM_BUFFER_LIMIT + 1000))

        assert stream_capture.captured_response_stream_body(flow) is None
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
