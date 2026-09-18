"""Per-connector billing and response parser dispatch.

Each supported billable connector has one coherent registration under this
package. The registration combines a required usage reporter with optional
focused response-inspection behavior. The capability implementations may live in
separate modules. :func:`report_connector_usage` is the single entry point
called by the addon response / error handlers; it applies the universal gates
(``run_id`` present, firewall flagged billable by the web layer, firewall has a
registered handler) and delegates to the matching per-connector ``report_usage``
function.

Billable connector metadata comes from the accepted connector catalog and
reaches the runner through the claim's ``billableFirewalls`` list. Adding a new
billable connector means marking its catalog firewall billable, adding a
reporter and any focused response-inspection implementation under this package,
and composing those capabilities in :data:`_REGISTRATIONS`.
Response inspection owns both parser creation and buffered-fallback selection,
so those decisions cannot drift across independent registries.
"""

from collections.abc import Callable
from typing import NamedTuple

from mitmproxy import http

import flow_metadata

from ...underbilling import log_usage_underbilling
from . import x
from .response_parser import ConnectorResponseParser

_ConnectorUsageHandler = Callable[[http.HTTPFlow, str, str], None]
_ResponseParserFactory = Callable[[http.HTTPFlow, str], ConnectorResponseParser | None]
_ResponseBufferFallbackPredicate = Callable[[http.HTTPFlow], bool]


class _ConnectorResponseInspection(NamedTuple):
    create_parser: _ResponseParserFactory
    needs_buffered_fallback: _ResponseBufferFallbackPredicate


class _ConnectorUsageRegistration(NamedTuple):
    report_usage: _ConnectorUsageHandler
    response_inspection: _ConnectorResponseInspection | None = None


# Map firewall_name → one coherent connector usage registration. A reporter is
# only invoked when ``flow.metadata[metadata_keys.FIREWALL_BILLABLE]`` is True.
# That flag comes from the runner claim's ``billableFirewalls`` list, projected
# from the accepted connector catalog.
# Deployment desync manifests as a dropped billing record plus the warning below.
_REGISTRATIONS: dict[str, _ConnectorUsageRegistration] = {
    "x": _ConnectorUsageRegistration(
        report_usage=x.report_usage,
        response_inspection=_ConnectorResponseInspection(
            create_parser=x.create_response_parser,
            needs_buffered_fallback=x.needs_response_buffer_fallback,
        ),
    ),
}

# One-shot guard: first time we see a billable firewall_name with no
# registered handler, warn once per name per addon process.  Catches the
# deployment-desync case where accepted catalog metadata has grown but the
# runner is on an older addon image — without this, billing records silently
# drop with no local signal.
_unregistered_handler_warned: set[str] = set()


def _require_original_url(flow: http.HTTPFlow) -> str:
    original_url = flow_metadata.original_url(flow.metadata)
    if not original_url:
        raise ValueError("registered billable connector flow is missing original_url")
    return original_url


def _response_inspection(firewall_name: str) -> _ConnectorResponseInspection | None:
    registration = _REGISTRATIONS.get(firewall_name)
    return registration.response_inspection if registration is not None else None


def report_connector_usage(flow: http.HTTPFlow, run_id: str) -> None:
    """Dispatch a billable connector flow to its per-connector handler.

    Universal skip conditions applied here (once, instead of inside every
    connector module):

    - ``run_id`` is empty (no billing attribution).
    - ``flow.metadata[metadata_keys.FIREWALL_BILLABLE]`` is False (web layer decided
      this firewall is not platform-billable for this run).
    - ``flow.metadata[metadata_keys.FIREWALL_NAME]`` has no registered handler (covers
      both the model-provider path — routed through
      :func:`report_model_provider_usage` instead — and any connector firewall
      marked billable by the accepted connector catalog but not yet supported by
      this addon version).
    """
    if not run_id:
        return
    if not flow_metadata.is_firewall_billable(flow.metadata):
        return
    firewall_name = flow_metadata.firewall_name(flow.metadata)
    if firewall_name.startswith("model-provider:"):
        return
    registration = _REGISTRATIONS.get(firewall_name)
    if registration is None:
        if firewall_name and firewall_name not in _unregistered_handler_warned:
            _unregistered_handler_warned.add(firewall_name)
            log_usage_underbilling(
                flow_metadata.proxy_log_path(flow.metadata),
                f"Billable firewall {firewall_name!r} has no registered handler — "
                "billing records for this firewall will be dropped.  Check that "
                "the accepted catalog and _REGISTRATIONS here are in sync.",
                "unregistered_billable_handler",
                "confirmed",
                firewall_name=firewall_name,
            )
        return
    original_url = _require_original_url(flow)
    registration.report_usage(flow, run_id, original_url)


def has_connector_response_parser(firewall_name: str) -> bool:
    """Return whether a connector has response-body parser capability."""
    return _response_inspection(firewall_name) is not None


def create_connector_response_parser(flow: http.HTTPFlow) -> ConnectorResponseParser | None:
    """Create the connector-specific response parser for this flow, if registered.

    The returned parser is wired into the response stream and may publish
    connector-owned ``flow.metadata`` state for ``report_connector_usage``.
    Non-billable flows never need connector billing parser state.
    """
    if not flow_metadata.is_firewall_billable(flow.metadata):
        return None
    firewall_name = flow_metadata.firewall_name(flow.metadata)
    inspection = _response_inspection(firewall_name)
    if inspection is None:
        return None
    original_url = _require_original_url(flow)
    return inspection.create_parser(flow, original_url)


def needs_connector_response_buffer_fallback(flow: http.HTTPFlow) -> bool:
    """Return whether terminal connector billing may consume buffered response bytes."""
    if not flow_metadata.is_firewall_billable(flow.metadata):
        return False
    firewall_name = flow_metadata.firewall_name(flow.metadata)
    inspection = _response_inspection(firewall_name)
    return inspection.needs_buffered_fallback(flow) if inspection is not None else False
