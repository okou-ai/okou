"""Bound bodies buffered until publicDestination authorization is revalidated."""

from mitmproxy import http

import flow_metadata_keys as metadata_keys
import request_body_admission

# Match the existing buffered-auth envelope, with an independent budget owner.
MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024
MAX_ADMITTED_REQUESTS = 16
MAX_ADMITTED_BODY_BYTES = 128 * 1024 * 1024

_budget = request_body_admission.RequestBodyAdmissionBudget(
    metadata_key=metadata_keys.PUBLIC_DESTINATION_BODY_ADMISSION,
    negative_size_message="publicDestination request body size cannot be negative",
    already_attached_message="publicDestination request-body admission is already attached",
)


def reserve(body_bytes: int) -> request_body_admission.RequestBodyAdmissionLease:
    """Reserve count and byte capacity before native request-body buffering."""
    return _budget.reserve(
        body_bytes,
        max_admitted_count=MAX_ADMITTED_REQUESTS,
        max_admitted_body_bytes=MAX_ADMITTED_BODY_BYTES,
    )


def attach_to_flow(
    flow: http.HTTPFlow, admission: request_body_admission.RequestBodyAdmissionLease
) -> None:
    _budget.attach_to_flow(flow, admission)


def release(admission: request_body_admission.RequestBodyAdmissionLease) -> None:
    _budget.release(admission)


def release_from_flow(flow: http.HTTPFlow) -> None:
    """Release the retaining flow's capacity exactly once after terminal use."""
    _budget.release_from_flow(flow)


def reset_for_tests() -> None:
    _budget.reset_for_tests()
