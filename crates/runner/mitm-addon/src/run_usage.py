"""Bounded, content-free inference observations independent of billing delivery.

The addon loop owns registry reconciliation and parser updates. The control
thread copies a small projection and prunes expired runs under the same lock.
Flow handles freeze attribution; reads never initialize a run or resolve an IP.
"""

import threading
import time
from dataclasses import dataclass, field
from typing import Literal

from mitmproxy import http

import flow_metadata
import flow_metadata_keys as metadata_keys
import runtime_url_parsing
from usage.model_tokens import MODEL_USAGE_CATEGORIES
from usage.openai_responses import merge_openai_responses_usage_result
from usage.quantities import MAX_USAGE_QUANTITY, is_usage_quantity

MAX_RUNS = 256
MAX_RESPONSES_PER_RUN = 4096
MAX_RESPONSES = 32768
MAX_ID_BYTES = 1024
RETIRED_SECONDS = 300
_FLOW_STATE = "_run_usage_state"

type Reason = Literal[
    "history_lost",
    "retention_lost",
    "missing_usage",
    "missing_categories",
    "parse_error",
    "ambiguous_response",
    "unsupported_protocol",
    "interrupted",
    "overflow",
    "in_flight",
]


@dataclass(slots=True)
class _Run:
    run_id: str
    responses: dict[tuple[str, str], dict[str, int]] = field(default_factory=dict)
    totals: dict[str, int] = field(default_factory=lambda: dict.fromkeys(MODEL_USAGE_CATEGORIES, 0))
    pending: set[str] = field(default_factory=set)
    reasons: set[Reason] = field(default_factory=set)
    revision: int = 0
    retired_at: float | None = None
    retained: bool = True


@dataclass(slots=True)
class _Flow:
    run: _Run
    namespace: str
    flow_id: str
    websocket: bool
    openai: bool
    response_key: tuple[str, str] | None = None
    finished: bool = False


_lock = threading.Lock()
_generation: str | None = None
_runs: dict[str, _Run] = {}
_response_count = 0
_history_discarded = False
_last_registry: str | None = None


def initialize(generation: str | None) -> None:
    """Start one addon lifetime before accepting control or provider traffic."""
    global _generation, _response_count, _history_discarded, _last_registry
    with _lock:
        for run in _runs.values():
            run.retained = False
            run.responses.clear()
            run.pending.clear()
        _runs.clear()
        _generation = generation
        _response_count = 0
        _history_discarded = False
        _last_registry = None


def _discard(run_id: str) -> None:
    global _response_count, _history_discarded
    run = _runs.pop(run_id)
    _response_count -= len(run.responses)
    run.retained = False
    run.responses.clear()
    run.pending.clear()
    _history_discarded = True


def _prune(now: float) -> None:
    for run_id, run in list(_runs.items()):
        if run.retired_at is not None and now - run.retired_at >= RETIRED_SECONDS:
            _discard(run_id)


def reconcile(sandboxes: dict, registry_identity: str | None) -> None:
    """Initialize from validated authoritative registrations, never query input."""
    global _last_registry
    if _generation is None or registry_identity == _last_registry:
        return
    # Do not hold the reader lock while projecting a potentially large registry.
    registrations = {
        entry["runId"]: entry.get("usageGeneration")
        for entry in sandboxes.values()
        if len(entry["runId"].encode()) <= MAX_ID_BYTES
    }
    with _lock:
        if _generation is None or registry_identity == _last_registry:
            return
        _last_registry = registry_identity
        now = time.monotonic()
        _prune(now)
        for run_id, run in _runs.items():
            if run_id in registrations:
                run.retired_at = None
            elif run.retired_at is None:
                run.retired_at = now
        for run_id, generation in registrations.items():
            if run_id in _runs:
                continue
            if len(_runs) >= MAX_RUNS:
                retired = next(
                    (key for key, run in _runs.items() if run.retired_at is not None), None
                )
                if retired is None:
                    continue
                _discard(retired)
            run = _Run(run_id)
            if generation != _generation:
                run.reasons.add("history_lost")
            if _history_discarded:
                run.reasons.add("retention_lost")
            _runs[run_id] = run


def _state(flow: http.HTTPFlow) -> _Flow | None:
    state = flow.metadata.get(_FLOW_STATE)
    return state if isinstance(state, _Flow) and state.run.retained else None


def is_tracking(flow: http.HTTPFlow) -> bool:
    state = _state(flow)
    return state is not None and not state.finished


def admit(flow: http.HTTPFlow, *, namespace: str | None = None) -> None:
    """Capture one model request before upstream dispatch, without charging it."""
    if _FLOW_STATE in flow.metadata:
        return
    namespace = namespace or flow_metadata.firewall_name(flow.metadata)
    if not namespace.startswith("model-provider:"):
        return
    websocket = flow.metadata.get(metadata_keys.WEBSOCKET_UPGRADE_REQUEST) is True
    # Model discovery and other read-only HTTP endpoints do not start inference.
    if flow.request.method.upper() != "POST" and not websocket:
        return
    with _lock:
        run = _runs.get(flow_metadata.run_id(flow.metadata))
        if run is None:
            return
        if len(namespace.encode()) > MAX_ID_BYTES or len(run.pending) >= MAX_RESPONSES_PER_RUN:
            _mark(run, "retention_lost")
            return
        path = runtime_url_parsing.strip_url_query_and_fragment(
            flow_metadata.original_url(flow.metadata) or flow.request.path
        ).rstrip("/")
        state = _Flow(
            run, namespace, flow.id, websocket, path.endswith(("/responses", "/chat/completions"))
        )
        flow.metadata[_FLOW_STATE] = state
        if not path.endswith(("/messages", "/responses", "/chat/completions")):
            _mark(run, "unsupported_protocol")
        if not websocket:
            run.pending.add(flow.id)
            run.revision += 1


def _mark(run: _Run, reason: Reason) -> None:
    if reason not in run.reasons:
        run.reasons.add(reason)
        run.revision += 1


def mark(flow: http.HTTPFlow, reason: Reason) -> None:
    with _lock:
        state = _state(flow)
        if state is not None:
            _mark(state.run, reason)


def observe(
    flow: http.HTTPFlow, quantities: dict | None, *, response_id: str | None = None
) -> None:
    """Replace a logical response's normalized snapshot, retaining known fields."""
    global _response_count
    if quantities is None:
        return
    with _lock:
        state = _state(flow)
        if state is None or state.finished:
            return
        run = state.run
        if quantities.get("input_partition_incomplete") is True:
            _mark(run, "parse_error")
        selected = {
            key: value
            for key, value in quantities.items()
            if key in MODEL_USAGE_CATEGORIES and is_usage_quantity(value)
        }
        if not selected:
            return
        candidate = response_id or quantities.get("message_id")
        if candidate is not None and (
            not isinstance(candidate, str)
            or not candidate
            or len(candidate.encode()) > MAX_ID_BYTES
        ):
            _mark(run, "ambiguous_response")
            return
        if state.websocket and candidate is None:
            _mark(run, "ambiguous_response")
            return
        key = (state.namespace, "response:" + candidate if candidate else "flow:" + state.flow_id)
        if not state.websocket and state.response_key is not None and key != state.response_key:
            _mark(run, "ambiguous_response")
            return
        state.response_key = key
        previous = run.responses.get(key)
        if previous is None:
            if len(run.responses) >= MAX_RESPONSES_PER_RUN or _response_count >= MAX_RESPONSES:
                _mark(run, "retention_lost")
                return
            previous = {}
        if state.openai:
            updated = dict(previous)
            # Reconstruct and repartition total input when a later snapshot
            # omits cache details. Independent per-category merging overlaps it.
            merge_openai_responses_usage_result(updated, selected)
        else:
            updated = previous | selected
        if sum(updated.values()) < sum(previous.values()):
            _mark(run, "ambiguous_response")
            return
        totals = {
            category: run.totals[category] + updated.get(category, 0) - previous.get(category, 0)
            for category in MODEL_USAGE_CATEGORIES
        }
        if sum(totals.values()) > MAX_USAGE_QUANTITY:
            _mark(run, "overflow")
            return
        if key not in run.responses:
            _response_count += 1
        if updated != previous or key not in run.responses:
            run.responses[key] = updated
            run.totals = totals
            run.revision += 1


def websocket_pending(flow: http.HTTPFlow, *, pending: bool) -> None:
    with _lock:
        state = _state(flow)
        if state is None or state.finished:
            return
        run = state.run
        if pending and state.flow_id not in run.pending:
            if len(run.pending) >= MAX_RESPONSES_PER_RUN:
                _mark(run, "retention_lost")
                return
            run.pending.add(state.flow_id)
            run.revision += 1
        elif not pending and state.flow_id in run.pending:
            run.pending.remove(state.flow_id)
            run.revision += 1


def terminal_response(flow: http.HTTPFlow) -> None:
    """Settle one response without turning absent usage into provider zero."""
    with _lock:
        state = _state(flow)
        if state is None or state.finished:
            return
        quantities = state.run.responses.get(state.response_key) if state.response_key else None
        if quantities is None:
            _mark(state.run, "missing_usage")
        elif any(category not in quantities for category in MODEL_USAGE_CATEGORIES):
            _mark(state.run, "missing_categories")
        if state.websocket:
            state.response_key = None
        else:
            state.finished = True
        if state.flow_id in state.run.pending:
            state.run.pending.remove(state.flow_id)
            state.run.revision += 1


def finish(flow: http.HTTPFlow, *, interrupted: bool = False) -> None:
    state = _state(flow)
    if state is None or state.finished:
        return
    if interrupted or (state.websocket and state.flow_id in state.run.pending):
        mark(flow, "interrupted")
    if not state.websocket or state.flow_id in state.run.pending:
        terminal_response(flow)
    state.finished = True


def snapshot(run_id: str) -> dict[str, object]:
    with _lock:
        _prune(time.monotonic())
        run = _runs.get(run_id)
        if run is None:
            return {"state": "unavailable", "runId": run_id}
        reasons = run.reasons | ({"in_flight"} if run.pending else set())
        return {
            "state": "available",
            "runId": run_id,
            "revision": run.revision,
            "sampledAtMs": time.time_ns() // 1_000_000,
            "observedResponses": len(run.responses),
            "outstandingResponses": len(run.pending),
            "complete": not reasons,
            "reasons": sorted(reasons),
            "totals": {
                "input": run.totals["tokens.input"],
                "cacheRead": run.totals["tokens.cache_read"],
                "cacheCreation": run.totals["tokens.cache_creation"],
                "output": run.totals["tokens.output"],
                "total": sum(run.totals.values()),
            },
        }
