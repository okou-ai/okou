"""Response stream state release integration tests."""

import pytest
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
import response_streaming
from tests.flow_helpers import header_map, response_stream


class TestReleaseResponseStreamState:
    """Tests for direct response streaming cleanup."""

    def test_preserves_externally_replaced_stream_callback(self, real_flow):
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        def external_stream(chunk):
            return chunk

        mitm_addon.responseheaders(flow)
        assert callable(response_stream(flow))

        flow.response.stream = external_stream

        response_streaming.release_response_stream_state(flow)

        assert flow.response.stream is external_stream
        assert "_response_stream_callback" not in flow.metadata
        assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    @pytest.mark.parametrize(
        (
            "host",
            "path",
            "response_content_type",
            "metadata",
            "finish_key",
            "reports_on_interruption",
        ),
        [
            pytest.param(
                "api.anthropic.com",
                "/v1/messages",
                "application/json",
                {
                    metadata_keys.FIREWALL_NAME: "model-provider:claude-code-oauth-token",
                    metadata_keys.FIREWALL_BILLABLE: False,
                },
                "model_json_usage_finish",
                False,
                id="model-json",
            ),
            pytest.param(
                "openrouter.ai",
                "/api/v1/responses",
                "text/event-stream",
                {
                    metadata_keys.FIREWALL_NAME: "model-provider:openrouter-codex",
                    metadata_keys.CLI_AGENT_TYPE: "codex",
                    metadata_keys.FIREWALL_BILLABLE: True,
                    metadata_keys.MODEL_USAGE_PROVIDER: "gpt-5.5",
                },
                "model_sse_usage_finish",
                False,
                id="model-sse",
            ),
            pytest.param(
                "api.x.com",
                "/2/tweets",
                "application/json",
                {
                    metadata_keys.FIREWALL_NAME: "x",
                    metadata_keys.FIREWALL_BILLABLE: True,
                    metadata_keys.ORIGINAL_URL: "https://api.x.com/2/tweets",
                },
                "connector_response_finish",
                False,
                id="x-json",
            ),
            pytest.param(
                "api.x.com",
                "/2/tweets/search/stream",
                "application/json",
                {
                    metadata_keys.FIREWALL_NAME: "x",
                    metadata_keys.FIREWALL_BILLABLE: True,
                    metadata_keys.ORIGINAL_URL: "https://api.x.com/2/tweets/search/stream",
                },
                "connector_response_finish",
                True,
                id="x-ndjson",
            ),
        ],
    )
    def test_removes_unfinalized_parser_finish_callback(
        self,
        real_flow,
        host,
        path,
        response_content_type,
        metadata,
        finish_key,
        reports_on_interruption,
    ):
        flow = real_flow(with_response=False, host=host, path=path)
        flow.metadata.update(metadata)
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map({"content-type": response_content_type}),
        )

        mitm_addon.responseheaders(flow)
        assert finish_key in flow.metadata
        assert (
            "connector_response_report_on_interruption" in flow.metadata
        ) is reports_on_interruption

        response_streaming.release_response_stream_state(flow)

        assert finish_key not in flow.metadata
        assert "connector_response_report_on_interruption" not in flow.metadata
        assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
        assert flow.response.stream is False

    def test_unconfigured_flow_is_noop(self, real_flow):
        flow = real_flow(with_response=True, host="api.example.com")

        def external_stream(chunk):
            return chunk

        assert flow.response is not None
        flow.response.stream = external_stream

        response_streaming.release_response_stream_state(flow)

        assert flow.response.stream is external_stream

    def test_configured_release_is_idempotent(self, real_flow):
        flow = real_flow(with_response=False, host="api.example.com")
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)
        assert callable(response_stream(flow))

        response_streaming.release_response_stream_state(flow)
        response_streaming.release_response_stream_state(flow)

        assert flow.response.stream is False
        assert "_response_stream_callback" not in flow.metadata
        assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    def test_release_after_response_is_removed_still_drops_metadata(self, real_flow):
        flow = real_flow(with_response=False, host="api.anthropic.com")
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:claude-code-oauth-token"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
        flow.response = tutils.tresp(
            status_code=200, headers=header_map({"content-type": "application/json"})
        )

        mitm_addon.responseheaders(flow)
        assert callable(response_stream(flow))
        assert "model_json_usage_finish" in flow.metadata

        flow.response = None

        response_streaming.release_response_stream_state(flow)

        assert flow.response is None
        assert "_response_stream_callback" not in flow.metadata
        assert metadata_keys.RESPONSE_STREAM_STATE not in flow.metadata
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
        assert "model_json_usage_finish" not in flow.metadata
