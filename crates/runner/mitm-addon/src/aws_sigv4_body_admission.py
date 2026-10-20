"""Aggregate admission for request bodies retained by AWS SigV4 signing."""

from mitmproxy import http

import flow_metadata_keys as metadata_keys
import request_body_admission

# Match the established auth.base buffered-request envelope while keeping the
# two admission owners independent: auth.base also reserves forwarder capacity.
MAX_AWS_SIGV4_REQUEST_BODY_BYTES = 32 * 1024 * 1024
MAX_ADMITTED_AWS_SIGV4_REQUESTS = 16
MAX_ADMITTED_AWS_SIGV4_REQUEST_BODY_BYTES = 128 * 1024 * 1024


class AwsSigV4BodyAdmissionSaturatedError(Exception):
    """Raised when the retained SigV4 request-body budget is full."""


_budget = request_body_admission.RequestBodyAdmissionBudget(
    metadata_key=metadata_keys.AWS_SIGV4_BODY_ADMISSION,
    negative_size_message="AWS SigV4 request body size cannot be negative",
    already_attached_message="AWS SigV4 request-body admission is already attached",
)


def reserve(body_bytes: int) -> request_body_admission.RequestBodyAdmissionLease:
    """Reserve aggregate capacity before mitmproxy buffers a SigV4 body."""
    try:
        return _budget.reserve(
            body_bytes,
            max_admitted_count=MAX_ADMITTED_AWS_SIGV4_REQUESTS,
            max_admitted_body_bytes=MAX_ADMITTED_AWS_SIGV4_REQUEST_BODY_BYTES,
        )
    except request_body_admission.RequestBodyAdmissionCountSaturatedError:
        raise AwsSigV4BodyAdmissionSaturatedError(
            "AWS SigV4 request-body admission is full"
        ) from None
    except request_body_admission.RequestBodyAdmissionByteSaturatedError:
        raise AwsSigV4BodyAdmissionSaturatedError(
            "AWS SigV4 request-body byte budget is full"
        ) from None


def release(admission: request_body_admission.RequestBodyAdmissionLease) -> None:
    """Release aggregate capacity exactly once."""
    _budget.release(admission)


def attach_to_flow(
    flow: http.HTTPFlow,
    admission: request_body_admission.RequestBodyAdmissionLease,
) -> None:
    """Attach a reservation to its retaining flow."""
    _budget.attach_to_flow(flow, admission)


def take_from_flow(
    flow: http.HTTPFlow,
) -> request_body_admission.RequestBodyAdmissionLease | None:
    """Remove and return the flow reservation, if present."""
    return _budget.take_from_flow(flow)


def release_from_flow(flow: http.HTTPFlow) -> None:
    """Release any reservation attached to a flow."""
    _budget.release_from_flow(flow)


def require_from_flow(flow: http.HTTPFlow) -> None:
    """Require a live AWS reservation covering the body before hashing/signing."""
    _budget.require_from_flow(flow, len(flow.request.raw_content or b""))


def state_for_tests() -> tuple[int, int]:
    """Return admitted flow count and declared bytes for tests."""
    return _budget.state_for_tests()


def reset_for_tests() -> None:
    """Reset aggregate admission between tests."""
    _budget.reset_for_tests()
