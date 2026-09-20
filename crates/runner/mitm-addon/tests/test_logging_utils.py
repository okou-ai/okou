"""Tests for mitm addon logging utilities."""

import json
from datetime import UTC, datetime
from unittest.mock import patch

import pytest

import flow_metadata_keys as metadata_keys
import logging_utils
from tests.jsonl_log_helpers import read_jsonl_entries_after_flush
from tests.process_log_helpers import capture_addon_process_events
from tests.timestamp_helpers import assert_utc_millisecond_timestamp


def _read_jsonl_entries_without_flush(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


class TestLogNetworkEntry:
    def test_writes_jsonl_with_current_utc_timestamp(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")
        entry = {"action": "ALLOW", "host": "example.com"}
        current_time = datetime(2026, 8, 24, 2, 16, 45, 678_901, tzinfo=UTC)

        with (
            patch.object(logging_utils, "datetime") as clock,
            capture_addon_process_events(),
        ):
            clock.now.return_value = current_time
            logging_utils.log_network_entry(log_path, entry)

        entries = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert len(entries) == 1
        parsed = entries[0]
        clock.now.assert_called_once_with(UTC)
        assert parsed["action"] == "ALLOW"
        assert parsed["host"] == "example.com"
        assert parsed["timestamp"] == "2026-08-24T02:16:45.678Z"
        assert "timestamp" not in entry

    def test_timestamp_is_authoritative(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")
        entry = {"timestamp": "caller-timestamp", "action": "ALLOW"}

        with capture_addon_process_events():
            logging_utils.log_network_entry(log_path, entry)

        [parsed] = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert_utc_millisecond_timestamp(parsed["timestamp"])
        assert parsed["timestamp"] != "caller-timestamp"
        assert entry["timestamp"] == "caller-timestamp"

    def test_appends_multiple(self, tmp_path):
        log_path = str(tmp_path / "net.jsonl")

        with capture_addon_process_events():
            logging_utils.log_network_entry(log_path, {"n": 1})
            logging_utils.log_network_entry(log_path, {"n": 2})

        entries = read_jsonl_entries_after_flush(tmp_path / "net.jsonl")
        assert len(entries) == 2

    def test_no_path_is_noop(self):
        with capture_addon_process_events() as log:
            logging_utils.log_network_entry("", {"payload": b"binary"})

        log.warn.assert_not_called()

    def test_missing_parent_path_warns_and_does_not_raise(self, tmp_path):
        log_path = tmp_path / "missing" / "net.jsonl"
        with capture_addon_process_events() as log:
            logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})
            logging_utils.flush_log_path(str(log_path))

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Failed to write network log:" in warning
        assert "FileNotFoundError" in warning

    def test_non_serializable_entry_warns_without_creating_file(self, tmp_path):
        log_path = tmp_path / "net.jsonl"
        with capture_addon_process_events() as log:
            logging_utils.log_network_entry(str(log_path), {"payload": b"binary"})

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Failed to encode network log: TypeError:" in warning
        logging_utils.flush_log_path(str(log_path))
        assert not log_path.exists()

    def test_full_backlog_warns_without_creating_file(self, tmp_path):
        log_path = tmp_path / "net.jsonl"
        with (
            patch.object(logging_utils.jsonl_writer, "MAX_PENDING_JSONL_BYTES", 1),
            capture_addon_process_events() as log,
        ):
            logging_utils.log_network_entry(str(log_path), {"action": "ALLOW"})

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert warning == "Dropping network log because the JSONL writer backlog is full"
        logging_utils.flush_log_path(str(log_path))
        assert not log_path.exists()


class TestLogProxyEntry:
    def test_writes_jsonl(self, tmp_path):
        proxy_path = str(tmp_path / "proxy-test.jsonl")
        logging_utils.log_proxy_entry(proxy_path, "warn", "test message", extra_field="value")
        [entry] = read_jsonl_entries_after_flush(tmp_path / "proxy-test.jsonl")
        assert entry["level"] == "warn"
        assert entry["message"] == "test message"
        assert entry["extra_field"] == "value"
        assert_utc_millisecond_timestamp(entry["timestamp"])

    @pytest.mark.parametrize(
        ("raw_url", "expected_url"),
        [
            pytest.param(
                "https://user:pass@example.com/v1/search?token=secret#fragment",
                "https://example.com/v1/search",
                id="absolute",
            ),
            pytest.param(
                "//user:pass@example.com/v1/search?token=secret#fragment",
                "//example.com/v1/search",
                id="protocol-relative",
            ),
            pytest.param(
                "https:////user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="extra-slashes",
            ),
            pytest.param(
                "https:///user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="three-slashes",
            ),
            pytest.param(
                "https:/user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="one-slash",
            ),
            pytest.param(
                "https:user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="no-slashes",
            ),
            pytest.param(
                "HTTP:////user:pass@example.com/path?token=secret#fragment",
                "http://example.com/path",
                id="case-insensitive-http-scheme",
            ),
            pytest.param(
                r"https:\\user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="reverse-solidus",
            ),
            pytest.param(
                r"https:/\\user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="mixed-separators",
            ),
            pytest.param(
                r"https://\/user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="separator-only-netloc",
            ),
            pytest.param(
                "///user:pass@example.com/path?token=secret#fragment",
                "//example.com/path",
                id="extra-protocol-relative-slash",
            ),
            pytest.param(
                r"//\/user:pass@example.com/path?token=secret#fragment",
                "//example.com/path",
                id="separator-only-protocol-relative-netloc",
            ),
            pytest.param(
                "\x00 https:////user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="leading-c0-and-space",
            ),
            pytest.param(
                "h\tt\rtp\ns:////user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="embedded-urlsplit-controls",
            ),
            pytest.param(
                "https: //user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="space-before-separators",
            ),
            pytest.param(
                "https:\v//user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="vertical-tab-before-separators",
            ),
            pytest.param(
                "https:\f//user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="form-feed-before-separators",
            ),
            pytest.param(
                "https:// /user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="space-inside-separator-prefix",
            ),
            pytest.param(
                "https:////first@user:pass@example.com/path?token=secret#fragment",
                "https://example.com/path",
                id="multiple-at-signs",
            ),
            pytest.param(
                "https:////user:pass@example.com?token=secret#fragment",
                "https://example.com",
                id="empty-path",
            ),
            pytest.param(
                "https:////user:pass@example.com/?token=secret#fragment",
                "https://example.com/",
                id="root-path",
            ),
            pytest.param(
                "https://example.com/users/alice@example.com?token=secret#fragment",
                "https://example.com/users/alice@example.com",
                id="at-sign-in-valid-path",
            ),
        ],
    )
    def test_sanitizes_structured_url_field(self, tmp_path, raw_url, expected_url):
        proxy_path = tmp_path / "proxy-test.jsonl"

        logging_utils.log_proxy_entry(
            str(proxy_path),
            "warn",
            "url diagnostic",
            url=raw_url,
            extra_field="value",
        )

        [entry] = read_jsonl_entries_after_flush(proxy_path)
        assert entry["message"] == "url diagnostic"
        assert entry["url"] == expected_url
        assert entry["extra_field"] == "value"
        serialized = json.dumps(entry)
        assert "user:pass" not in serialized
        assert "first@" not in serialized
        assert "token=secret" not in serialized
        assert "#fragment" not in serialized

    @pytest.mark.parametrize(
        "raw_url",
        [
            "https:////example.com/users/alice@example.com?token=secret#fragment",
            r"https://\/example.com/users/alice@example.com?token=secret#fragment",
        ],
    )
    def test_preserves_at_sign_after_malformed_authority(self, tmp_path, raw_url):
        proxy_path = tmp_path / "proxy-test.jsonl"

        logging_utils.log_proxy_entry(
            str(proxy_path),
            "warn",
            "url diagnostic",
            url=raw_url,
        )

        [entry] = read_jsonl_entries_after_flush(proxy_path)
        assert entry["url"].endswith("example.com/users/alice@example.com")
        assert "token=secret" not in entry["url"]
        assert "#fragment" not in entry["url"]

    def test_only_sanitizes_exact_url_field(self, tmp_path):
        proxy_path = tmp_path / "proxy-test.jsonl"
        raw_url = "https://user:pass@example.com/path?token=secret#fragment"

        logging_utils.log_proxy_entry(
            str(proxy_path),
            "warn",
            "url diagnostic",
            url=raw_url,
            raw_url_copy=raw_url,
        )

        [entry] = read_jsonl_entries_after_flush(proxy_path)
        assert entry["url"] == "https://example.com/path"
        assert entry["raw_url_copy"] == raw_url

    def test_appends_multiple_entries(self, tmp_path):
        proxy_path = str(tmp_path / "proxy-test.jsonl")
        logging_utils.log_proxy_entry(proxy_path, "info", "first")
        logging_utils.log_proxy_entry(proxy_path, "warn", "second")
        entries = read_jsonl_entries_after_flush(tmp_path / "proxy-test.jsonl")
        assert len(entries) == 2
        assert entries[0]["message"] == "first"
        assert entries[1]["message"] == "second"

    def test_empty_path_no_op(self, tmp_path):
        with capture_addon_process_events() as log:
            logging_utils.log_proxy_entry(
                "", "warn", "should not write", payload={"body": b"binary"}
            )

        log.warn.assert_not_called()
        assert not list(tmp_path.iterdir())

    def test_missing_parent_path_warns_and_does_not_raise(self, tmp_path):
        with capture_addon_process_events() as log:
            logging_utils.log_proxy_entry(
                str(tmp_path / "missing" / "proxy.jsonl"), "warn", "message"
            )
            logging_utils.flush_log_path(str(tmp_path / "missing" / "proxy.jsonl"))

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Failed to write proxy log:" in warning
        assert "FileNotFoundError" in warning

    def test_directory_path_warns_and_does_not_raise(self, tmp_path):
        with capture_addon_process_events() as log:
            logging_utils.log_proxy_entry(str(tmp_path), "warn", "message")
            logging_utils.flush_log_path(str(tmp_path))

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Failed to write proxy log:" in warning
        assert "IsADirectoryError" in warning

    def test_non_serializable_extra_warns_without_creating_file(self, tmp_path):
        proxy_path = tmp_path / "proxy-test.jsonl"
        with capture_addon_process_events() as log:
            logging_utils.log_proxy_entry(
                str(proxy_path), "warn", "message", payload={"body": b"binary"}
            )

        log.warn.assert_called_once()
        warning = log.warn.call_args.args[0]
        assert "Failed to encode proxy log: TypeError:" in warning
        logging_utils.flush_log_path(str(proxy_path))
        assert not proxy_path.exists()

    def test_extra_cannot_override_reserved_fields(self, tmp_path):
        proxy_path = tmp_path / "proxy-test.jsonl"
        extra = {
            "proxy_log_path": "caller-proxy-log-path",
            "timestamp": "caller-timestamp",
            "level": "caller-level",
            "message": "caller-message",
            "log_level": "caller-log-level",
            "log_message": "caller-log-message",
            "extra_field": "value",
        }

        logging_utils.log_proxy_entry(str(proxy_path), "warn", "logger-message", **extra)

        [entry] = read_jsonl_entries_after_flush(proxy_path)
        assert_utc_millisecond_timestamp(entry["timestamp"])
        assert entry["timestamp"] != "caller-timestamp"
        assert entry["level"] == "warn"
        assert entry["message"] == "logger-message"
        assert entry["proxy_log_path"] == "caller-proxy-log-path"
        assert entry["log_level"] == "caller-log-level"
        assert entry["log_message"] == "caller-log-message"
        assert entry["extra_field"] == "value"


class TestJsonlWriterBehavior:
    def test_flush_all_logs_flushes_multiple_paths(self, tmp_path):
        network_path = tmp_path / "network.jsonl"
        proxy_path = tmp_path / "proxy.jsonl"

        logging_utils.log_network_entry(str(network_path), {"action": "ALLOW"})
        logging_utils.log_proxy_entry(str(proxy_path), "info", "proxy ready")
        logging_utils.flush_all_logs()

        [network_entry] = _read_jsonl_entries_without_flush(network_path)
        [proxy_entry] = _read_jsonl_entries_without_flush(proxy_path)
        assert network_entry["action"] == "ALLOW"
        assert proxy_entry["level"] == "info"
        assert proxy_entry["message"] == "proxy ready"

    def test_shutdown_log_writer_drains_accepted_writes(self, tmp_path):
        proxy_path = tmp_path / "proxy.jsonl"

        logging_utils.log_proxy_entry(str(proxy_path), "info", "before shutdown")
        logging_utils.shutdown_log_writer()

        [entry] = _read_jsonl_entries_without_flush(proxy_path)
        assert entry["level"] == "info"
        assert entry["message"] == "before shutdown"

    def test_write_after_shutdown_is_noop_without_warning(self, tmp_path):
        network_path = tmp_path / "network.jsonl"
        proxy_path = tmp_path / "proxy.jsonl"
        logging_utils.log_network_entry(str(network_path), {"action": "ALLOW"})
        logging_utils.log_proxy_entry(str(proxy_path), "info", "before shutdown")
        logging_utils.shutdown_log_writer()
        before_network_entries = _read_jsonl_entries_without_flush(network_path)
        before_entries = _read_jsonl_entries_without_flush(proxy_path)

        with capture_addon_process_events() as log:
            logging_utils.log_network_entry(str(network_path), {"action": "DENY"})
            logging_utils.log_proxy_entry(str(proxy_path), "warn", "after shutdown")

        log.warn.assert_not_called()
        after_network_entries = _read_jsonl_entries_without_flush(network_path)
        after_entries = _read_jsonl_entries_without_flush(proxy_path)
        assert after_network_entries == before_network_entries
        assert after_entries == before_entries


class TestAddFirewallMetadata:
    def test_copies_valid_connector_diagnostic_metadata(self, real_flow):
        flow = real_flow(with_response=False)
        flow.metadata.update(
            {
                metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG: "fal",
                metadata_keys.CONNECTOR_DIAGNOSTIC_REASON: "not_configured_for_run",
                metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES: ["FAL_TOKEN"],
                metadata_keys.CONNECTOR_DIAGNOSTIC_BASE: "https://fal.run",
            }
        )
        log_entry = {}

        logging_utils.add_firewall_metadata(flow, log_entry)

        assert log_entry == {
            "firewall_base": "",
            "firewall_name": "",
            "firewall_permission": "",
            "firewall_rule_match": "",
            "firewall_billable": False,
            "connector_diagnostic_slug": "fal",
            "connector_diagnostic_reason": "not_configured_for_run",
            "connector_diagnostic_env_names": ["FAL_TOKEN"],
            "connector_diagnostic_base": "https://fal.run",
        }

    def test_defaults_missing_required_firewall_metadata(self, real_flow):
        flow = real_flow(with_response=False)
        log_entry = {}

        logging_utils.add_firewall_metadata(flow, log_entry)

        assert log_entry == {
            "firewall_base": "",
            "firewall_name": "",
            "firewall_permission": "",
            "firewall_rule_match": "",
            "firewall_billable": False,
        }

    def test_defaults_malformed_required_firewall_metadata(self, real_flow):
        for billable in (None, "true", 1):
            flow = real_flow(with_response=False)
            flow.metadata.update(
                {
                    metadata_keys.FIREWALL_BASE: None,
                    metadata_keys.FIREWALL_NAME: 42,
                    metadata_keys.FIREWALL_PERMISSION: False,
                    metadata_keys.FIREWALL_RULE_MATCH: ["GET /items"],
                    metadata_keys.FIREWALL_BILLABLE: billable,
                }
            )
            log_entry = {}

            logging_utils.add_firewall_metadata(flow, log_entry)

            assert log_entry == {
                "firewall_base": "",
                "firewall_name": "",
                "firewall_permission": "",
                "firewall_rule_match": "",
                "firewall_billable": False,
            }

    def test_omits_optional_none_metadata(self, real_flow):
        flow = real_flow(with_response=False)
        flow.metadata.update(
            {
                metadata_keys.FIREWALL_PARAMS: None,
                metadata_keys.AUTH_RESOLVED_SECRETS: None,
                metadata_keys.AUTH_REFRESHED_CONNECTORS: None,
                metadata_keys.AUTH_REFRESHED_SECRETS: None,
                metadata_keys.AUTH_CACHE_HIT: None,
                metadata_keys.AUTH_URL_REWRITE: None,
            }
        )
        log_entry = {}

        logging_utils.add_firewall_metadata(flow, log_entry)

        assert log_entry == {
            "firewall_base": "",
            "firewall_name": "",
            "firewall_permission": "",
            "firewall_rule_match": "",
            "firewall_billable": False,
        }

    def test_omits_malformed_optional_metadata(self, real_flow):
        flow = real_flow(with_response=False)
        flow.metadata.update(
            {
                metadata_keys.FIREWALL_PARAMS: {"owner": "okou-ai", "branch": None},
                metadata_keys.AUTH_RESOLVED_SECRETS: ["GITHUB_TOKEN", None],
                metadata_keys.AUTH_REFRESHED_CONNECTORS: "github",
                metadata_keys.AUTH_REFRESHED_SECRETS: [1],
                metadata_keys.AUTH_CACHE_HIT: "false",
                metadata_keys.AUTH_URL_REWRITE: 1,
                metadata_keys.CONNECTOR_DIAGNOSTIC_SLUG: 1,
                metadata_keys.CONNECTOR_DIAGNOSTIC_REASON: None,
                metadata_keys.CONNECTOR_DIAGNOSTIC_ENV_NAMES: ["FAL_TOKEN", None],
                metadata_keys.CONNECTOR_DIAGNOSTIC_BASE: False,
            }
        )
        log_entry = {}

        logging_utils.add_firewall_metadata(flow, log_entry)

        assert log_entry == {
            "firewall_base": "",
            "firewall_name": "",
            "firewall_permission": "",
            "firewall_rule_match": "",
            "firewall_billable": False,
        }
