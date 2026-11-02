use super::*;

#[test]
fn process_state_publish_updates_atomic_and_watch_together() {
    let state = AtomicU8::new(SandboxState::Created as u8);
    let state_publish_lock = Mutex::new(());
    let (state_tx, state_rx) = watch::channel(SandboxState::Created);

    publish_process_state(
        &state,
        &state_publish_lock,
        &state_tx,
        SandboxState::Stopped,
    );

    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Stopped
    );
    assert_eq!(*state_rx.borrow(), SandboxState::Stopped);
}

#[test]
fn failed_process_state_transition_does_not_regress_watch_state() {
    let state = AtomicU8::new(SandboxState::Stopped as u8);
    let state_publish_lock = Mutex::new(());
    let (state_tx, state_rx) = watch::channel(SandboxState::Stopped);

    assert!(!transition_process_state(
        &state,
        &state_publish_lock,
        &state_tx,
        SandboxState::Created,
        SandboxState::Running,
    ));

    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Stopped
    );
    assert_eq!(*state_rx.borrow(), SandboxState::Stopped);
}
