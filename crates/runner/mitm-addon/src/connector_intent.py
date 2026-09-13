"""Private connector-routing intent capture for mitmproxy HTTP flows."""

from dataclasses import dataclass
from typing import Final, Literal

from mitmproxy import http

HEADER_NAME: Final = "X-Okou-Connector-Intent"
LEGACY_HEADER_NAME: Final = "X-VM0-Connector-Intent"

# Lowercase, because the field scan compares against ``name.lower()``.
_RAW_HEADER_NAME: Final = b"x-okou-connector-intent"
_RAW_LEGACY_HEADER_NAME: Final = b"x-vm0-connector-intent"
_MAX_CONNECTOR_INTENT_BYTES: Final = 64

_VALUE_METADATA_KEY = "_connector_intent_value"
_STATUS_METADATA_KEY = "_connector_intent_status"

REQUEST_HEADERS_PROBE_METADATA_KEYS = (
    _VALUE_METADATA_KEY,
    _STATUS_METADATA_KEY,
)

ConnectorIntentStatus = Literal["absent", "malformed", "present"]


@dataclass(frozen=True, slots=True)
class ConnectorIntent:
    """Parsed connector-routing intent captured from one private header."""

    status: ConnectorIntentStatus
    value: str | None = None


ABSENT = ConnectorIntent("absent")
MALFORMED = ConnectorIntent("malformed")


def _scan_raw_header(flow: http.HTTPFlow, raw_name: bytes) -> tuple[bytes | None, bool]:
    """Return one header's first raw value and whether that same name repeats."""
    raw_value: bytes | None = None
    for name, value in flow.request.headers.fields:
        if name.lower() != raw_name:
            continue
        if raw_value is not None:
            return raw_value, True
        raw_value = value
    return raw_value, False


def capture_and_strip(flow: http.HTTPFlow) -> None:
    """Capture connector intent once and always remove both private headers.

    Both the canonical and the legacy header name are accepted, because the CLI
    that sends this header is an independently released, commit-addressed
    artifact: a sandbox can run a package built before the canonical name
    existed. Removal is therefore unconditional and covers both names on every
    flow, including flows that carry neither and flows already captured — a name
    this addon fails to remove is forwarded to the third-party upstream with a
    connector id in it.

    When both names appear, the canonical name is authoritative and the legacy
    name is read only when the canonical one is absent entirely. Repetition of a
    single name remains ``malformed``; one occurrence of each is not repetition.

    ``LEGACY_HEADER_NAME`` is a bounded rollout fallback. Surface: existing
    runner and sandbox, gated on old instances finishing their drain. Remove it
    once the CLI sends only the canonical name and no queued or claimed
    execution context can still resolve a ``CLI_PKG_URL`` from before that
    sender change — see ``docs/deployment-compatibility.md``, *Commit-addressed
    CLI artifacts*; the package's semantic version is not a valid floor.
    Follow-up: vm0-ai/vm0#33661 step 3.
    """
    if _STATUS_METADATA_KEY not in flow.metadata:
        header_name = HEADER_NAME
        raw_value, repeated = _scan_raw_header(flow, _RAW_HEADER_NAME)
        if raw_value is None:
            header_name = LEGACY_HEADER_NAME
            raw_value, repeated = _scan_raw_header(flow, _RAW_LEGACY_HEADER_NAME)

        if raw_value is None:
            flow.metadata[_STATUS_METADATA_KEY] = "absent"
        elif repeated or len(raw_value) > _MAX_CONNECTOR_INTENT_BYTES:
            flow.metadata[_STATUS_METADATA_KEY] = "malformed"
        else:
            value = flow.request.headers.get_all(header_name)[0].strip()
            if value == "" or "," in value:
                flow.metadata[_STATUS_METADATA_KEY] = "malformed"
            else:
                flow.metadata[_STATUS_METADATA_KEY] = "present"
                flow.metadata[_VALUE_METADATA_KEY] = value

    flow.request.headers.set_all(HEADER_NAME, [])
    flow.request.headers.set_all(LEGACY_HEADER_NAME, [])


def from_flow(flow: http.HTTPFlow) -> ConnectorIntent:
    """Return the captured intent, defaulting to absent for uncaptured flows."""
    status = flow.metadata.get(_STATUS_METADATA_KEY)
    if status == "malformed":
        return MALFORMED
    if status == "present":
        value = flow.metadata.get(_VALUE_METADATA_KEY)
        if isinstance(value, str):
            return ConnectorIntent("present", value)
    return ABSENT
