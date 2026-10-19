"""Bounded model-based coverage for WebSocket prewarm correlation."""

import hashlib
import json
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from itertools import product
from pathlib import Path
from typing import Literal

import pytest
from mitmproxy import http

import flow_metadata_keys as metadata_keys
import mitm_addon
import model_websocket_usage
import openai_responses_events
import usage
from tests.jsonl_log_helpers import jsonl_exists_after_flush, read_jsonl_entries_after_flush
from tests.model_provider_flow_helpers import (
    RealFlowFactory,
    make_openai_responses_websocket_flow,
    model_provider_usage_sources,
    model_usage_source_entries,
)
from tests.model_provider_websocket_helpers import (
    ScheduledWebSocketTrim,
    capture_deferred_websocket_trims,
    feed_websocket_client_message,
    feed_websocket_server_message,
)
from tests.usage_helpers import UsageWebhookServer, assert_usage_event_rows
from usage.quantities import MAX_USAGE_QUANTITY

type _Intent = Literal["normal", "prewarm"]
type _ClientInvalidKind = Literal["unknown", "malformed", "work-limit"]
type _CreatedShape = Literal["valid", "missing-id", "conflicting-id"]
type _TerminalShape = Literal["valid", "missing-id", "conflicting-id"]
type _UsageShape = Literal["absent", "zero", "positive", "error"]
type _BoundaryKind = Literal["error", "work-limit"]
type _PrefixKind = Literal[
    "idle",
    "pending-normal",
    "pending-prewarm",
    "active-normal",
    "active-prewarm",
    "retained-prewarm",
]
type _TriggerKind = Literal[
    "overlap-normal",
    "overlap-prewarm",
    "unknown-client",
    "malformed-client",
    "client-work-limit",
    "created-missing-id",
    "created-conflicting-id",
    "created-reused-id",
    "terminal-missing-id",
    "terminal-conflicting-id",
    "server-error",
    "server-work-limit",
    "unbound-positive-usage",
]
type _VerificationRelation = Literal["active", "retained", "fresh"]
type _UsageWebhookApi = Callable[[], AbstractContextManager[UsageWebhookServer]]

_GENERATION_SEED = "issue-29844-websocket-prewarm-model-v1"
_MAX_GENERATED_REPLAY_CASES = 512
_TERMINAL_EVENTS = tuple(sorted(openai_responses_events.TERMINAL_EVENTS))


@pytest.fixture(autouse=True)
def deferred_websocket_trim_scheduler(
    monkeypatch: pytest.MonkeyPatch,
) -> list[ScheduledWebSocketTrim]:
    return capture_deferred_websocket_trims(monkeypatch)


@dataclass(frozen=True, slots=True)
class _ClientCreate:
    request_key: str
    intent: _Intent


@dataclass(frozen=True, slots=True)
class _ClientInvalid:
    kind: _ClientInvalidKind
    marker: str


@dataclass(frozen=True, slots=True)
class _ServerCreated:
    owner_request_key: str | None
    response_id: str | None
    shape: _CreatedShape = "valid"


@dataclass(frozen=True, slots=True)
class _ServerTerminal:
    event_type: str
    response_id: str | None
    usage_shape: _UsageShape = "absent"
    quantity: int = 0
    shape: _TerminalShape = "valid"


@dataclass(frozen=True, slots=True)
class _ServerBoundary:
    kind: _BoundaryKind
    marker: str


type _TraceEvent = (
    _ClientCreate | _ClientInvalid | _ServerCreated | _ServerTerminal | _ServerBoundary
)


@dataclass(frozen=True, slots=True)
class _TraceCase:
    key: str
    axes: tuple[tuple[str, str], ...]
    events: tuple[_TraceEvent, ...]
    sensitive_marker: str

    def axis(self, name: str) -> str | None:
        return next((value for axis_name, value in self.axes if axis_name == name), None)

    def describe(self) -> str:
        rendered_axes = ", ".join(f"{name}={value}" for name, value in self.axes)
        rendered_events = " -> ".join(_describe_event(event) for event in self.events)
        return f"{self.key} [{rendered_axes}] {rendered_events}"


@dataclass(slots=True)
class _ReferenceLedger:
    """External ownership proof and accepted-source ledger for one trace."""

    unresolved_requests: dict[str, _Intent] = field(default_factory=dict)
    response_owners: dict[str, _Intent] = field(default_factory=dict)
    retained_prewarm_ids: set[str] = field(default_factory=set)
    ambiguous: bool = False
    ambiguity_reason: str | None = None
    accepted_input: dict[str, int] = field(default_factory=dict)
    report_attempts: dict[str, int] = field(default_factory=dict)
    ignored_input: dict[str, int] = field(default_factory=dict)

    def observe(self, event: _TraceEvent) -> None:
        if isinstance(event, _ClientCreate):
            self._observe_client_create(event)
            return
        if isinstance(event, _ClientInvalid):
            reason = "correlation_cap" if event.kind == "work-limit" else "unknown_client_event"
            self._lose_proof(reason)
            return
        if isinstance(event, _ServerCreated):
            self._observe_created(event)
            return
        if isinstance(event, _ServerTerminal):
            self._observe_terminal(event)
            return
        reason = "correlation_cap" if event.kind == "work-limit" else "server_error"
        self._lose_proof(reason)

    def _observe_client_create(self, event: _ClientCreate) -> None:
        if self.ambiguous:
            return
        if self.unresolved_requests or self.response_owners:
            self._lose_proof("overlapping_request")
            return
        self.unresolved_requests[event.request_key] = event.intent

    def _observe_created(self, event: _ServerCreated) -> None:
        if self.ambiguous:
            return
        response_id = event.response_id
        if event.shape != "valid" or response_id is None:
            self._lose_proof("invalid_lifecycle")
            return
        if response_id in self.retained_prewarm_ids:
            self._lose_proof("invalid_lifecycle")
            return
        owner_request_key = event.owner_request_key
        if (
            len(self.unresolved_requests) != 1
            or self.response_owners
            or owner_request_key not in self.unresolved_requests
        ):
            self._lose_proof("invalid_lifecycle")
            return
        intent = self.unresolved_requests.pop(owner_request_key)
        self.response_owners[response_id] = intent

    def _observe_terminal(self, event: _ServerTerminal) -> None:
        response_id = event.response_id
        if self.ambiguous:
            self._record_positive_attempt(event, suppressed=False)
            return
        if event.shape != "valid" or response_id is None:
            if self.unresolved_requests or self.response_owners:
                self._lose_proof("invalid_lifecycle")
            self._record_positive_attempt(event, suppressed=False)
            return
        if response_id in self.retained_prewarm_ids:
            if self.unresolved_requests:
                self._lose_proof("invalid_lifecycle")
                self._record_positive_attempt(event, suppressed=False)
                return
            self._record_positive_attempt(event, suppressed=True)
            return
        if self.response_owners and response_id not in self.response_owners:
            self._lose_proof("invalid_lifecycle")
            self._record_positive_attempt(event, suppressed=False)
            return
        if self.unresolved_requests and response_id not in self.response_owners:
            self._lose_proof("invalid_lifecycle")
            self._record_positive_attempt(event, suppressed=False)
            return
        intent = self.response_owners.get(response_id)
        self._record_positive_attempt(event, suppressed=intent == "prewarm")
        if intent is None:
            return
        self.response_owners.pop(response_id)
        if intent == "prewarm":
            self.retained_prewarm_ids.add(response_id)

    def _record_positive_attempt(self, event: _ServerTerminal, *, suppressed: bool) -> None:
        if event.usage_shape != "positive" or event.response_id is None:
            return
        response_id = event.response_id
        if suppressed:
            previous = self.ignored_input.setdefault(response_id, event.quantity)
            assert previous == event.quantity
            return
        self.report_attempts[response_id] = self.report_attempts.get(response_id, 0) + 1
        previous = self.accepted_input.setdefault(response_id, event.quantity)
        assert previous == event.quantity

    def _lose_proof(self, reason: str) -> None:
        if self.ambiguous:
            return
        self.ambiguous = True
        self.ambiguity_reason = reason
        self.unresolved_requests.clear()
        self.response_owners.clear()
        self.retained_prewarm_ids.clear()


def _stable_index(key: str, salt: str, size: int) -> int:
    digest = hashlib.sha256(f"{_GENERATION_SEED}:{key}:{salt}".encode()).digest()
    return int.from_bytes(digest[:8]) % size


def _stable_bool(key: str, salt: str) -> bool:
    return _stable_index(key, salt, 2) == 1


def _describe_event(event: _TraceEvent) -> str:
    if isinstance(event, _ClientCreate):
        return f"client-create({event.request_key},{event.intent})"
    if isinstance(event, _ClientInvalid):
        return f"client-{event.kind}"
    if isinstance(event, _ServerCreated):
        return f"created({event.shape},{event.response_id})"
    if isinstance(event, _ServerTerminal):
        return (
            f"terminal({event.event_type},{event.shape},{event.response_id},"
            f"{event.usage_shape},{event.quantity})"
        )
    return f"server-{event.kind}"


def _render_client_create(event: _ClientCreate) -> bytes:
    marker: dict[str, object] = {"type": "response.create"}
    if event.intent == "prewarm":
        marker["generate"] = False
    return json.dumps(marker, separators=(",", ":")).encode()


def _render_client_invalid(event: _ClientInvalid) -> bytes:
    if event.kind == "unknown":
        return json.dumps(
            {"type": "future.request", "input": event.marker},
            separators=(",", ":"),
        ).encode()
    if event.kind == "malformed":
        return f'{{"type":"response.create","input":"{event.marker}"'.encode()
    return (
        b'{"type":"response.create","generate":false,"input":"'
        + event.marker.encode()
        + b'","padding":['
        + b",".join([b"0"] * 40_000)
        + b"]}"
    )


def _render_created(event: _ServerCreated) -> bytes:
    if event.shape == "missing-id":
        return b'{"type":"response.created","response":{}}'
    if event.shape == "conflicting-id":
        return b'{"type":"response.created","response":{"id":"first","id":"second"}}'
    assert event.response_id is not None
    return json.dumps(
        {"type": "response.created", "response": {"id": event.response_id}},
        separators=(",", ":"),
    ).encode()


def _render_terminal(event: _ServerTerminal) -> bytes:
    if event.shape == "conflicting-id":
        return (
            b'{"type":"' + event.event_type.encode() + b'","response":{"id":"first","id":"second"}}'
        )
    response: dict[str, object] = {}
    if event.shape == "valid":
        assert event.response_id is not None
        response["id"] = event.response_id
    if event.usage_shape != "absent":
        response["model"] = "gpt-5.5"
        quantity = MAX_USAGE_QUANTITY + 1 if event.usage_shape == "error" else event.quantity
        response["usage"] = {"input_tokens": quantity, "output_tokens": 0}
    return json.dumps(
        {"type": event.event_type, "response": response},
        separators=(",", ":"),
    ).encode()


def _render_boundary(event: _ServerBoundary) -> bytes:
    if event.kind == "error":
        return json.dumps(
            {"type": "error", "error": {"code": "busy", "message": event.marker}},
            separators=(",", ":"),
        ).encode()
    return (
        b'{"type":"error","marker":"'
        + event.marker.encode()
        + b'","padding":['
        + b",".join([b"0"] * 40_000)
        + b"]}"
    )


def _render_event(event: _TraceEvent) -> tuple[bool, bytes]:
    if isinstance(event, _ClientCreate):
        return True, _render_client_create(event)
    if isinstance(event, _ClientInvalid):
        return True, _render_client_invalid(event)
    if isinstance(event, _ServerCreated):
        return False, _render_created(event)
    if isinstance(event, _ServerTerminal):
        return False, _render_terminal(event)
    return False, _render_boundary(event)


def _positive_terminal(event_type: str, response_id: str, quantity: int) -> _ServerTerminal:
    return _ServerTerminal(
        event_type=event_type,
        response_id=response_id,
        usage_shape="positive",
        quantity=quantity,
    )


def _exact_cases() -> tuple[_TraceCase, ...]:
    cases: list[_TraceCase] = []
    for intent, terminal_event, usage_shape, duplicate in product(
        ("normal", "prewarm"),
        _TERMINAL_EVENTS,
        ("absent", "zero", "positive", "error"),
        (False, True),
    ):
        key = f"exact-{intent}-{terminal_event}-{usage_shape}-duplicate-{duplicate}"
        response_id = f"response-{len(cases)}"
        quantity = 10 + _stable_index(key, "quantity", 50)
        terminal = _ServerTerminal(
            event_type=terminal_event,
            response_id=response_id,
            usage_shape=usage_shape,
            quantity=0 if usage_shape == "zero" else quantity,
        )
        events: list[_TraceEvent] = [
            _ClientCreate("request-1", intent),
            _ServerCreated("request-1", response_id),
            terminal,
        ]
        if usage_shape in ("absent", "zero", "error"):
            late_usage = _positive_terminal(terminal_event, response_id, quantity)
            events.append(late_usage)
            if duplicate:
                events.append(late_usage)
        elif duplicate:
            events.append(terminal)
        if usage_shape == "error":
            next_response_id = f"{response_id}-next"
            next_quantity = quantity + 1
            events.extend(
                (
                    _ClientCreate("request-2", intent),
                    _ServerCreated("request-2", next_response_id),
                    _positive_terminal(terminal_event, next_response_id, next_quantity),
                )
            )
        cases.append(
            _TraceCase(
                key=key,
                axes=(
                    ("family", "exact"),
                    ("intent", intent),
                    ("terminal", terminal_event),
                    ("usage", usage_shape),
                    ("duplicate", str(duplicate).lower()),
                ),
                events=tuple(events),
                sensitive_marker=f"trace-sensitive-{key}",
            )
        )
    return tuple(cases)


@dataclass(frozen=True, slots=True)
class _Prefix:
    events: tuple[_TraceEvent, ...]
    active_response_id: str | None = None
    retained_response_id: str | None = None


def _prefix_for_case(prefix: _PrefixKind, key: str, terminal_event: str) -> _Prefix:
    if prefix == "idle":
        return _Prefix(())
    intent: _Intent = "prewarm" if prefix.endswith("prewarm") else "normal"
    request = _ClientCreate("prefix-request", intent)
    if prefix.startswith("pending"):
        return _Prefix((request,))
    response_id = f"prefix-response-{hashlib.sha256(key.encode()).hexdigest()[:12]}"
    created = _ServerCreated("prefix-request", response_id)
    if prefix.startswith("active"):
        return _Prefix((request, created), active_response_id=response_id)
    retained = _positive_terminal(terminal_event, response_id, 7)
    return _Prefix(
        (request, created, retained),
        retained_response_id=response_id,
    )


_COMMON_TRIGGERS: tuple[_TriggerKind, ...] = (
    "unknown-client",
    "malformed-client",
    "client-work-limit",
    "created-missing-id",
    "created-conflicting-id",
    "server-error",
    "server-work-limit",
)
_PENDING_ACTIVE_TRIGGERS: tuple[_TriggerKind, ...] = (
    "overlap-normal",
    "overlap-prewarm",
    "terminal-missing-id",
    "terminal-conflicting-id",
    "unbound-positive-usage",
)


def _triggers_for_prefix(prefix: _PrefixKind) -> tuple[_TriggerKind, ...]:
    triggers = list(_COMMON_TRIGGERS)
    if prefix.startswith(("pending", "active")):
        triggers.extend(_PENDING_ACTIVE_TRIGGERS)
    if prefix == "retained-prewarm":
        triggers.append("created-reused-id")
    return tuple(triggers)


def _verification_relations(prefix: _PrefixKind) -> tuple[_VerificationRelation, ...]:
    if prefix.startswith("active"):
        return ("active", "fresh")
    if prefix == "retained-prewarm":
        return ("retained", "fresh")
    return ("fresh",)


def _trigger_events(
    trigger: _TriggerKind,
    prefix: _Prefix,
    terminal_event: str,
    marker: str,
) -> tuple[_TraceEvent, ...]:
    if trigger == "overlap-normal":
        return (_ClientCreate("overlap-request", "normal"),)
    if trigger == "overlap-prewarm":
        return (_ClientCreate("overlap-request", "prewarm"),)
    if trigger == "unknown-client":
        return (_ClientInvalid("unknown", marker),)
    if trigger == "malformed-client":
        return (_ClientInvalid("malformed", marker),)
    if trigger == "client-work-limit":
        return (_ClientInvalid("work-limit", marker),)
    if trigger == "created-missing-id":
        return (_ServerCreated(None, None, "missing-id"),)
    if trigger == "created-conflicting-id":
        return (_ServerCreated(None, None, "conflicting-id"),)
    if trigger == "created-reused-id":
        assert prefix.retained_response_id is not None
        return (
            _ClientCreate("reuse-request", "normal"),
            _ServerCreated("reuse-request", prefix.retained_response_id),
        )
    if trigger == "terminal-missing-id":
        return (_ServerTerminal(terminal_event, None, shape="missing-id"),)
    if trigger == "terminal-conflicting-id":
        return (_ServerTerminal(terminal_event, None, shape="conflicting-id"),)
    if trigger == "server-error":
        return (_ServerBoundary("error", marker),)
    if trigger == "server-work-limit":
        return (_ServerBoundary("work-limit", marker),)
    response_id = f"unbound-{hashlib.sha256(marker.encode()).hexdigest()[:12]}"
    return (_positive_terminal(terminal_event, response_id, 13),)


def _ambiguity_cases() -> tuple[_TraceCase, ...]:
    cases: list[_TraceCase] = []
    prefixes: tuple[_PrefixKind, ...] = (
        "idle",
        "pending-normal",
        "pending-prewarm",
        "active-normal",
        "active-prewarm",
        "retained-prewarm",
    )
    for prefix_kind in prefixes:
        for trigger, relation, terminal_event in product(
            _triggers_for_prefix(prefix_kind),
            _verification_relations(prefix_kind),
            _TERMINAL_EVENTS,
        ):
            key = f"ambiguous-{prefix_kind}-{trigger}-{relation}-{terminal_event}"
            marker = f"trace-sensitive-{key}"
            prefix = _prefix_for_case(prefix_kind, key, terminal_event)
            trigger_events = _trigger_events(trigger, prefix, terminal_event, marker)
            if relation == "active":
                assert prefix.active_response_id is not None
                verification_id = prefix.active_response_id
            elif relation == "retained":
                assert prefix.retained_response_id is not None
                verification_id = prefix.retained_response_id
            else:
                verification_id = f"verify-{hashlib.sha256(key.encode()).hexdigest()[:12]}"
            quantity = 20 + _stable_index(key, "quantity", 40)
            verification = _positive_terminal(terminal_event, verification_id, quantity)
            sticky_id = f"sticky-{hashlib.sha256((key + '-sticky').encode()).hexdigest()[:12]}"
            sticky = _positive_terminal(terminal_event, sticky_id, quantity + 1)
            events: list[_TraceEvent] = [*prefix.events, *trigger_events, verification]
            duplicate = _stable_bool(key, "duplicate")
            if duplicate:
                events.append(verification)
            events.append(sticky)
            cases.append(
                _TraceCase(
                    key=key,
                    axes=(
                        ("family", "ambiguity"),
                        ("prefix", prefix_kind),
                        ("trigger", trigger),
                        ("relation", relation),
                        ("terminal", terminal_event),
                        ("duplicate", str(duplicate).lower()),
                    ),
                    events=tuple(events),
                    sensitive_marker=marker,
                )
            )
    return tuple(cases)


def _retained_duplicate_during_active_case() -> _TraceCase:
    terminal_event = _TERMINAL_EVENTS[0]
    retained_usage = _positive_terminal(terminal_event, "shared-retained", 5)
    return _TraceCase(
        key="target-retained-duplicate-during-active",
        axes=(("family", "targeted"), ("tuple", "retained-duplicate-during-active")),
        events=(
            _ClientCreate("warm-request", "prewarm"),
            _ServerCreated("warm-request", "shared-retained"),
            retained_usage,
            _ClientCreate("normal-request", "normal"),
            _ServerCreated("normal-request", "normal-active"),
            retained_usage,
            _positive_terminal(terminal_event, "normal-active", 9),
        ),
        sensitive_marker="trace-sensitive-target-retained-duplicate-during-active",
    )


_EXACT_CASES = _exact_cases()
_AMBIGUITY_CASES = _ambiguity_cases()
_GENERATED_CASES = (*_EXACT_CASES, *_AMBIGUITY_CASES, _retained_duplicate_during_active_case())


def _reference_for_case(case: _TraceCase) -> _ReferenceLedger:
    ledger = _ReferenceLedger()
    for event in case.events:
        ledger.observe(event)
    return ledger


def _correlation_entries(flow: http.HTTPFlow) -> list[dict[str, object]]:
    proxy_log = Path(flow.metadata[metadata_keys.SANDBOX_PROXY_LOG_PATH])
    if not jsonl_exists_after_flush(proxy_log):
        return []
    return [
        entry
        for entry in read_jsonl_entries_after_flush(proxy_log)
        if entry.get("type") == "model_usage_correlation" and entry.get("flow_id") == flow.id
    ]


def _flow_source_entries(flow: http.HTTPFlow) -> list[dict[str, object]]:
    return [entry for entry in model_usage_source_entries(flow) if entry.get("flow_id") == flow.id]


def _entry_input_quantity(entry: dict[str, object]) -> int:
    source_usage = entry.get("usage")
    assert isinstance(source_usage, dict)
    quantity = source_usage.get("tokens.input")
    assert isinstance(quantity, int)
    return quantity


def _accepted_flags(entry: dict[str, object], field_name: str) -> list[bool]:
    raw_items = entry.get(field_name)
    assert isinstance(raw_items, list)
    flags: list[bool] = []
    for raw_item in raw_items:
        assert isinstance(raw_item, dict)
        accepted = raw_item.get("buffer_accepted")
        assert isinstance(accepted, bool)
        flags.append(accepted)
    return flags


def _assert_source_entries(
    flow: http.HTTPFlow,
    expected: _ReferenceLedger,
    *,
    context: str,
) -> None:
    entries = _flow_source_entries(flow)
    ignored_entries = [entry for entry in entries if entry.get("disposition") == "ignored"]
    actual_ignored = {
        entry.get("provider_response_id"): _entry_input_quantity(entry) for entry in ignored_entries
    }
    assert actual_ignored == expected.ignored_input, context

    reported_entries = [entry for entry in entries if entry.get("disposition") != "ignored"]
    entries_by_response_id: dict[str, list[dict[str, object]]] = {}
    for entry in reported_entries:
        response_id = entry.get("provider_response_id")
        assert isinstance(response_id, str), context
        entries_by_response_id.setdefault(response_id, []).append(entry)
    assert set(entries_by_response_id) == set(expected.report_attempts), context
    for response_id, attempt_count in expected.report_attempts.items():
        attempts = entries_by_response_id[response_id]
        assert len(attempts) == attempt_count, context
        assert [_entry_input_quantity(entry) for entry in attempts] == [
            expected.accepted_input[response_id]
        ] * attempt_count, context
        assert [_accepted_flags(entry, "usage_events") for entry in attempts] == [
            [True],
            *([[False]] * (attempt_count - 1)),
        ], context


def _assert_diagnostics(
    flow: http.HTTPFlow,
    expected: _ReferenceLedger,
    *,
    marker: str,
    context: str,
) -> None:
    entries = _correlation_entries(flow)
    if expected.ambiguity_reason is None:
        assert entries == [], context
        return
    assert len(entries) == 1, context
    assert entries[0].get("reason") == expected.ambiguity_reason, context
    assert marker not in json.dumps(entries), context


async def _replay_case(flow: http.HTTPFlow, case: _TraceCase) -> None:
    for event in case.events:
        from_client, content = _render_event(event)
        if from_client:
            completion = feed_websocket_client_message(flow, content)
        else:
            completion = feed_websocket_server_message(flow, content)
        if completion is not None:
            await completion


def _assert_terminal_state_released(flow: http.HTTPFlow, *, context: str) -> None:
    assert model_provider_usage_sources(flow) == {}, context
    assert model_websocket_usage.is_enabled(flow) is False, context
    assert "_model_websocket_prewarm_state" not in flow.metadata, context


def test_generated_corpus_has_bounded_declared_coverage() -> None:
    assert len(_GENERATED_CASES) <= _MAX_GENERATED_REPLAY_CASES

    exact_axes = {
        (
            case.axis("intent"),
            case.axis("terminal"),
            case.axis("usage"),
            case.axis("duplicate"),
        )
        for case in _EXACT_CASES
    }
    assert exact_axes == set(
        product(
            ("normal", "prewarm"),
            _TERMINAL_EVENTS,
            ("absent", "zero", "positive", "error"),
            ("false", "true"),
        )
    )

    expected_ambiguity_axes = {
        (prefix, trigger, relation, terminal)
        for prefix in (
            "idle",
            "pending-normal",
            "pending-prewarm",
            "active-normal",
            "active-prewarm",
            "retained-prewarm",
        )
        for trigger in _triggers_for_prefix(prefix)
        for relation in _verification_relations(prefix)
        for terminal in _TERMINAL_EVENTS
    }
    actual_ambiguity_axes = {
        (
            case.axis("prefix"),
            case.axis("trigger"),
            case.axis("relation"),
            case.axis("terminal"),
        )
        for case in _AMBIGUITY_CASES
    }
    assert actual_ambiguity_axes == expected_ambiguity_axes
    assert {case.axis("relation") for case in _AMBIGUITY_CASES} == {
        "active",
        "retained",
        "fresh",
    }
    assert {case.axis("trigger") for case in _AMBIGUITY_CASES} == {
        "overlap-normal",
        "overlap-prewarm",
        "unknown-client",
        "malformed-client",
        "client-work-limit",
        "created-missing-id",
        "created-conflicting-id",
        "created-reused-id",
        "terminal-missing-id",
        "terminal-conflicting-id",
        "server-error",
        "server-work-limit",
        "unbound-positive-usage",
    }
    assert any(case.axis("usage") == "error" for case in _EXACT_CASES)
    assert any(case.axis("usage") == "absent" for case in _EXACT_CASES)
    assert any(case.axis("usage") == "zero" for case in _EXACT_CASES)
    assert any(case.key == "target-retained-duplicate-during-active" for case in _GENERATED_CASES)


@pytest.mark.parametrize("case", _GENERATED_CASES, ids=lambda case: case.key)
async def test_generated_websocket_prewarm_trace_matches_reference_model(
    case: _TraceCase,
    tmp_path: Path,
    real_flow: RealFlowFactory,
    usage_webhook_api: _UsageWebhookApi,
    sync_usage_executor: object,
) -> None:
    del sync_usage_executor
    flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(flow)
    expected = _reference_for_case(case)
    context = case.describe()

    with usage_webhook_api() as webhook:
        await _replay_case(flow, case)
        mitm_addon.websocket_end(flow)
        usage.flush_usage_events(trigger="test")

    expected_rows = [
        ("gpt-5.5", "tokens.input", quantity) for quantity in expected.accepted_input.values()
    ]
    assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
    _assert_source_entries(flow, expected, context=context)
    _assert_diagnostics(
        flow,
        expected,
        marker=case.sensitive_marker,
        context=context,
    )
    _assert_terminal_state_released(flow, context=context)


@pytest.mark.parametrize("ambiguous_intent", ["normal", "prewarm"])
async def test_generated_websocket_prewarm_state_isolated_across_terminated_flows(
    ambiguous_intent: _Intent,
    tmp_path: Path,
    real_flow: RealFlowFactory,
    usage_webhook_api: _UsageWebhookApi,
    sync_usage_executor: object,
) -> None:
    del sync_usage_executor
    exact_flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    ambiguous_flow = make_openai_responses_websocket_flow(real_flow, tmp_path)
    mitm_addon.responseheaders(exact_flow)
    mitm_addon.responseheaders(ambiguous_flow)
    terminal_event = _TERMINAL_EVENTS[0]
    exact_case = _TraceCase(
        key="isolation-exact",
        axes=(("family", "isolation"), ("role", "exact")),
        events=(
            _ClientCreate("exact-request", "prewarm"),
            _ServerCreated("exact-request", "shared-response"),
            _positive_terminal(terminal_event, "shared-response", 5),
        ),
        sensitive_marker="isolation-exact-marker",
    )
    ambiguous_case = _TraceCase(
        key=f"isolation-ambiguous-{ambiguous_intent}",
        axes=(("family", "isolation"), ("role", "ambiguous")),
        events=(
            _ClientCreate("ambiguous-request", ambiguous_intent),
            _ServerCreated("ambiguous-request", "shared-response"),
            _ClientInvalid("malformed", "isolation-sensitive-marker"),
            _positive_terminal(terminal_event, "shared-response", 7),
        ),
        sensitive_marker="isolation-sensitive-marker",
    )
    exact_expected = _reference_for_case(exact_case)
    ambiguous_expected = _reference_for_case(ambiguous_case)

    with usage_webhook_api() as webhook:
        await _replay_case(exact_flow, exact_case)
        await _replay_case(ambiguous_flow, ambiguous_case)
        mitm_addon.websocket_end(exact_flow)
        _assert_terminal_state_released(exact_flow, context=exact_case.describe())
        assert model_websocket_usage.is_enabled(ambiguous_flow)
        mitm_addon.websocket_end(ambiguous_flow)
        usage.flush_usage_events(trigger="test")

    expected_rows = [("gpt-5.5", "tokens.input", 7)]
    assert_usage_event_rows(webhook.usage_events(), "provider", expected_rows)
    _assert_source_entries(exact_flow, exact_expected, context=exact_case.describe())
    _assert_source_entries(
        ambiguous_flow,
        ambiguous_expected,
        context=ambiguous_case.describe(),
    )
    _assert_diagnostics(
        exact_flow,
        exact_expected,
        marker=exact_case.sensitive_marker,
        context=exact_case.describe(),
    )
    _assert_diagnostics(
        ambiguous_flow,
        ambiguous_expected,
        marker=ambiguous_case.sensitive_marker,
        context=ambiguous_case.describe(),
    )
    _assert_terminal_state_released(ambiguous_flow, context=ambiguous_case.describe())
