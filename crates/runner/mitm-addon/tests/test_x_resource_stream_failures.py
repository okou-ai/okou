"""Keep completed X stream observations stable across decode failures and UTC dates."""

import uuid
import zlib
from datetime import UTC, datetime, timedelta

import pytest
from mitmproxy.flow import Error

import mitm_addon
import usage
from tests.flow_helpers import response_stream
from tests.x_flow_helpers import make_x_pipeline_flow
from usage.providers.connectors import x_resources


@pytest.fixture(autouse=True)
def _inline_delivery(sync_usage_executor):
    pass


def _stream_flow(real_flow, tmp_path, *, encoding=""):
    return make_x_pipeline_flow(
        real_flow,
        tmp_path,
        path="/2/tweets/search/stream",
        sandbox_run_id=str(uuid.uuid4()),
        content_encoding=encoding,
    )


@pytest.mark.parametrize("tail_failure", ["truncated_gzip", "corrupt_gzip", "malformed_json"])
@pytest.mark.parametrize("interrupted", [False, True])
def test_completed_compressed_row_survives_tail_failure_without_terminal_rebilling(
    real_flow, tmp_path, usage_webhook_api, tail_failure, interrupted
):
    flow = _stream_flow(real_flow, tmp_path, encoding="gzip")
    compressor = zlib.compressobj(wbits=16 + zlib.MAX_WBITS)
    first_chunk = compressor.compress(b'{"data":{"id":"001"}}\n')
    first_chunk += compressor.flush(zlib.Z_SYNC_FLUSH)
    tail = b'{"data":' if tail_failure == "malformed_json" else b'{"data":{"id":"2"}}'
    final_chunk = compressor.compress(tail) + compressor.flush(zlib.Z_FINISH)
    if tail_failure == "truncated_gzip":
        final_chunk = final_chunk[:-1]
    elif tail_failure == "corrupt_gzip":
        corrupted = bytearray(final_chunk)
        corrupted[-8] ^= 1  # Corrupt the gzip CRC after the complete row was observed.
        final_chunk = bytes(corrupted)

    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        stream(first_chunk)
        usage.flush_usage_events(trigger="test")
        (observed,) = webhook.usage_events()
        assert observed["protocol"] == "x-resource-v1"
        assert observed["quantity"] == 1
        assert observed["resources"] == [{"id": "001", "occurrences": 1}]
        assert observed["remainder"] == []

        stream(final_chunk)
        if interrupted:
            flow.error = Error("compressed stream interrupted after the first row")
            mitm_addon.error(flow)
        else:
            stream(b"")
            mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")
        # Duplicate lifecycle hooks must not recreate the source or bill aggregate counts.
        mitm_addon.response(flow)
        flow.error = Error("duplicate terminal notification")
        mitm_addon.error(flow)
        usage.flush_usage_events(trigger="test")

    assert webhook.usage_events() == [observed]
    assert webhook.request_count == 1


def test_resource_rows_crossing_midnight_are_sent_in_separate_date_batches(
    real_flow, tmp_path, usage_webhook_api, monkeypatch
):
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)

    class Clock(datetime):
        value = today - timedelta(milliseconds=1)

        @classmethod
        def now(cls, tz=None):
            return cls.value

    monkeypatch.setattr(x_resources, "datetime", Clock)
    flow = _stream_flow(real_flow, tmp_path)
    with usage_webhook_api() as webhook:
        mitm_addon.responseheaders(flow)
        stream = response_stream(flow)
        stream(b'{"data":{"id":"1"}}\n')
        Clock.value = today
        stream(b'{"data":{"id":"1"}}\n')
        stream(b"")
        mitm_addon.response(flow)
        usage.flush_usage_events(trigger="test")

    bodies = webhook.json_bodies()
    assert len(bodies) == 2
    assert all(len(body["events"]) == 1 for body in bodies)
    events = webhook.usage_events()
    assert [event["observedAt"] for event in events] == [
        (today - timedelta(milliseconds=1))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        today.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    ]
    assert len({event["idempotencyKey"] for event in events}) == 2
    assert all(event["protocol"] == "x-resource-v1" for event in events)
    assert all(event["resources"] == [{"id": "1", "occurrences": 1}] for event in events)
