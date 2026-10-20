"""Shared count-and-byte admission for retained request bodies."""

from __future__ import annotations

import threading

from mitmproxy import http


class RequestBodyAdmissionCountSaturatedError(Exception):
    """Raised when an admission budget has no request-count capacity."""


class RequestBodyAdmissionByteSaturatedError(Exception):
    """Raised when an admission budget has no aggregate byte capacity."""


class RequestBodyAdmissionLease:
    """Opaque reservation owned by one request-body admission budget."""

    __slots__ = ("_body_bytes", "_budget", "_count_scope", "_released")

    def __init__(
        self, budget: RequestBodyAdmissionBudget, body_bytes: int, count_scope: str | None
    ) -> None:
        self._budget = budget
        self._body_bytes = body_bytes
        self._count_scope = count_scope
        self._released = False


class RequestBodyAdmissionBudget:
    """Own scoped request counts and one aggregate byte total for a body policy."""

    def __init__(
        self,
        *,
        metadata_key: str,
        negative_size_message: str,
        already_attached_message: str,
    ) -> None:
        self._metadata_key = metadata_key
        self._negative_size_message = negative_size_message
        self._already_attached_message = already_attached_message
        self._lock = threading.Lock()
        self._admitted_counts: dict[str | None, int] = {}
        self._admitted_body_bytes = 0

    def reserve(
        self,
        body_bytes: int,
        *,
        max_admitted_count: int,
        max_admitted_body_bytes: int,
        count_scope: str | None = None,
    ) -> RequestBodyAdmissionLease:
        """Reserve a scoped count and shared bytes atomically; default count is global."""
        self._validate_body_size(body_bytes)

        with self._lock:
            count = self._admitted_counts.get(count_scope, 0)
            if count + 1 > max_admitted_count:
                raise RequestBodyAdmissionCountSaturatedError
            if self._admitted_body_bytes + body_bytes > max_admitted_body_bytes:
                raise RequestBodyAdmissionByteSaturatedError
            self._admitted_counts[count_scope] = count + 1
            self._admitted_body_bytes += body_bytes
            return RequestBodyAdmissionLease(self, body_bytes, count_scope)

    def resize(
        self,
        admission: RequestBodyAdmissionLease,
        body_bytes: int,
        *,
        max_admitted_body_bytes: int,
        already_released_message: str,
    ) -> None:
        """Resize an existing reservation while preserving aggregate capacity."""
        self._require_owner(admission)
        self._validate_body_size(body_bytes)

        with self._lock:
            if admission._released:
                raise RuntimeError(already_released_message)
            delta = body_bytes - admission._body_bytes
            if delta > 0 and self._admitted_body_bytes + delta > max_admitted_body_bytes:
                raise RequestBodyAdmissionByteSaturatedError
            self._admitted_body_bytes += delta
            admission._body_bytes = body_bytes

    def release(self, admission: RequestBodyAdmissionLease) -> None:
        """Release aggregate capacity exactly once."""
        self._require_owner(admission)

        with self._lock:
            if admission._released:
                return
            admission._released = True
            remaining = self._admitted_counts[admission._count_scope] - 1
            if remaining:
                self._admitted_counts[admission._count_scope] = remaining
            else:
                del self._admitted_counts[admission._count_scope]
            self._admitted_body_bytes -= admission._body_bytes

    def attach_to_flow(
        self,
        flow: http.HTTPFlow,
        admission: RequestBodyAdmissionLease,
    ) -> None:
        """Attach a reservation to its retaining flow."""
        if self._metadata_key in flow.metadata:
            raise RuntimeError(self._already_attached_message)
        self._require_owner(admission)
        flow.metadata[self._metadata_key] = admission

    def take_from_flow(self, flow: http.HTTPFlow) -> RequestBodyAdmissionLease | None:
        """Remove and return this budget's flow reservation, if present."""
        admission = flow.metadata.get(self._metadata_key)
        if not isinstance(admission, RequestBodyAdmissionLease):
            flow.metadata.pop(self._metadata_key, None)
            return None
        self._require_owner(admission)
        flow.metadata.pop(self._metadata_key)
        return admission

    def release_from_flow(self, flow: http.HTTPFlow) -> None:
        """Release this budget's reservation attached to a flow."""
        admission = self.take_from_flow(flow)
        if admission is not None:
            self.release(admission)

    def state_for_tests(self) -> tuple[int, int]:
        """Return admitted count and body bytes for tests."""
        with self._lock:
            return sum(self._admitted_counts.values()), self._admitted_body_bytes

    def reset_for_tests(self) -> None:
        """Reset aggregate admission between tests."""
        with self._lock:
            self._admitted_counts.clear()
            self._admitted_body_bytes = 0

    def _validate_body_size(self, body_bytes: int) -> None:
        if body_bytes < 0:
            raise ValueError(self._negative_size_message)

    def _require_owner(self, admission: RequestBodyAdmissionLease) -> None:
        if admission._budget is not self:
            raise RuntimeError("request-body admission belongs to another budget")
