"""Resource-safety invariants for shared request-body admission budgets."""

import pytest

import request_body_admission


def _budget(metadata_key: str) -> request_body_admission.RequestBodyAdmissionBudget:
    return request_body_admission.RequestBodyAdmissionBudget(
        metadata_key=metadata_key,
        negative_size_message="body size cannot be negative",
        already_attached_message="admission is already attached",
    )


@pytest.mark.parametrize(
    ("max_admitted_count", "max_admitted_body_bytes", "error_type"),
    [
        (0, 3, request_body_admission.RequestBodyAdmissionCountSaturatedError),
        (1, 3, request_body_admission.RequestBodyAdmissionByteSaturatedError),
    ],
    ids=["count", "body-bytes"],
)
def test_reserve_rejects_saturation_without_mutating_state(
    max_admitted_count: int,
    max_admitted_body_bytes: int,
    error_type: type[Exception],
) -> None:
    budget = _budget("admission")

    with pytest.raises(error_type):
        budget.reserve(
            4,
            max_admitted_count=max_admitted_count,
            max_admitted_body_bytes=max_admitted_body_bytes,
        )

    assert budget.state_for_tests() == (0, 0)


def test_negative_sizes_do_not_mutate_state() -> None:
    budget = _budget("admission")

    with pytest.raises(ValueError, match="body size cannot be negative"):
        budget.reserve(
            -1,
            max_admitted_count=1,
            max_admitted_body_bytes=4,
        )
    assert budget.state_for_tests() == (0, 0)

    lease = budget.reserve(
        1,
        max_admitted_count=1,
        max_admitted_body_bytes=4,
    )
    with pytest.raises(ValueError, match="body size cannot be negative"):
        budget.resize(
            lease,
            -1,
            max_admitted_body_bytes=4,
            already_released_message="admission is already released",
        )
    assert budget.state_for_tests() == (1, 1)

    budget.release(lease)


def test_budgets_keep_independent_capacity() -> None:
    first = _budget("first_admission")
    second = _budget("second_admission")
    first_lease = first.reserve(
        4,
        max_admitted_count=1,
        max_admitted_body_bytes=4,
    )

    with pytest.raises(request_body_admission.RequestBodyAdmissionCountSaturatedError):
        first.reserve(
            0,
            max_admitted_count=1,
            max_admitted_body_bytes=4,
        )

    second_lease = second.reserve(
        4,
        max_admitted_count=1,
        max_admitted_body_bytes=4,
    )
    assert first.state_for_tests() == (1, 4)
    assert second.state_for_tests() == (1, 4)

    first.release(first_lease)
    second.release(second_lease)


def test_scoped_counts_share_byte_capacity_and_preserve_resize_accounting() -> None:
    budget = _budget("admission")
    first = budget.reserve(2, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="first")
    second = budget.reserve(
        2, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="second"
    )
    with pytest.raises(request_body_admission.RequestBodyAdmissionCountSaturatedError):
        budget.reserve(0, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="first")
    with pytest.raises(request_body_admission.RequestBodyAdmissionByteSaturatedError):
        budget.reserve(1, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="third")
    assert budget.state_for_tests() == (2, 4)

    budget.resize(first, 1, max_admitted_body_bytes=4, already_released_message="already released")
    third = budget.reserve(1, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="third")
    assert budget.state_for_tests() == (3, 4)
    budget.release(first)
    budget.release(first)
    replacement = budget.reserve(
        1, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="first"
    )
    with pytest.raises(request_body_admission.RequestBodyAdmissionCountSaturatedError):
        budget.reserve(0, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="second")
    for lease in (replacement, second, third):
        budget.release(lease)
    assert budget.state_for_tests() == (0, 0)


def test_flow_release_uses_the_lease_scope_after_connection_changes(real_flow) -> None:
    budget = _budget("admission")
    flow = real_flow(with_response=False, client_ip="10.200.0.5")
    lease = budget.reserve(
        2, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="10.200.0.5"
    )
    other = budget.reserve(
        2, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="10.200.0.6"
    )
    budget.attach_to_flow(flow, lease)
    flow.client_conn.peername = ("10.200.0.6", 12345)
    budget.release_from_flow(flow)
    budget.release_from_flow(flow)
    replacement = budget.reserve(
        2, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="10.200.0.5"
    )
    with pytest.raises(request_body_admission.RequestBodyAdmissionCountSaturatedError):
        budget.reserve(0, max_admitted_count=1, max_admitted_body_bytes=4, count_scope="10.200.0.6")
    budget.release(replacement)
    budget.release(other)
    assert budget.state_for_tests() == (0, 0)


def test_resize_and_duplicate_release_preserve_accounting() -> None:
    budget = _budget("admission")
    lease = budget.reserve(
        2,
        max_admitted_count=1,
        max_admitted_body_bytes=4,
    )

    budget.resize(
        lease,
        4,
        max_admitted_body_bytes=4,
        already_released_message="admission is already released",
    )
    assert budget.state_for_tests() == (1, 4)

    with pytest.raises(request_body_admission.RequestBodyAdmissionByteSaturatedError):
        budget.resize(
            lease,
            5,
            max_admitted_body_bytes=4,
            already_released_message="admission is already released",
        )
    assert budget.state_for_tests() == (1, 4)

    budget.resize(
        lease,
        1,
        max_admitted_body_bytes=4,
        already_released_message="admission is already released",
    )
    assert budget.state_for_tests() == (1, 1)

    budget.release(lease)
    budget.release(lease)
    assert budget.state_for_tests() == (0, 0)

    with pytest.raises(RuntimeError, match="already released"):
        budget.resize(
            lease,
            0,
            max_admitted_body_bytes=4,
            already_released_message="admission is already released",
        )


def test_flow_attachment_transfers_and_releases_once(real_flow) -> None:
    budget = _budget("admission")
    flow = real_flow(with_response=False)
    first = budget.reserve(
        2,
        max_admitted_count=2,
        max_admitted_body_bytes=4,
    )
    second = budget.reserve(
        2,
        max_admitted_count=2,
        max_admitted_body_bytes=4,
    )

    budget.attach_to_flow(flow, first)
    with pytest.raises(RuntimeError, match="already attached"):
        budget.attach_to_flow(flow, second)
    assert budget.state_for_tests() == (2, 4)

    assert budget.take_from_flow(flow) is first
    assert budget.take_from_flow(flow) is None
    budget.release(first)

    budget.attach_to_flow(flow, second)
    budget.release_from_flow(flow)
    budget.release_from_flow(flow)
    assert budget.state_for_tests() == (0, 0)


def test_budget_rejects_lease_from_another_instance(real_flow) -> None:
    first = _budget("first_admission")
    second = _budget("second_admission")
    flow = real_flow(with_response=False)
    lease = first.reserve(
        4,
        max_admitted_count=1,
        max_admitted_body_bytes=4,
    )

    with pytest.raises(RuntimeError, match="another budget"):
        second.attach_to_flow(flow, lease)
    with pytest.raises(RuntimeError, match="another budget"):
        second.resize(
            lease,
            1,
            max_admitted_body_bytes=4,
            already_released_message="admission is already released",
        )
    with pytest.raises(RuntimeError, match="another budget"):
        second.release(lease)

    flow.metadata["second_admission"] = lease
    with pytest.raises(RuntimeError, match="another budget"):
        second.take_from_flow(flow)
    assert flow.metadata["second_admission"] is lease
    assert first.state_for_tests() == (1, 4)
    assert second.state_for_tests() == (0, 0)

    flow.metadata.pop("second_admission")
    first.release(lease)


def test_reset_clears_budget_state() -> None:
    budget = _budget("admission")
    budget.reserve(
        4,
        max_admitted_count=1,
        max_admitted_body_bytes=4,
    )

    budget.reset_for_tests()

    assert budget.state_for_tests() == (0, 0)
