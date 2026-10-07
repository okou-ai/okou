"""Response encoding inspection risk integration tests."""

import pytest
from mitmproxy import http
from mitmproxy.test import tutils

import flow_metadata_keys as metadata_keys
import mitm_addon
from tests.flow_helpers import header_map, response_stream
from tests.jsonl_log_helpers import jsonl_exists_after_flush, read_jsonl_entries_after_flush
from tests.x_flow_helpers import make_x_pipeline_flow


class TestResponseEncodingInspectionRisk:
    """Tests structured risk signals at the actual response decoder gate."""

    def _model_flow(
        self,
        real_flow,
        tmp_path,
        *,
        content_encoding: str,
        content_type: str = "application/json",
    ) -> http.HTTPFlow:
        flow = real_flow(
            with_response=False,
            host="openrouter.ai",
            path="/api/v1/responses",
            method="POST",
        )
        flow.response = tutils.tresp(
            status_code=200,
            headers=header_map(
                {
                    "content-type": content_type,
                    "content-encoding": content_encoding,
                }
            ),
        )
        flow.metadata.update(
            {
                metadata_keys.SANDBOX_RUN_ID: "run-encoding-risk",
                metadata_keys.SANDBOX_PROXY_LOG_PATH: str(tmp_path / "proxy.jsonl"),
                metadata_keys.FIREWALL_NAME: "model-provider:openrouter-codex",
                metadata_keys.FIREWALL_BILLABLE: True,
                metadata_keys.MODEL_USAGE_PROVIDER: "gpt-5.5",
                metadata_keys.RESPONSE_ENCODING_NEGOTIATION: "rewritten_stream_decodable",
            }
        )
        return flow

    @pytest.mark.parametrize(
        (
            "content_encoding",
            "content_type",
            "decode_skip_reason",
            "rejected",
            "buffered_fallback",
        ),
        [
            pytest.param(
                "zstd",
                "application/json",
                "zstd streaming output cannot be hard-bounded",
                False,
                True,
                id="model-json-zstd",
            ),
            pytest.param(
                "private-encoding-value",
                "application/json",
                "unsupported content encoding",
                True,
                False,
                id="model-json-unknown",
            ),
        ],
    )
    def test_billable_model_provider_rejects_only_without_accounting_fallback(
        self,
        real_flow,
        tmp_path,
        mitm_ctx,
        content_encoding: str,
        content_type: str,
        decode_skip_reason: str,
        rejected: bool,
        buffered_fallback: bool,
    ) -> None:
        flow = self._model_flow(
            real_flow,
            tmp_path,
            content_encoding=content_encoding,
            content_type=content_type,
        )

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        if rejected:
            [entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
            assert entry["type"] == "usage_underbilling"
            assert entry["reason"] == "response_encoding_not_stream_decodable"
            assert entry["underbilling_class"] == "risk"
            assert entry["component"] == "mitm_addon"
            assert entry["run_id"] == "run-encoding-risk"
            assert entry["firewall_name"] == "model-provider:openrouter-codex"
            assert entry["firewall_billable"] is True
            assert entry["status_code"] == 200
            assert entry["inspection_disposition"] == "fail_closed"
            assert entry["request_encoding_negotiation"] == "rewritten_stream_decodable"
            assert entry["decode_skip_reason"] == decode_skip_reason
        else:
            assert not jsonl_exists_after_flush(tmp_path / "proxy.jsonl")
        upstream_chunk = b"compressed-upstream"
        assert response_stream(flow)(upstream_chunk) == (b"" if rejected else upstream_chunk)
        assert flow.response is not None
        assert flow.response.status_code == (502 if rejected else 200)
        assert (metadata_keys.STREAM_BUFFER in flow.metadata) is buffered_fallback
        assert (metadata_keys.STREAM_BUFFER_STATE in flow.metadata) is buffered_fallback

    def test_unknown_encoding_value_is_not_persisted(self, real_flow, tmp_path, mitm_ctx) -> None:
        flow = self._model_flow(
            real_flow,
            tmp_path,
            content_encoding="private-encoding-value",
        )

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        [entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert "private-encoding-value" not in str(entry)
        assert entry["decode_skip_reason"] == "unsupported content encoding"
        assert entry["request_encoding_negotiation"] == "rewritten_stream_decodable"
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert response_stream(flow)(b"unknown-encoding-body") == b""
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    @pytest.mark.parametrize("content_encoding", ["gzip", "br"])
    def test_stream_safe_model_response_keeps_parser_without_risk(
        self, real_flow, tmp_path, mitm_ctx, content_encoding: str
    ) -> None:
        flow = self._model_flow(real_flow, tmp_path, content_encoding=content_encoding)

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        assert "model_json_usage_finish" in flow.metadata
        assert not jsonl_exists_after_flush(tmp_path / "proxy.jsonl")

    def test_non_billable_model_sse_keeps_pass_through(self, real_flow, tmp_path, mitm_ctx) -> None:
        flow = self._model_flow(
            real_flow,
            tmp_path,
            content_encoding="br",
            content_type="text/event-stream",
        )
        flow.request.host = "api.anthropic.com"
        flow.request.path = "/v1/messages"
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:claude-code-oauth-token"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = False
        flow.metadata.pop(metadata_keys.MODEL_USAGE_PROVIDER)

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        assert not jsonl_exists_after_flush(tmp_path / "proxy.jsonl")
        assert flow.response is not None
        assert flow.response.status_code == 200
        upstream_chunk = b"non-billable-brotli"
        assert response_stream(flow)(upstream_chunk) == upstream_chunk

    def test_unsuccessful_billable_model_sse_keeps_pass_through(
        self, real_flow, tmp_path, mitm_ctx
    ) -> None:
        flow = self._model_flow(
            real_flow,
            tmp_path,
            content_encoding="br",
            content_type="text/event-stream",
        )
        assert flow.response is not None
        flow.response.status_code = 429

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        assert not jsonl_exists_after_flush(tmp_path / "proxy.jsonl")
        assert flow.response.status_code == 429
        upstream_chunk = b"upstream-error-brotli"
        assert response_stream(flow)(upstream_chunk) == upstream_chunk

    def test_billable_model_without_canonical_model_still_rejects_uninspectable_response(
        self, real_flow, tmp_path, mitm_ctx
    ) -> None:
        flow = self._model_flow(real_flow, tmp_path, content_encoding="private-encoding-value")
        flow.metadata.pop(metadata_keys.MODEL_USAGE_PROVIDER)

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        [entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert entry["reason"] == "response_encoding_not_stream_decodable"
        assert entry["firewall_billable"] is True
        assert entry["inspection_disposition"] == "fail_closed"
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert response_stream(flow)(b"uninspectable-model-response") == b""
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    @pytest.mark.parametrize(
        ("request_method", "response_status"),
        [
            pytest.param("GET", 101, id="informational"),
            pytest.param("GET", 204, id="no-content"),
            pytest.param("GET", 205, id="reset-content"),
            pytest.param("GET", 304, id="not-modified"),
            pytest.param("HEAD", 200, id="head"),
            pytest.param("CONNECT", 200, id="successful-connect"),
        ],
    )
    def test_bodyless_model_response_does_not_log_encoding_risk(
        self,
        real_flow,
        tmp_path,
        mitm_ctx,
        request_method: str,
        response_status: int,
    ) -> None:
        flow = self._model_flow(real_flow, tmp_path, content_encoding="zstd")
        flow.request.method = request_method
        assert flow.response is not None
        flow.response.status_code = response_status

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        assert not jsonl_exists_after_flush(tmp_path / "proxy.jsonl")
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    def test_successful_billable_connector_uses_bounded_fallback_without_encoding_risk(
        self, real_flow, tmp_path, mitm_ctx
    ) -> None:
        flow = make_x_pipeline_flow(real_flow, tmp_path, content_encoding="zstd")

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        assert not jsonl_exists_after_flush(tmp_path / "proxy.jsonl")
        assert flow.response is not None
        assert flow.response.status_code == 200
        upstream_chunk = b"bounded-json-fallback"
        assert response_stream(flow)(upstream_chunk) == upstream_chunk
        assert metadata_keys.STREAM_BUFFER in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE in flow.metadata

    @pytest.mark.parametrize(
        "negotiation_outcome",
        ["preserved_client_constraints", "preserved_work_budget"],
    )
    def test_unknown_connector_encoding_does_not_retain_unusable_fallback(
        self, real_flow, tmp_path, mitm_ctx, negotiation_outcome: str
    ) -> None:
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            content_encoding="private-encoding-value",
        )
        flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] = negotiation_outcome

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        [entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert entry["reason"] == "response_encoding_not_stream_decodable"
        assert entry["decode_skip_reason"] == "unsupported content encoding"
        assert entry["firewall_billable"] is True
        assert entry["inspection_disposition"] == "fail_closed"
        assert entry["request_encoding_negotiation"] == negotiation_outcome
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert response_stream(flow)(b"unknown-connector-encoding") == b""
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    def test_billable_connector_stream_rejects_non_streamable_encoding(
        self,
        real_flow,
        tmp_path,
        mitm_ctx,
    ) -> None:
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            path="/2/tweets/search/stream",
            rule="GET /2/tweets/search/stream",
            content_encoding="zstd",
        )
        flow.metadata[metadata_keys.RESPONSE_ENCODING_NEGOTIATION] = "rewritten_stream_decodable"

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        [entry] = read_jsonl_entries_after_flush(tmp_path / "proxy.jsonl")
        assert entry["reason"] == "response_encoding_not_stream_decodable"
        assert entry["firewall_billable"] is True
        assert entry["inspection_disposition"] == "fail_closed"
        assert entry["request_encoding_negotiation"] == "rewritten_stream_decodable"
        assert flow.response is not None
        assert flow.response.status_code == 502
        assert response_stream(flow)(b"compressed-ndjson") == b""
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata

    @pytest.mark.parametrize(
        ("firewall_name", "firewall_billable", "response_status"),
        [
            pytest.param("x", False, 200, id="non-billable"),
            pytest.param("stripe", True, 200, id="no-registered-parser"),
            pytest.param("x", True, 400, id="unsuccessful-response"),
            pytest.param("x", True, 204, id="bodyless-response"),
        ],
    )
    def test_non_inspected_connector_does_not_log_encoding_risk(
        self,
        real_flow,
        tmp_path,
        mitm_ctx,
        firewall_name: str,
        firewall_billable: bool,
        response_status: int,
    ) -> None:
        flow = make_x_pipeline_flow(
            real_flow,
            tmp_path,
            response_status=response_status,
            content_encoding="zstd",
        )
        flow.metadata[metadata_keys.FIREWALL_NAME] = firewall_name
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = firewall_billable

        with mitm_ctx():
            mitm_addon.responseheaders(flow)

        assert not jsonl_exists_after_flush(tmp_path / "proxy.jsonl")
        assert flow.response is not None
        assert flow.response.status_code == response_status
        assert metadata_keys.STREAM_BUFFER not in flow.metadata
        assert metadata_keys.STREAM_BUFFER_STATE not in flow.metadata
