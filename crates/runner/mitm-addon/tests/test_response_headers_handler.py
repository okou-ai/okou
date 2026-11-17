"""Tests for the mitm addon responseheaders hook."""

from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import stream_capture
from tests.flow_helpers import header_map, response_stream


class TestResponseHeadersHandler:
    """Tests for the responseheaders() hook contract."""

    def test_enables_streaming_without_body_buffer(self, real_flow):
        """Ordinary responses should stream with metrics but no retained prefix."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert flow.metadata[metadata_keys.RESPONSE_STREAM_STATE] == {"total_bytes": 0}
        assert stream_capture.captured_response_stream_body(flow) is None

    def test_capture_body_also_streams(self, real_flow):
        """When capture_body is set, streaming should still be enabled."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )
        flow.metadata[metadata_keys.CAPTURE_BODY] = True

        mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert flow.metadata[metadata_keys.RESPONSE_STREAM_STATE] == {"total_bytes": 0}
        assert stream_capture.captured_response_stream_body(flow) is not None

    def test_no_response_is_noop(self, real_flow):
        """Flow without response should not raise."""
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = None

        mitm_addon.responseheaders(flow)

        assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
