"""Shared destination and context helpers for usage webhook reporting."""

from mitmproxy import http

import flow_metadata
from platform_api import get_api_url

from .underbilling import log_usage_underbilling

USAGE_EVENT_WEBHOOK_PATH = "/api/webhooks/agent/usage-event"


class UsageReportingContext:
    """Flow-local platform reporting context for usage webhook uploads."""

    __slots__ = ("api_url", "proxy_log_path", "sandbox_token")

    def __init__(self, *, sandbox_token: str, api_url: str, proxy_log_path: str) -> None:
        self.sandbox_token = sandbox_token
        self.api_url = api_url
        self.proxy_log_path = proxy_log_path

    @property
    def missing_sandbox_token(self) -> bool:
        return not bool(self.sandbox_token)

    @property
    def missing_api_url(self) -> bool:
        return not bool(self.api_url)

    @property
    def is_complete(self) -> bool:
        return not self.missing_sandbox_token and not self.missing_api_url

    def _url_for(self, path: str) -> str:
        return f"{self.api_url}{path}"

    def usage_event_url(self) -> str:
        return self._url_for(USAGE_EVENT_WEBHOOK_PATH)


def log_usage_reporting_context_missing(
    context: UsageReportingContext,
    run_id: str,
    firewall_name: str,
    /,
    **extra: object,
) -> None:
    """Log confirmed underbilling when usage cannot reach the platform."""
    log_usage_underbilling(
        context.proxy_log_path,
        "Cannot report usage event: missing sandbox_token or api_url",
        "missing_reporting_context",
        "confirmed",
        run_id=run_id,
        firewall_name=firewall_name,
        missing_sandbox_token=context.missing_sandbox_token,
        missing_api_url=context.missing_api_url,
        **extra,
    )


def usage_reporting_context(flow: http.HTTPFlow) -> UsageReportingContext:
    return UsageReportingContext(
        sandbox_token=flow_metadata.sandbox_auth_key(flow.metadata),
        api_url=get_api_url(),
        proxy_log_path=flow_metadata.proxy_log_path(flow.metadata),
    )
