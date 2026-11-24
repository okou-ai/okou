"""Project managed OpenRouter response metadata into the existing HTTP log."""

import json
import re

from mitmproxy import http

from usage.sse import SseUsageScanner

HEADER = "X-OpenRouter-Metadata"
_OPTED_IN = "_openrouter_routing_opted_in"
_OBSERVATION = "_openrouter_routing_observation"
_GENERATION_ID = re.compile(r"gen-[A-Za-z0-9-]{1,124}")
_MAX_DOCUMENT_BYTES = 64 * 1024
_MAX_ATTEMPTS = 32
_MAX_LABEL_LENGTH = 128
_MIN_HTTP_STATUS = 100
_MAX_HTTP_STATUS = 599


def enable(flow: http.HTTPFlow) -> None:
    flow.request.headers[HEADER] = "enabled"
    flow.metadata[_OPTED_IN] = True


def is_enabled(flow: http.HTTPFlow) -> bool:
    return flow.metadata.get(_OPTED_IN) is True


def observe_headers(flow: http.HTTPFlow) -> None:
    if is_enabled(flow) and flow.response is not None:
        generation_id = flow.response.headers.get("X-Generation-Id", "")
        observation = RoutingObservation()
        if _GENERATION_ID.fullmatch(generation_id):
            observation.fields["generation_id"] = generation_id
        flow.metadata[_OBSERVATION] = observation


def observation(flow: http.HTTPFlow) -> RoutingObservation | None:
    return flow.metadata.get(_OBSERVATION)


def take_fields(flow: http.HTTPFlow) -> dict:
    route = flow.metadata.pop(_OBSERVATION, None)
    if route is None:
        return {}
    if not route.streaming:
        route.finish_document()
    return {"openrouter": route.fields} if route.fields else {}


def release(flow: http.HTTPFlow) -> None:
    flow.metadata.pop(_OPTED_IN, None)
    flow.metadata.pop(_OBSERVATION, None)


def _label(value: object) -> str | None:
    if isinstance(value, str) and 0 < len(value) <= _MAX_LABEL_LENGTH and value.isprintable():
        return value
    return None


class RoutingObservation:
    def __init__(self) -> None:
        self.fields: dict = {}
        self.streaming = False
        self._document = bytearray()
        self._oversize = False

    def sse_scanner(self) -> SseUsageScanner:
        self.streaming = True
        return SseUsageScanner(self, capture_data_without_event=True)

    def should_capture_event(self, event_name: str | None) -> bool:
        return event_name in (
            None,
            "response.created",
            "response.completed",
            "response.incomplete",
            "response.failed",
            "error",
        )

    def on_event_start(self, event_name: str | None) -> None:
        self.on_event_discard(None)

    def on_data(self, chunk: bytes) -> None:
        if self._oversize:
            return
        if len(self._document) + len(chunk) > _MAX_DOCUMENT_BYTES:
            self._oversize = True
            self._document.clear()
            return
        self._document.extend(chunk)

    def on_data_separator(self) -> None:
        self.on_data(b"\n")

    def accepts_more_input(self) -> bool:
        return not self._oversize

    def on_event_end(self, event_name: str | None) -> None:
        self.finish_document()
        self.on_event_discard(None)

    def on_event_discard(self, event_name: str | None) -> None:
        self._document.clear()
        self._oversize = False

    def finish_document(self) -> None:
        if not self._document or self._oversize:
            return
        if (
            self.streaming
            and b'"openrouter_metadata"' not in self._document
            and ("model" in self.fields or b'"model"' not in self._document)
            and ("generation_id" in self.fields or b'"id"' not in self._document)
            and ("provider" in self.fields or b'"provider"' not in self._document)
        ):
            return
        try:
            data = json.loads(self._document)
        except ValueError, RecursionError:
            return
        if not isinstance(data, dict):
            return
        response = data.get("response")
        if not isinstance(response, dict):
            response = data
        generation_id = response.get("id")
        if isinstance(generation_id, str) and _GENERATION_ID.fullmatch(generation_id):
            self.fields.setdefault("generation_id", generation_id)
        model = _label(response.get("model"))
        if model is not None:
            self.fields["model"] = model
        provider = _label(response.get("provider"))
        if provider is not None:
            self.fields["provider"] = provider
        metadata = data.get("openrouter_metadata", response.get("openrouter_metadata"))
        if not isinstance(metadata, dict):
            return
        endpoints = metadata.get("endpoints")
        available = endpoints.get("available") if isinstance(endpoints, dict) else None
        if isinstance(available, list):
            for endpoint in available:
                if isinstance(endpoint, dict) and endpoint.get("selected") is True:
                    provider = _label(endpoint.get("provider"))
                    if provider is not None:
                        self.fields["provider"] = provider
                    selected_model = _label(endpoint.get("model"))
                    if selected_model is not None:
                        self.fields["model"] = selected_model
                    break
        attempts = metadata.get("attempts")
        if isinstance(attempts, list):
            recorded = []
            for attempt in attempts[:_MAX_ATTEMPTS]:
                if not isinstance(attempt, dict):
                    continue
                provider = _label(attempt.get("provider"))
                attempt_model = _label(attempt.get("model"))
                status = attempt.get("status")
                if (
                    provider is not None
                    and attempt_model is not None
                    and type(status) is int
                    and _MIN_HTTP_STATUS <= status <= _MAX_HTTP_STATUS
                ):
                    recorded.append(
                        {"provider": provider, "model": attempt_model, "status": status}
                    )
            self.fields["attempts"] = recorded
            if len(recorded) != len(attempts):
                self.fields["attempts_incomplete"] = True
