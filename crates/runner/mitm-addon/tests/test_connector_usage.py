"""Tests for X connector response parser routing."""

import pytest

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.flow_helpers import header_map, response_stream
from tests.repeated_bytes_helpers import repeat_bytes
from tests.x_flow_helpers import make_x_response_flow


class TestXStreamPathRouting:
    """Tests for stream path routing through responseheaders (issue #9534)."""

    def _make_x_response_flow(self, real_flow, path: str):
        flow = make_x_response_flow(real_flow, path=path)
        flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] = "already_stream_decodable"
        return flow

    @pytest.mark.parametrize(
        "path",
        [
            "/2/tweets/search/stream",
            "/2/tweets/sample/stream",
            "/2/tweets/sample10/stream",
            "/2/tweets/compliance/stream",
            "/2/users/compliance/stream",
        ],
    )
    def test_stream_endpoints_register_ndjson_parser(self, real_flow, path):
        flow = self._make_x_response_flow(real_flow, path)

        mitm_addon.responseheaders(flow)

        assert metadata_keys.X_NDJSON_STATE in flow.metadata
        assert "connector_response_finish" in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    def test_absolute_form_request_target_registers_ndjson_parser_from_original_url(
        self, real_flow
    ):
        flow = self._make_x_response_flow(
            real_flow,
            "/2/tweets/search/stream?tweet.fields=id",
        )
        flow.request.path = "https://api.x.com/2/tweets/search/stream?tweet.fields=id"

        mitm_addon.responseheaders(flow)

        assert metadata_keys.X_NDJSON_STATE in flow.metadata
        assert "connector_response_finish" in flow.metadata

    def test_stream_parser_requires_original_url(self, real_flow):
        flow = self._make_x_response_flow(real_flow, "/2/tweets/search/stream")
        flow.metadata.pop(metadata_keys.ORIGINAL_URL)

        with pytest.raises(ValueError, match="original_url"):
            mitm_addon.responseheaders(flow)

    @pytest.mark.parametrize(
        "path",
        [
            "/2/tweets/search/stream/rules",
            "/2/tweets/search/recent",
            "/2/users/by",
            "/2/tweets/1",
            "",
            "/",
        ],
    )
    def test_non_stream_paths_register_json_parser(self, real_flow, path):
        flow = self._make_x_response_flow(real_flow, path)

        mitm_addon.responseheaders(flow)

        assert metadata_keys.X_NDJSON_STATE not in flow.metadata
        assert "connector_response_finish" in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    def test_stream_error_response_does_not_retain_body_prefix(self, real_flow):
        flow = make_x_response_flow(
            real_flow,
            path="/2/tweets/search/stream",
            response_status=401,
        )

        mitm_addon.responseheaders(flow)

        assert metadata_keys.X_NDJSON_STATE not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
        callback = response_stream(flow)
        callback(repeat_bytes(b'{"title":"Unauthorized","detail":"', b"x", 200 * 1024, b'"}'))
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    @pytest.mark.parametrize("path", ["/2/tweets", "/2/tweets/search/stream"])
    @pytest.mark.parametrize("firewall_billable", [False, None])
    def test_non_billable_x_responses_do_not_register_connector_parser(
        self,
        real_flow,
        path,
        firewall_billable,
    ):
        flow = make_x_response_flow(real_flow, path=path, firewall_billable=firewall_billable)
        if firewall_billable is None:
            flow.metadata.pop(metadata_keys.FIREWALL_BILLABLE)

        mitm_addon.responseheaders(flow)

        response_stream(flow)(b"x" * (65 * 1024))

        assert "connector_response_finish" not in flow.metadata
        assert metadata_keys.X_NDJSON_STATE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    def test_brotli_stream_path_registers_response_body_parser(self, real_flow, mitm_ctx):
        flow = self._make_x_response_flow(real_flow, "/2/tweets/search/stream")
        assert flow.response is not None
        flow.response.headers = header_map(
            {"content-type": "application/json", "content-encoding": "br"}
        )

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        assert callable(response_stream(flow))
        assert metadata_keys.X_NDJSON_STATE in flow.metadata
        assert "connector_response_finish" in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    def test_unregistered_parser_factory_does_not_require_original_url(self, real_flow):
        flow = self._make_x_response_flow(real_flow, "/2/tweets/search/stream")
        flow.metadata[metadata_keys.FIREWALL_NAME] = "github"
        flow.metadata.pop(metadata_keys.ORIGINAL_URL)

        mitm_addon.responseheaders(flow)

        assert metadata_keys.X_NDJSON_STATE not in flow.metadata
        assert "connector_response_finish" not in flow.metadata
