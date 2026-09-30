"""Model-provider usage reporting entry point.

Buffers token counts already normalized by an addon-side provider extractor.
Flow-terminal reporters aggregate usage stored in
``flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE]`` or
``flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_SOURCES]``. WebSocket
response-id sources can also be buffered incrementally with their source
idempotency keys preserved.

Extractor metadata uses only the base categories in ``MODEL_USAGE_CATEGORIES``.
Billing tier selection may remap those keys to reporter-owned
``.long_context``, ``.fast``, and ``.ultrafast`` categories when building billable usage
events.

Run contexts set ``flow.metadata[metadata_keys.MODEL_USAGE_PROVIDER]`` to the
usage provider (the Built-in route's ``usage_pricing`` provider) the proxy
should report for model token usage, and
``MODEL_USAGE_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS`` to its long-context
threshold when the API resolved one. Billable rows
go to ``/api/webhooks/agent/usage-event``.
"""

import uuid
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal, TypeGuard

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
from generated.model_usage import MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS
from logging_utils import log_proxy_entry, project_url_for_proxy_log

from ..buffer import (
    UsageEvent,
    buffer_source_usage_events,
    buffer_usage_events,
    seen_source_idempotency_keys,
)
from ..idempotency import (
    USAGE_EVENT_NAMESPACE_MODEL,
    derive_usage_idempotency_key,
)
from ..model_tokens import (
    MODEL_USAGE_CATEGORIES,
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_OUTPUT,
)
from ..quantities import is_usage_quantity
from ..reporting_context import (
    UsageReportingContext,
    log_usage_reporting_context_missing,
    usage_reporting_context,
)
from ..underbilling import log_usage_underbilling

MODEL_USAGE_KIND = "model"
type _ModelUsageTier = Literal["base", "long_context"]
type _ModelServiceTier = Literal["standard", "fast", "ultrafast"]
type _ModelUsageTransport = Literal["http", "websocket"]
type _ModelUsageBufferMode = Literal["aggregate", "source"]
_MODEL_USAGE_TIER_BASE: _ModelUsageTier = "base"
_MODEL_USAGE_TIER_LONG_CONTEXT: _ModelUsageTier = "long_context"
_MODEL_USAGE_CATEGORY_INPUT_LONG_CONTEXT = "tokens.input.long_context"
_MODEL_USAGE_CATEGORY_OUTPUT_LONG_CONTEXT = "tokens.output.long_context"
_MODEL_USAGE_CATEGORY_CACHE_READ_LONG_CONTEXT = "tokens.cache_read.long_context"
_MODEL_USAGE_CATEGORY_CACHE_CREATION_LONG_CONTEXT = "tokens.cache_creation.long_context"
_MODEL_USAGE_FAST_CATEGORY_SUFFIX = ".fast"
_MODEL_USAGE_ULTRAFAST_CATEGORY_SUFFIX = ".ultrafast"


@dataclass(frozen=True, slots=True)
class _ModelUsageTierDecision:
    tier: _ModelUsageTier
    service_tier: _ModelServiceTier
    committed: bool


@dataclass(frozen=True, slots=True)
class _ModelProviderUsageSource:
    source_id: str
    provider_response_id: str | None
    usage: dict


_MODEL_USAGE_LONG_CONTEXT_CATEGORY_BY_BASE = {
    MODEL_USAGE_CATEGORY_INPUT: _MODEL_USAGE_CATEGORY_INPUT_LONG_CONTEXT,
    MODEL_USAGE_CATEGORY_OUTPUT: _MODEL_USAGE_CATEGORY_OUTPUT_LONG_CONTEXT,
    MODEL_USAGE_CATEGORY_CACHE_READ: _MODEL_USAGE_CATEGORY_CACHE_READ_LONG_CONTEXT,
    MODEL_USAGE_CATEGORY_CACHE_CREATION: _MODEL_USAGE_CATEGORY_CACHE_CREATION_LONG_CONTEXT,
}
_MODEL_INPUT_PARTITION_BASE_CATEGORIES = (
    MODEL_USAGE_CATEGORY_INPUT,
    MODEL_USAGE_CATEGORY_CACHE_READ,
    MODEL_USAGE_CATEGORY_CACHE_CREATION,
)


def _billable_model_usage_category(
    category: str,
    billing_tier: _ModelUsageTier,
    service_tier: _ModelServiceTier,
) -> str:
    billable_category = (
        _MODEL_USAGE_LONG_CONTEXT_CATEGORY_BY_BASE[category]
        if billing_tier == _MODEL_USAGE_TIER_LONG_CONTEXT
        else category
    )
    if service_tier == "fast":
        return f"{billable_category}{_MODEL_USAGE_FAST_CATEGORY_SUFFIX}"
    if service_tier == "ultrafast":
        return f"{billable_category}{_MODEL_USAGE_ULTRAFAST_CATEGORY_SUFFIX}"
    return billable_category


_MODEL_PROVIDER_USAGE_TIER_SOURCE_LIMIT = 100
_MODEL_INPUT_PARTITION_CATEGORIES = frozenset(
    _billable_model_usage_category(category, billing_tier, service_tier)
    for category in _MODEL_INPUT_PARTITION_BASE_CATEGORIES
    for billing_tier in (_MODEL_USAGE_TIER_BASE, _MODEL_USAGE_TIER_LONG_CONTEXT)
    for service_tier in ("standard", "fast", "ultrafast")
)


def is_model_provider_usage_billable(flow: http.HTTPFlow) -> bool:
    """Return whether the flow can produce billable model-provider usage."""
    firewall_name = flow_metadata.firewall_name(flow.metadata)
    if not firewall_name.startswith("model-provider:"):
        return False
    return flow_metadata.is_firewall_billable(flow.metadata)


def has_positive_model_provider_usage(source_usage: dict) -> bool:
    """Return whether normalized model-provider usage contains billable quantity."""
    return any(_is_positive_int(source_usage.get(category)) for category in MODEL_USAGE_CATEGORIES)


def report_model_provider_usage(
    flow: http.HTTPFlow,
    run_id: str,
    *,
    accepted_source_keys: set[str] | None = None,
) -> bool:
    """Buffer billable token usage for model-provider responses if available.

    The function returns ``False`` when any of these gates fails:

    - ``firewall_name`` starts with ``model-provider:``.
    - ``run_id`` is non-empty.
    - ``firewall_billable`` is truthy.
    - At least one billable event is built from the available model-provider
      usage sources, with a resolvable billing tier and a positive integer
      quantity in ``MODEL_USAGE_CATEGORIES``.
    - ``sandbox_token`` and ``get_api_url()`` are both non-empty.

    It returns ``True`` when all gates pass, at least one event is built, and
    the complete reporting context allows the process-local buffer to be
    invoked. This boolean indicates that the reporting path was reached; it
    does not indicate how many events the buffer admitted or that webhook
    delivery completed. Process-local source-key deduplication can therefore
    admit zero events even when this function returns ``True``.

    When provided, ``accepted_source_keys`` receives only source payload keys
    newly admitted by the buffer during this call. It is the per-call source
    of truth for which payload keys were admitted. This reporting-path status
    is consumed by ``terminal_usage.report_model_provider_usage_once``
    separately from those per-call admission keys.

    Terminal reporting classifies each source independently. Providers with a
    long-context threshold (the registry's API-resolved
    ``modelUsageLongContextMinTotalInputTokens``, else
    ``MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS``) require a valid non-negative
    integer ``tokens.input`` quantity to resolve the billing tier. A source
    without a resolvable tier is skipped; if it contains positive usage in
    ``MODEL_USAGE_CATEGORIES``, it emits an error-level ``usage_underbilling``
    diagnostic with reason ``model_long_context_tier_unresolved`` and
    ``underbilling_class="risk"``, even with complete reporting context. If no
    billable events remain across all sources, this function returns ``False``.
    Unlike ``report_model_provider_usage_source`` for incremental WebSocket
    reporting, this path does not recover a remembered tier or use a
    conservative fallback. See
    ``test_output_without_input_skips_unclassifiable_terminal_billing`` in
    ``tests/test_model_provider_usage.py`` for the output-only regression.

    Failed firewall/run eligibility gates and sources without positive
    supported usage are silent. When billable events exist, missing sandbox
    token or API URL emits a ``missing_reporting_context`` underbilling signal
    because that usage cannot be reported.
    """
    if not run_id:
        return False
    firewall_name = flow_metadata.firewall_name(flow.metadata)
    if not firewall_name.startswith("model-provider:"):
        return False
    if not flow_metadata.is_firewall_billable(flow.metadata):
        return False
    events = _build_model_provider_usage_events(
        flow,
        run_id,
        USAGE_EVENT_NAMESPACE_MODEL,
    )
    if not events:
        return False
    return _buffer_model_provider_usage_events(
        flow,
        run_id,
        firewall_name,
        events,
        accepted_source_keys=accepted_source_keys,
    )


def report_model_provider_usage_source(
    flow: http.HTTPFlow,
    run_id: str,
    message_id: str,
    source_usage: dict,
) -> None:
    """Buffer one finalized WebSocket response usage source.

    Unlike flow-terminal reporting, this preserves the source idempotency keys
    in the webhook payload so the platform can dedupe one response source even
    when a later lifecycle hook sees the same source again. Input, cache-read,
    and cache-creation events use one bounded atomic admission key so later
    frames cannot add a second input partition for the same response id. Output
    remains independently admissible for compatible transports that report it
    in a later frame. Callers can drop the source from flow metadata after this
    returns. Tiered models retain only their bounded concrete
    tier decision. Evicted decisions are recovered from bounded source-key
    admission history when possible so later or duplicate snapshots derive
    the same billable category even when they repeat input tokens or change
    service-tier metadata. Without retained history or a classifiable input
    partition, positive usage receives a conservative billable fallback.
    """
    usage_events: list[UsageEvent] = []
    source_id = f"{flow.id}:{message_id}"
    provider = _reported_model(flow, source_usage)
    can_report_usage = _is_billable_model_provider(flow, run_id)
    if can_report_usage:
        pricing = _source_model_usage_pricing(
            flow,
            run_id,
            source_id,
            message_id,
            provider,
            source_usage,
        )
        if pricing is not None:
            billing_tier, service_tier = pricing
            usage_events = _build_usage_events(
                run_id,
                source_id,
                provider,
                source_usage,
                USAGE_EVENT_NAMESPACE_MODEL,
                billing_tier,
                service_tier,
            )
    if not usage_events:
        return

    accepted_usage_keys: set[str] = set()
    billing_context = usage_reporting_context(flow)
    if billing_context.is_complete:
        _buffer_source_model_provider_usage_events(
            billing_context,
            run_id,
            source_id,
            usage_events,
            accepted_source_keys=accepted_usage_keys,
        )
    else:
        firewall_name = flow_metadata.firewall_name(flow.metadata)
        log_usage_reporting_context_missing(
            billing_context,
            run_id,
            firewall_name,
        )
    _log_model_provider_usage_source(
        flow,
        run_id,
        _ModelProviderUsageSource(source_id, message_id, source_usage),
        provider,
        usage_events,
        accepted_usage_keys=accepted_usage_keys,
        transport="websocket",
        buffer_mode="source",
    )


def log_ignored_model_provider_usage_source(
    flow: http.HTTPFlow,
    run_id: str,
    message_id: str,
    source_usage: dict,
    *,
    reason: str,
) -> None:
    """Log one intentionally ignored WebSocket response usage source."""
    if not has_positive_model_provider_usage(source_usage):
        return

    url_projection = project_url_for_proxy_log(flow_metadata.original_url(flow.metadata))
    log_proxy_entry(
        flow_metadata.proxy_log_path(flow.metadata),
        "info",
        "Model provider usage source ignored",
        type="model_usage_source",
        disposition="ignored",
        reason=reason,
        run_id=run_id,
        flow_id=flow.id,
        source_id=f"{flow.id}:{message_id}",
        method=flow.request.method,
        url=url_projection,
        transport="websocket",
        buffer_mode="source",
        firewall_name=flow_metadata.firewall_name(flow.metadata),
        reported_model=_reported_model(flow, source_usage),
        provider_response_id=message_id,
        usage={
            category: quantity
            for category in MODEL_USAGE_CATEGORIES
            if _is_positive_int(quantity := source_usage.get(category))
        },
        usage_events=[],
        **url_projection.truncation_fields(),
    )


def log_terminal_model_provider_usage_sources(
    flow: http.HTTPFlow,
    run_id: str,
    *,
    accepted_usage_keys: set[str],
    transport: _ModelUsageTransport,
) -> None:
    """Log aggregate-buffer admission for terminal model usage sources."""
    for source in _iter_model_provider_usage_sources(flow):
        provider = _reported_model(flow, source.usage)
        usage_events: list[UsageEvent] = []
        billing_tier = _model_usage_tier(flow, provider, source.usage)
        if billing_tier is not None:
            usage_events = _build_usage_events(
                run_id,
                source.source_id,
                provider,
                source.usage,
                USAGE_EVENT_NAMESPACE_MODEL,
                billing_tier,
                _model_service_tier(source.usage),
            )
        _log_model_provider_usage_source(
            flow,
            run_id,
            source,
            provider,
            usage_events,
            accepted_usage_keys=accepted_usage_keys,
            transport=transport,
            buffer_mode="aggregate",
        )


def release_model_provider_usage_tiers(flow: http.HTTPFlow) -> None:
    """Release bounded WebSocket response tier decisions at terminal cleanup."""
    flow.metadata.pop(metadata_keys.MODEL_PROVIDER_USAGE_TIERS, None)


def _buffer_model_provider_usage_events(
    flow: http.HTTPFlow,
    run_id: str,
    firewall_name: str,
    events: list[UsageEvent],
    *,
    accepted_source_keys: set[str] | None,
) -> bool:
    context = usage_reporting_context(flow)
    if not context.is_complete:
        log_usage_reporting_context_missing(context, run_id, firewall_name)
        return False
    buffer_usage_events(
        context.usage_event_url(),
        context.sandbox_token,
        run_id,
        events,
        context.proxy_log_path,
        accepted_source_keys=accepted_source_keys,
    )
    return True


def _buffer_source_model_provider_usage_events(
    context: UsageReportingContext,
    run_id: str,
    source_id: str,
    events: list[UsageEvent],
    *,
    accepted_source_keys: set[str],
) -> None:
    input_partition_events, independent_events = _split_model_input_partition_events(events)
    if input_partition_events:
        buffer_source_usage_events(
            context.usage_event_url(),
            context.sandbox_token,
            run_id,
            input_partition_events,
            context.proxy_log_path,
            atomic_source_key=_model_input_partition_source_key(
                USAGE_EVENT_NAMESPACE_MODEL,
                run_id,
                source_id,
            ),
            accepted_source_keys=accepted_source_keys,
        )
    if independent_events:
        buffer_source_usage_events(
            context.usage_event_url(),
            context.sandbox_token,
            run_id,
            independent_events,
            context.proxy_log_path,
            accepted_source_keys=accepted_source_keys,
        )


def _split_model_input_partition_events(
    events: list[UsageEvent],
) -> tuple[list[UsageEvent], list[UsageEvent]]:
    input_partition_events: list[UsageEvent] = []
    independent_events: list[UsageEvent] = []
    for event in events:
        target = (
            input_partition_events
            if event["category"] in _MODEL_INPUT_PARTITION_CATEGORIES
            else independent_events
        )
        target.append(event)
    return input_partition_events, independent_events


def _model_input_partition_source_key(
    namespace: uuid.UUID,
    run_id: str,
    source_id: str,
) -> str:
    return derive_usage_idempotency_key(
        namespace,
        (run_id, source_id, "model_input_partition", "atomic_source"),
    )


def _build_model_provider_usage_events(
    flow: http.HTTPFlow,
    run_id: str,
    namespace: uuid.UUID,
) -> list[UsageEvent]:
    events: list[UsageEvent] = []
    for source in _iter_model_provider_usage_sources(flow):
        provider = _reported_model(flow, source.usage)
        billing_tier = _model_usage_tier(flow, provider, source.usage)
        if billing_tier is None:
            if has_positive_model_provider_usage(source.usage):
                _log_model_usage_tier_unresolved(flow, run_id, provider)
            continue
        events.extend(
            _build_usage_events(
                run_id,
                source.source_id,
                provider,
                source.usage,
                namespace,
                billing_tier,
                _model_service_tier(source.usage),
            )
        )
    return events


def _iter_model_provider_usage_sources(flow: http.HTTPFlow) -> Iterator[_ModelProviderUsageSource]:
    usage_sources = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE_SOURCES)
    if isinstance(usage_sources, dict):
        valid_sources = (
            (message_id, source_usage)
            for message_id, source_usage in usage_sources.items()
            if isinstance(message_id, str) and message_id and isinstance(source_usage, dict)
        )
        for message_id, source_usage in valid_sources:
            yield _ModelProviderUsageSource(
                f"{flow.id}:{message_id}",
                message_id,
                source_usage,
            )

    usage = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE)
    if usage and isinstance(usage, dict):
        yield _ModelProviderUsageSource(
            flow.id,
            _string_or_none(usage.get("message_id")),
            usage,
        )


def _log_model_provider_usage_source(
    flow: http.HTTPFlow,
    run_id: str,
    source: _ModelProviderUsageSource,
    provider: str,
    usage_events: list[UsageEvent],
    *,
    accepted_usage_keys: set[str],
    transport: _ModelUsageTransport,
    buffer_mode: _ModelUsageBufferMode,
) -> None:
    if not usage_events:
        return

    url_projection = project_url_for_proxy_log(flow_metadata.original_url(flow.metadata))
    log_proxy_entry(
        flow_metadata.proxy_log_path(flow.metadata),
        "info",
        "Model provider usage source reported",
        type="model_usage_source",
        run_id=run_id,
        flow_id=flow.id,
        source_id=source.source_id,
        method=flow.request.method,
        url=url_projection,
        transport=transport,
        buffer_mode=buffer_mode,
        firewall_name=flow_metadata.firewall_name(flow.metadata),
        reported_model=provider,
        provider_response_id=source.provider_response_id,
        usage={
            category: quantity
            for category in MODEL_USAGE_CATEGORIES
            if _is_positive_int(quantity := source.usage.get(category))
        },
        usage_events=[
            {
                "source_idempotency_key": event["idempotencyKey"],
                "category": event["category"],
                "quantity": event["quantity"],
                "buffer_accepted": event["idempotencyKey"] in accepted_usage_keys,
            }
            for event in usage_events
        ],
        **url_projection.truncation_fields(),
    )


def _build_usage_events(
    run_id: str,
    source_id: str,
    provider: str,
    usage: dict,
    namespace: uuid.UUID,
    billing_tier: _ModelUsageTier,
    service_tier: _ModelServiceTier,
) -> list[UsageEvent]:
    events: list[UsageEvent] = []
    for category in MODEL_USAGE_CATEGORIES:
        quantity = usage.get(category)
        if not _is_positive_int(quantity):
            continue
        billable_category = _billable_model_usage_category(
            category,
            billing_tier,
            service_tier,
        )
        event: UsageEvent = {
            "idempotencyKey": derive_usage_idempotency_key(
                namespace,
                (run_id, source_id, billable_category),
            ),
            "kind": MODEL_USAGE_KIND,
            "provider": provider,
            "category": billable_category,
            "quantity": quantity,
        }
        events.append(event)
    return events


def _source_model_usage_pricing(
    flow: http.HTTPFlow,
    run_id: str,
    source_id: str,
    message_id: str,
    provider: str,
    usage: dict,
) -> tuple[_ModelUsageTier, _ModelServiceTier] | None:
    billing_tier = _model_usage_tier(flow, provider, usage)
    if _long_context_min_total_input_tokens(flow, provider) is None:
        return (billing_tier, _model_service_tier(usage)) if billing_tier else None

    tiers = _model_provider_usage_tiers(flow)
    remembered_decision = tiers.get(message_id)
    observed_service_tier = _observed_model_service_tier(usage)
    if remembered_decision is not None:
        tier = remembered_decision.tier
        service_tier = remembered_decision.service_tier
        if not remembered_decision.committed:
            if billing_tier is not None:
                tier = billing_tier
            if observed_service_tier is not None:
                service_tier = observed_service_tier
        tiers[message_id] = _ModelUsageTierDecision(
            tier=tier,
            service_tier=service_tier,
            committed=remembered_decision.committed or has_positive_model_provider_usage(usage),
        )
        tiers.move_to_end(message_id)
        return tier, service_tier
    # Admitted source keys remain authoritative after the tier cache evicts
    # a response, even if this snapshot contains a different input partition.
    service_tier = observed_service_tier or "standard"
    recovered_pricing = _recover_source_model_usage_pricing(run_id, source_id)
    if recovered_pricing is not None:
        billing_tier, service_tier = recovered_pricing
    elif billing_tier is None:
        if not has_positive_model_provider_usage(usage):
            return None
        billing_tier = _MODEL_USAGE_TIER_LONG_CONTEXT
        _log_model_usage_tier_fallback(
            flow,
            run_id,
            provider,
            billing_tier,
            service_tier,
        )

    tiers[message_id] = _ModelUsageTierDecision(
        tier=billing_tier,
        service_tier=service_tier,
        committed=recovered_pricing is not None or has_positive_model_provider_usage(usage),
    )
    if len(tiers) > _MODEL_PROVIDER_USAGE_TIER_SOURCE_LIMIT:
        tiers.popitem(last=False)
    return billing_tier, service_tier


def _recover_source_model_usage_pricing(
    run_id: str,
    source_id: str,
) -> tuple[_ModelUsageTier, _ModelServiceTier] | None:
    pricing_by_source_key: dict[str, tuple[_ModelUsageTier, _ModelServiceTier]] = {
        derive_usage_idempotency_key(
            USAGE_EVENT_NAMESPACE_MODEL,
            (
                run_id,
                source_id,
                _billable_model_usage_category(category, billing_tier, service_tier),
            ),
        ): (billing_tier, service_tier)
        for category in MODEL_USAGE_CATEGORIES
        for billing_tier in (_MODEL_USAGE_TIER_BASE, _MODEL_USAGE_TIER_LONG_CONTEXT)
        for service_tier in ("standard", "fast", "ultrafast")
    }
    seen_keys = seen_source_idempotency_keys(pricing_by_source_key)
    if not seen_keys:
        return None
    decisions = {pricing_by_source_key[source_key] for source_key in seen_keys}
    if len(decisions) != 1:
        raise RuntimeError("Model usage source keys resolved to conflicting pricing decisions")
    return decisions.pop()


def _model_provider_usage_tiers(
    flow: http.HTTPFlow,
) -> OrderedDict[str, _ModelUsageTierDecision]:
    tiers = flow.metadata.get(metadata_keys.MODEL_PROVIDER_USAGE_TIERS)
    if isinstance(tiers, OrderedDict):
        return tiers
    new_tiers: OrderedDict[str, _ModelUsageTierDecision] = OrderedDict()
    flow.metadata[metadata_keys.MODEL_PROVIDER_USAGE_TIERS] = new_tiers
    return new_tiers


def _long_context_min_total_input_tokens(flow: http.HTTPFlow, provider: str) -> int | None:
    """Return the long-context threshold that applies to ``provider``.

    The API resolves the threshold from the run's catalog data and sends it
    with the usage provider, so a pricing alias that is not a key of the
    generated map still bills the long-context tier. Registry entries from an
    older API carry no threshold; the generated map keyed by provider is the
    fallback for them.
    """
    if flow_metadata.model_usage_provider(flow.metadata) == provider:
        explicit = flow_metadata.model_usage_long_context_min_total_input_tokens(flow.metadata)
        if explicit is not None:
            return explicit
    return MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS.get(provider)


def _model_usage_tier(
    flow: http.HTTPFlow,
    provider: str,
    usage: dict,
) -> _ModelUsageTier | None:
    min_input_tokens = _long_context_min_total_input_tokens(flow, provider)
    if min_input_tokens is None:
        return _MODEL_USAGE_TIER_BASE

    input_tokens = usage.get(MODEL_USAGE_CATEGORY_INPUT)
    if not _is_non_negative_int(input_tokens):
        return None
    total_input_tokens = input_tokens
    for category in (
        MODEL_USAGE_CATEGORY_CACHE_READ,
        MODEL_USAGE_CATEGORY_CACHE_CREATION,
    ):
        quantity = usage.get(category)
        if _is_non_negative_int(quantity):
            total_input_tokens += quantity
    if total_input_tokens >= min_input_tokens:
        return _MODEL_USAGE_TIER_LONG_CONTEXT
    return _MODEL_USAGE_TIER_BASE


def _observed_model_service_tier(usage: dict) -> _ModelServiceTier | None:
    tier = usage.get("service_tier")
    if not isinstance(tier, str) or not tier:
        return None
    if tier == "ultrafast":
        return "ultrafast"
    return "fast" if tier in ("fast", "priority") else "standard"


def _model_service_tier(usage: dict) -> _ModelServiceTier:
    return _observed_model_service_tier(usage) or "standard"


def _log_model_usage_tier_unresolved(
    flow: http.HTTPFlow,
    run_id: str,
    provider: str,
) -> None:
    log_usage_underbilling(
        flow_metadata.proxy_log_path(flow.metadata),
        "Cannot classify tiered model usage without an input partition",
        "model_long_context_tier_unresolved",
        "risk",
        run_id=run_id,
        provider=provider,
    )


def _log_model_usage_tier_fallback(
    flow: http.HTTPFlow,
    run_id: str,
    provider: str,
    billing_tier: _ModelUsageTier,
    service_tier: _ModelServiceTier,
) -> None:
    log_usage_underbilling(
        flow_metadata.proxy_log_path(flow.metadata),
        "Billing tiered model usage with a conservative category fallback",
        "model_long_context_tier_unresolved",
        "risk",
        run_id=run_id,
        provider=provider,
        usage_billed=True,
        fallback_billing_tier=billing_tier,
        fallback_fast=service_tier == "fast",
        fallback_service_tier=service_tier,
    )


def _reported_model(flow: http.HTTPFlow, usage: dict) -> str:
    return (
        flow_metadata.model_usage_provider(flow.metadata)
        or _string_or_none(usage.get("model"))
        or "unknown"
    )


def _is_positive_int(value: object) -> TypeGuard[int]:
    return is_usage_quantity(value) and value > 0


def _is_non_negative_int(value: object) -> TypeGuard[int]:
    return is_usage_quantity(value)


def _string_or_none(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value


def _is_billable_model_provider(flow: http.HTTPFlow, run_id: str) -> bool:
    if not run_id:
        return False
    return is_model_provider_usage_billable(flow)
