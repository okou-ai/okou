"""Tests for usage pending counters."""

import flow_metadata_keys as metadata_keys
import usage
from tests.pending_helpers import assert_pending
from tests.usage_buffer_helpers import RecordingEnqueue, event


def assert_counter_underflow_log(call, counter: str) -> None:
    message, fields = call.args
    assert message == (
        "Usage pending counter release had no matching admission; keeping counter non-negative."
    )
    assert fields == {
        "type": "usage_underbilling",
        "reason": "usage_pending_counter_underflow",
        "underbilling_class": "risk",
        "component": "mitm_addon",
        "counter": counter,
    }


class TestUsagePendingCounter:
    """Tests for usage pending counters."""

    def setup_method(self):
        usage.counters.reset_for_tests()

    def test_increment_decrement_in_flight_flows(self, tmp_path):
        control_root = tmp_path / "delivery-control"
        assert_pending(control_root, flows=0, buffered=0, reports=0)

        usage.increment_in_flight_flows()
        usage.increment_in_flight_flows()
        assert_pending(control_root, flows=2, buffered=0, reports=0)

        usage.decrement_in_flight_flows()
        assert_pending(control_root, flows=1, buffered=0, reports=0)

        usage.decrement_in_flight_flows()
        assert_pending(control_root, flows=0, buffered=0, reports=0)

    def test_pending_report_lease_release_drains_report(self, tmp_path):
        control_root = tmp_path / "delivery-control"
        lease = usage.counters.admit_pending_report()
        assert_pending(control_root, flows=0, buffered=0, reports=1)

        lease.release()

        assert_pending(control_root, flows=0, buffered=0, reports=0)

    def test_balanced_counter_releases_do_not_log_underflow(self, tmp_path, mitm_ctx):
        control_root = tmp_path / "delivery-control"

        with mitm_ctx() as mock_log:
            usage.increment_in_flight_flows()
            usage.decrement_in_flight_flows()
            pending_report = usage.counters.admit_pending_report()
            pending_report.release()

        assert mock_log.error.call_count == 0
        assert_pending(control_root, flows=0, buffered=0, reports=0)

    def test_set_buffered_usage_events(self, tmp_path):
        control_root = tmp_path / "delivery-control"
        usage.counters.set_buffered_usage_events(3)

        assert_pending(control_root, flows=0, buffered=3, reports=0)

        usage.counters.set_buffered_usage_events(0)
        assert_pending(control_root, flows=0, buffered=0, reports=0)

    def test_buffered_usage_blocks_pending_until_flush(self, tmp_path, real_flow, mitm_ctx):
        control_root = tmp_path / "delivery-control"
        enqueue = RecordingEnqueue(return_value=True)
        usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

        flow = real_flow(with_response=False, host="openrouter.ai")
        flow.metadata[metadata_keys.FIREWALL_NAME] = "model-provider:openrouter-codex"
        flow.metadata[metadata_keys.FIREWALL_BILLABLE] = True
        flow.metadata[metadata_keys.SANDBOX_AUTH_KEY] = "tok"
        flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH] = str(tmp_path / "proxy.jsonl")
        flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE] = {"tokens.input": 1}

        with mitm_ctx(api_url="https://api.test"):
            usage.report_model_provider_usage(flow, "run-1")
            assert_pending(control_root, flows=0, buffered=1, reports=0)
            enqueue.assert_not_called()

            assert usage.flush_usage_events(trigger="test") == 1
        enqueue.assert_called_once()
        assert_pending(control_root, flows=0, buffered=0, reports=0)

    def test_saturated_usage_flush_keeps_buffered_pending_snapshot(self, tmp_path):
        control_root = tmp_path / "delivery-control"
        enqueue = RecordingEnqueue(return_value=False)
        usage.reset_usage_buffer_for_tests(enqueue_webhook=enqueue)

        usage.buffer_usage_events(
            "https://api.test/api/webhooks/agent/usage-event",
            "token-a",
            "run-1",
            [event(source_key="source-1")],
            str(tmp_path / "proxy.jsonl"),
        )

        assert usage.flush_usage_events(trigger="runner") == 0

        assert_pending(control_root, flows=0, buffered=1, reports=0)

        enqueue.return_value = True
        enqueue.clear()
        assert usage.flush_usage_events(trigger="runner") == 1
        assert_pending(control_root, flows=0, buffered=0, reports=0)

    def test_flow_decrement_underflow_stays_non_negative_and_logs_once(self, tmp_path, mitm_ctx):
        control_root = tmp_path / "delivery-control"

        with mitm_ctx() as mock_log:
            usage.decrement_in_flight_flows()
            usage.decrement_in_flight_flows()

        assert_pending(control_root, flows=0, buffered=0, reports=0)

        assert mock_log.error.call_count == 1
        assert_counter_underflow_log(mock_log.error.call_args, "flows")
        assert mock_log.warn.call_count == 0

    def test_report_lease_double_release_logs_without_decrementing_other_reports(
        self,
        tmp_path,
        mitm_ctx,
    ):
        control_root = tmp_path / "delivery-control"
        first = usage.counters.admit_pending_report()
        second = usage.counters.admit_pending_report()
        assert_pending(control_root, flows=0, buffered=0, reports=2)

        with mitm_ctx() as mock_log:
            first.release()
            first.release()

        assert_pending(control_root, flows=0, buffered=0, reports=1)
        assert mock_log.error.call_count == 1
        assert_counter_underflow_log(mock_log.error.call_args, "reports")

        second.release()
        assert_pending(control_root, flows=0, buffered=0, reports=0)

    def test_reset_for_tests_reenables_counter_underflow_signal(self, tmp_path, mitm_ctx):

        with mitm_ctx() as mock_log:
            usage.decrement_in_flight_flows()
            usage.counters.reset_for_tests()
            usage.decrement_in_flight_flows()

        assert mock_log.error.call_count == 2
        assert_counter_underflow_log(mock_log.error.call_args_list[0], "flows")
        assert_counter_underflow_log(mock_log.error.call_args_list[1], "flows")
