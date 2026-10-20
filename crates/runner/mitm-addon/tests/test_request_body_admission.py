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


def test_require_flow_admission_validates_owner_capacity_and_liveness(real_flow) -> None:
    budget = _budget("admission")
    other_budget = _budget("other_admission")
    flow = real_flow(with_response=False)
    with pytest.raises(RuntimeError, match="admission is missing"):
        budget.require_from_flow(flow, 0)
    flow.metadata["admission"] = object()
    with pytest.raises(TypeError, match="admission has an invalid type"):
        budget.require_from_flow(flow, 0)
    del flow.metadata["admission"]

    lease = budget.reserve(4, max_admitted_count=1, max_admitted_body_bytes=4)
    budget.attach_to_flow(flow, lease)
    budget.require_from_flow(flow, 4)
    budget.require_from_flow(flow, 0)
    assert budget.state_for_tests() == (1, 4)
    with pytest.raises(RuntimeError, match="exceeds its admission"):
        budget.require_from_flow(flow, 5)
    with pytest.raises(ValueError, match="body size cannot be negative"):
        budget.require_from_flow(flow, -1)

    flow.metadata["other_admission"] = lease
    with pytest.raises(RuntimeError, match="belongs to another budget"):
        other_budget.require_from_flow(flow, 4)
    assert other_budget.state_for_tests() == (0, 0)

    budget.release(lease)
    with pytest.raises(RuntimeError, match="admission is already released"):
        budget.require_from_flow(flow, 0)
    assert budget.take_from_flow(flow) is lease
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
