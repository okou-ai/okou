use super::*;

fn reserve(tracker: &NormalOperationTracker) -> NormalOperationToken {
    tracker.reserve().expect("operation should reserve")
}

fn fence(tracker: &NormalOperationTracker) -> NormalOperationFence {
    tracker.try_fence().expect("tracker should fence")
}

#[test]
fn new_tracker_starts_idle() {
    let tracker = NormalOperationTracker::new();

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
}

#[test]
fn reserve_makes_tracker_busy() {
    let tracker = NormalOperationTracker::new();
    let _token = reserve(&tracker);

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Busy);
}

#[test]
fn drop_before_possible_guest_write_returns_to_idle() {
    let tracker = NormalOperationTracker::new();
    let token = reserve(&tracker);

    drop(token);

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
}

#[test]
fn complete_after_possible_guest_write_returns_to_idle() {
    let tracker = NormalOperationTracker::new();
    let mut token = reserve(&tracker);
    token
        .mark_possible_guest_write_started()
        .expect("mark write started");

    token.complete().expect("operation should complete");

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
}

#[test]
fn drop_after_possible_guest_write_is_not_parkable() {
    let tracker = NormalOperationTracker::new();
    let mut token = reserve(&tracker);
    token
        .mark_possible_guest_write_started()
        .expect("mark write started");

    drop(token);

    assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
    assert!(matches!(
        tracker.reserve(),
        Err(NormalOperationRejection::NotParkable)
    ));
}

#[test]
fn completed_guest_write_remains_busy_until_operation_complete() {
    let tracker = NormalOperationTracker::new();
    let mut token = reserve(&tracker);
    let handle = token.transition_handle();
    token
        .mark_possible_guest_write_started()
        .expect("mark write started");

    handle
        .mark_possible_guest_write_completed()
        .expect("mark write completed");

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Busy);
    token.complete().expect("operation should complete");
    assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
}

#[test]
fn completed_guest_write_can_start_another_guest_write() {
    let tracker = NormalOperationTracker::new();
    let mut token = reserve(&tracker);
    let handle = token.transition_handle();
    token
        .mark_possible_guest_write_started()
        .expect("mark first write started");
    handle
        .mark_possible_guest_write_completed()
        .expect("mark first write completed");

    token
        .mark_possible_guest_write_started()
        .expect("mark second write started");

    drop(token);
    assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
}

#[test]
fn close_after_guest_write_completed_is_closed_not_not_parkable() {
    let tracker = NormalOperationTracker::new();
    let mut token = reserve(&tracker);
    let handle = token.transition_handle();
    token
        .mark_possible_guest_write_started()
        .expect("mark write started");
    handle
        .mark_possible_guest_write_completed()
        .expect("mark write completed");

    tracker.mark_closed();

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
    drop(token);
    assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
}

#[test]
fn drop_after_guest_write_completed_without_complete_is_not_parkable() {
    let tracker = NormalOperationTracker::new();
    let mut token = reserve(&tracker);
    let handle = token.transition_handle();
    token
        .mark_possible_guest_write_started()
        .expect("mark write started");
    handle
        .mark_possible_guest_write_completed()
        .expect("mark write completed");

    drop(token);

    assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
}

#[test]
fn fence_succeeds_only_when_idle() {
    let tracker = NormalOperationTracker::new();
    let token = reserve(&tracker);

    assert!(matches!(
        tracker.try_fence(),
        Err(NormalOperationFenceRejection::Busy)
    ));

    drop(token);
    let _fence = fence(&tracker);

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Fenced);
}

#[test]
fn fence_rejects_normal_operation_reservation() {
    let tracker = NormalOperationTracker::new();
    let _fence = fence(&tracker);

    assert!(matches!(
        tracker.reserve(),
        Err(NormalOperationRejection::Fenced)
    ));
}

#[test]
fn reserved_operation_and_fence_are_acquired_atomically() {
    let tracker = NormalOperationTracker::new();

    let (token, fence) = tracker
        .try_reserve_and_fence()
        .expect("idle tracker should reserve and fence");

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Fenced);
    assert!(matches!(
        tracker.reserve(),
        Err(NormalOperationRejection::Fenced)
    ));
    token
        .complete()
        .expect("reserved operation should complete");
    assert_eq!(tracker.readiness(), NormalOperationReadiness::Fenced);

    drop(fence);
    assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
}

#[test]
fn reserved_operation_and_fence_reject_busy_tracker() {
    let tracker = NormalOperationTracker::new();
    let _token = reserve(&tracker);

    assert!(matches!(
        tracker.try_reserve_and_fence(),
        Err(NormalOperationFenceRejection::Busy)
    ));
}

#[test]
fn uncertain_reserved_and_fenced_write_remains_not_parkable() {
    let tracker = NormalOperationTracker::new();
    let (mut token, fence) = tracker
        .try_reserve_and_fence()
        .expect("idle tracker should reserve and fence");
    token
        .mark_possible_guest_write_started()
        .expect("mark write started");

    drop(token);
    drop(fence);

    assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
}

#[test]
fn second_fence_is_rejected_while_fenced() {
    let tracker = NormalOperationTracker::new();
    let _fence = fence(&tracker);

    assert!(matches!(
        tracker.try_fence(),
        Err(NormalOperationFenceRejection::AlreadyFenced)
    ));
}

#[test]
fn dropping_fence_reopens_tracker() {
    let tracker = NormalOperationTracker::new();
    let fence = fence(&tracker);

    drop(fence);

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Idle);
    assert!(tracker.reserve().is_ok());
}

#[test]
fn poison_while_fenced_does_not_reopen_on_fence_drop() {
    let tracker = NormalOperationTracker::new();
    let fence = fence(&tracker);

    tracker.mark_not_parkable();
    drop(fence);

    assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
    assert!(matches!(
        tracker.try_fence(),
        Err(NormalOperationFenceRejection::NotParkable)
    ));
}

#[test]
fn close_while_fenced_does_not_reopen_on_fence_drop() {
    let tracker = NormalOperationTracker::new();
    let fence = fence(&tracker);

    tracker.mark_closed();
    drop(fence);

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
    assert!(matches!(
        tracker.try_fence(),
        Err(NormalOperationFenceRejection::Closed)
    ));
}

#[test]
fn close_rejects_future_reservation_and_fencing() {
    let tracker = NormalOperationTracker::new();

    tracker.mark_closed();

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
    assert!(matches!(
        tracker.reserve(),
        Err(NormalOperationRejection::Closed)
    ));
    assert!(matches!(
        tracker.try_fence(),
        Err(NormalOperationFenceRejection::Closed)
    ));
}

#[test]
fn close_with_reserved_operation_is_closed() {
    let tracker = NormalOperationTracker::new();
    let token = reserve(&tracker);

    tracker.mark_closed();

    assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
    drop(token);
    assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
}

#[test]
fn close_with_possible_guest_write_is_not_parkable() {
    let tracker = NormalOperationTracker::new();
    let mut token = reserve(&tracker);
    token
        .mark_possible_guest_write_started()
        .expect("mark write started");

    tracker.mark_closed();

    assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
}

#[test]
fn close_with_mixed_reserved_and_possible_guest_write_is_not_parkable() {
    let tracker = NormalOperationTracker::new();
    let _reserved_token = reserve(&tracker);
    let mut write_token = reserve(&tracker);
    write_token
        .mark_possible_guest_write_started()
        .expect("mark write started");

    tracker.mark_closed();

    assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
}

#[test]
fn not_parkable_state_survives_later_close() {
    let tracker = NormalOperationTracker::new();

    tracker.mark_not_parkable();
    tracker.mark_closed();

    assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
}

#[test]
fn not_parkable_state_overrides_prior_close() {
    let tracker = NormalOperationTracker::new();

    tracker.mark_closed();
    tracker.mark_not_parkable();

    assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
}

#[test]
fn second_possible_guest_write_mark_is_invalid_transition() {
    let tracker = NormalOperationTracker::new();
    let mut token = reserve(&tracker);
    token
        .mark_possible_guest_write_started()
        .expect("mark write started");

    let err = token.mark_possible_guest_write_started().unwrap_err();

    assert!(matches!(
        err,
        NormalOperationTransitionError::InvalidTransition {
            from: OperationPhase::PossibleGuestWrite,
            to: OperationPhase::PossibleGuestWrite,
            ..
        }
    ));
    assert_eq!(tracker.readiness(), NormalOperationReadiness::Busy);
}

#[test]
fn complete_after_not_parkable_is_idempotent_and_preserves_state() {
    let tracker = NormalOperationTracker::new();
    let mut token = reserve(&tracker);
    token
        .mark_possible_guest_write_started()
        .expect("mark write started");

    tracker.mark_not_parkable();

    token
        .complete()
        .expect("operation completion should release token");
    assert_eq!(tracker.readiness(), NormalOperationReadiness::NotParkable);
}

#[test]
fn mark_possible_guest_write_after_close_returns_unknown_and_preserves_state() {
    let tracker = NormalOperationTracker::new();
    let mut token = reserve(&tracker);

    tracker.mark_closed();

    let err = token.mark_possible_guest_write_started().unwrap_err();
    assert!(matches!(
        err,
        NormalOperationTransitionError::UnknownOperation { .. }
    ));
    assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
}

#[test]
fn complete_after_close_returns_unknown_and_preserves_state() {
    let tracker = NormalOperationTracker::new();
    let token = reserve(&tracker);

    tracker.mark_closed();

    let err = token.complete().unwrap_err();
    assert!(matches!(
        err,
        NormalOperationTransitionError::UnknownOperation { .. }
    ));
    assert_eq!(tracker.readiness(), NormalOperationReadiness::Closed);
}
