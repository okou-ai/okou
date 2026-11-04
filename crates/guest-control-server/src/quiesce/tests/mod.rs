use super::*;

#[test]
fn acquire_counts_one_operation_until_last_guard_clone_drops() {
    let state = OperationState::default();
    let guard = state.acquire().unwrap();
    let clone = guard.clone();

    assert_eq!(state.pending(), 1);
    drop(guard);
    assert_eq!(state.pending(), 1);
    drop(clone);
    assert_eq!(state.pending(), 0);
}

#[test]
fn explicit_release_drops_pending_before_guard_clones_drop() {
    let state = OperationState::default();
    let guard = state.acquire().unwrap();
    let clone = guard.clone();

    guard.release();

    assert_eq!(state.pending(), 0);
    drop(guard);
    drop(clone);
    assert_eq!(state.pending(), 0);
}

#[test]
fn quiesce_fences_new_operations_even_when_busy() {
    let state = OperationState::default();
    let guard = state.acquire().unwrap();

    assert_eq!(state.enter_quiescing(), QuiesceResult::Busy { pending: 1 });
    assert!(matches!(
        state.acquire(),
        Err(AcquireOperationError::Quiescing)
    ));

    drop(guard);
    assert_eq!(state.pending(), 0);
}

#[test]
fn fully_quiesced_requires_fenced_admission_and_zero_pending_operations() {
    let state = OperationState::default();
    assert!(!state.is_quiesced());

    let guard = state.acquire().unwrap();
    assert_eq!(state.enter_quiescing(), QuiesceResult::Busy { pending: 1 });
    assert!(!state.is_quiesced());

    drop(guard);
    assert!(state.is_quiesced());

    state.resume();
    assert!(!state.is_quiesced());
}

#[test]
fn resume_allows_operations_after_quiesce() {
    let state = OperationState::default();

    assert_eq!(state.enter_quiescing(), QuiesceResult::Quiesced);
    assert!(matches!(
        state.acquire(),
        Err(AcquireOperationError::Quiescing)
    ));
    state.resume();

    let guard = state.acquire().unwrap();
    assert_eq!(state.pending(), 1);
    drop(guard);
}
